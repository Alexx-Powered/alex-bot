"""Pass verified group events and delivery receipts to the local business service."""
import asyncio
from contextlib import suppress
import os
from pathlib import Path
import time

import nonebot
from aiohttp import WSMsgType, web
from nonebot.adapters.milky import Adapter, Bot, MessageSegment
from nonebot.adapters.milky.event import BotOfflineEvent, GroupMessageEvent
from nonebot.adapters.milky.exception import ActionFailed
from nonebot.drivers import Timeout


class GroupAdapter(Adapter):
    def websocket(self, setup):
        # Group events can be silent for hours. A quiet socket is still valid.
        setup.timeout = Timeout(read=None, close=10)
        return super().websocket(setup)

    async def request(self, setup):
        if setup.url.path.endswith("/send_group_message"):
            setup.timeout = 210
        return await super().request(setup)


class GroupChannel:
    def __init__(self):
        self.bot = self.ws = None
        self.last_bot = self.offline_session = None
        self.last_offline = None
        self.groups = {}
        self.peers = set()
        self.verification = None
        self.changed = asyncio.Event()
        self.resource_slots = asyncio.Semaphore(2)

    def clear_subscription(self):
        self.peers.clear()
        self.verification = None

    async def set_bot(self, bot):
        self.bot = bot
        if bot is not None:
            self.last_bot = bot
        self.groups = {}
        self.clear_subscription()
        if self.ws is not None and not self.ws.closed:
            await self.ws.send_json({"type": "offline"})
        self.changed.set()

    async def account_offline(self, bot: Bot, event: BotOfflineEvent):
        if bot is not self.last_bot or str(event.self_id) != bot.self_id or self.offline_session is bot:
            return
        if not time.time() - 900 <= event.time <= time.time() + 5:
            return
        self.offline_session = bot
        self.last_offline = {"type": "account_offline", "account": bot.self_id, "at": event.time * 1000}
        await self.replay_offline()

    async def replay_offline(self):
        frame, ws = self.last_offline, self.ws
        if frame and frame["at"] >= (time.time() - 900) * 1000 and ws and ws.prepared and not ws.closed:
            with suppress(ConnectionError, RuntimeError):
                await ws.send_json(frame)

    async def roster(self, ws):
        while not ws.closed:
            self.changed.clear()
            bot = self.bot
            if bot is not None:
                try:
                    rows = await asyncio.wait_for(bot.get_group_list(no_cache=True), 8)
                    if self.bot is bot:
                        self.groups = {str(row.group_id): row.group_name[:80] for row in rows}
                        await ws.send_json({"type": "roster", "account": bot.self_id,
                                            "groups": [{"number": k, "name": v} for k, v in self.groups.items()]})
                except Exception:
                    if ws.closed:
                        return
                    if self.bot is bot:
                        self.groups.clear()
                        await ws.send_json({"type": "roster_error"})
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.changed.wait(), 30)

    async def events(self, request):
        if self.ws is not None and not self.ws.closed:
            raise web.HTTPConflict()
        ws = web.WebSocketResponse(max_msg_size=8*1024*1024, heartbeat=15, compress=False)
        self.ws = ws
        poll = None
        deliveries = set()

        async def reply(data):
            receipt = await self.deliver(data)
            if not ws.closed:
                with suppress(ConnectionError, RuntimeError):
                    await ws.send_json(receipt)

        try:
            await ws.prepare(request)
            await self.replay_offline()
            poll = asyncio.create_task(self.roster(ws))
            async for packet in ws:
                if packet.type != WSMsgType.TEXT:
                    break
                data = packet.json()
                if data.get("type") == "subscriptions":
                    if self.bot and data.get("account") == self.bot.self_id:
                        self.peers = set(data["peers"]).intersection(self.groups)
                        self.verification = data.get("verification")
                        if self.verification and self.verification.get("probe"):
                            await ws.send_json({"type": "probe_ready", "account": self.bot.self_id,
                                                "command": self.verification["command"]})
                elif data.get("type") == "refresh":
                    self.changed.set()
                elif data.get("type") == "deliver":
                    if len(deliveries) >= 4:
                        await ws.send_json({"type": "receipt", "request": data.get("request"), "outcome": "cancelled"})
                        continue
                    task = asyncio.create_task(reply(data))
                    deliveries.add(task)
                    task.add_done_callback(deliveries.discard)
                else:
                    break
        finally:
            self.clear_subscription()
            self.ws = None
            for task in deliveries:
                task.cancel()
            await asyncio.gather(*deliveries, return_exceptions=True)
            if poll is not None:
                poll.cancel()
                with suppress(asyncio.CancelledError, ConnectionError):
                    await poll
            await ws.close()
        return ws

    async def deliver(self, data):
        bot, peer = self.bot, data.get("peer")
        ack = {"type": "receipt", "request": data.get("request"), "outcome": "cancelled"}
        if not bot or bot.self_id != data.get("account") or peer not in self.peers or peer not in self.groups:
            return ack
        if data.get("deadline") is not None and time.time()*1000 >= data["deadline"]:
            return ack
        segments = []
        for item in data["parts"]:
            if item["type"] == "text":
                segments.append(MessageSegment.text(item["text"]))
            elif item["type"] == "image":
                segments.append(MessageSegment.image(base64=item["base64"]))
            elif item["type"] == "video":
                segments.append(MessageSegment.video(base64=item["base64"]))
            else:
                return ack
        try:
            result = await asyncio.wait_for(bot.send_group_message(group_id=int(peer), message=segments), 215)
            return dict(ack, outcome="accepted", seq=str(result.message_seq))
        except ActionFailed as failure:
            code = failure.info.get("retcode")
            return dict(ack, outcome="rejected", retcode=code if type(code) is int else None)
        except Exception:
            return dict(ack, outcome="unknown")

    async def incoming(self, bot: Bot, event: GroupMessageEvent):
        peer = str(event.data.peer_id)
        ws = self.ws
        if self.bot is not bot or str(event.self_id) != bot.self_id or event.data.sender_id == event.self_id:
            return
        if self.offline_session is bot and event.time * 1000 > self.last_offline["at"]:
            self.offline_session = None
        if ws is None or ws.closed or peer not in self.groups:
            return
        segments = event.data.segments
        text = "".join(s["data"].get("text", "") for s in segments if s["type"] == "text").strip()
        verification = self.verification
        verifying = verification and verification["peer"] in ("", peer) and verification["command"] == text
        if not verifying and peer not in self.peers:
            return
        mentioned = any(s["type"] == "mention" and str(s["data"].get("user_id")) == bot.self_id for s in segments)
        media = []
        for seg in segments:
            kind = {"record": "audio", "image": "image"}.get(seg["type"])
            if not kind or len(media) >= 4 or verifying:
                continue
            resource = seg["data"].get("resource_id")
            if resource:
                try:
                    url = await asyncio.wait_for(self.resource_url(bot, resource), 3)
                    media.append({"kind": kind, "url": url, "animated": seg["data"].get("sub_type") == "sticker"})
                except Exception:
                    pass
        if not text and media:
            text = "[语音]" if any(m["kind"] == "audio" for m in media) else "[图片]"
        if not text or len(text)>4000 or self.ws is not ws or ws.closed or self.bot is not bot:
            return
        if not verifying and peer not in self.peers:
            return
        await ws.send_json({"type": "message", "account": bot.self_id, "peer": peer,
                            "sender": str(event.data.sender_id), "seq": str(event.data.message_seq),
                            "at": event.data.time*1000, "text": text, "mentioned": mentioned, "media": media})

    async def resource_url(self, bot, resource):
        async with self.resource_slots:
            return await bot.get_resource_temp_url(resource_id=resource)


def main():
    runtime = Path(os.environ["RUNTIME_DIRECTORY"])
    token = (Path(os.environ["CREDENTIALS_DIRECTORY"]) / "milky.token").read_text().strip()
    nonebot.init(driver="~aiohttp", log_level="CRITICAL", milky_clients=[
        {"host": "127.0.0.1", "port": 19437, "access_token": token}
    ])
    driver = nonebot.get_driver()
    driver.register_adapter(GroupAdapter)
    channel = GroupChannel()
    matcher = nonebot.on_message(block=False)
    matcher.handle()(channel.incoming)
    # Milky 1.3.0 calls this event type "meta".
    nonebot.on("meta", block=False).handle()(channel.account_offline)
    app = web.Application()
    app.router.add_get("/groups", channel.events)
    runner = web.AppRunner(app, access_log=None)

    def state(value):
        path = runtime / "status.tmp"
        path.write_text(value + "\n")
        path.replace(runtime / "status")

    @driver.on_startup
    async def startup():
        await runner.setup()
        path = runtime / "groups.sock"
        await web.UnixSite(runner, str(path)).start()
        path.chmod(0o660)

    @driver.on_shutdown
    async def shutdown():
        if channel.ws is not None:
            await channel.ws.close()
        await runner.cleanup()

    @driver.on_bot_connect
    async def connected(bot: Bot):
        await channel.set_bot(bot)
        state("connected")

    @driver.on_bot_disconnect
    async def disconnected(bot: Bot):
        if channel.bot is bot:
            await channel.set_bot(None)
            state("awaiting_gateway")

    state("awaiting_gateway")
    nonebot.run()


if __name__ == "__main__":
    main()
