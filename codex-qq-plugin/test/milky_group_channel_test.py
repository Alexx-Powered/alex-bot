"""Run in the NoneBot environment. The gateway and all group identities are synthetic."""
import asyncio
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

import nonebot
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from nonebot.adapters.milky import Adapter, Bot
from nonebot.adapters.milky.config import ClientInfo
from nonebot.drivers import Response

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from milky_group_channel import GroupChannel


class GroupSocketTest(unittest.IsolatedAsyncioTestCase):
    async def test_subscription_dispatch_and_receipts(self):
        nonebot.init(driver="~aiohttp", log_level="CRITICAL")
        driver = nonebot.get_driver()
        driver.register_adapter(Adapter)
        adapter = driver._adapters["Milky"]
        bot = Bot(adapter, "70001", ClientInfo(host="127.0.0.1", port=1))
        channel = GroupChannel()
        nonebot.on_message(block=False).handle()(channel.incoming)
        app = web.Application()
        app.router.add_get("/groups", channel.events)
        timestamp = int(time.time())
        sequence = 9007199254740993
        calls = []

        async def request(req):
            api = str(req.url).split("/")[-1]
            if api == "get_group_list":
                data = {"groups": [{"group_id": 80001, "group_name": "测试群",
                                    "member_count": 3, "max_member_count": 20}]}
            elif api == "send_group_message":
                calls.append(json.loads(req.content))
                data = {"message_seq": sequence + 1, "time": timestamp}
            else:
                self.fail(api)
            return Response(200, content=json.dumps({"status": "ok", "retcode": 0, "data": data}).encode())

        with patch.object(adapter, "request", new=request):
            await channel.set_bot(bot)
            async with TestClient(TestServer(app)) as client:
                async with client.ws_connect("/groups") as ws:
                    group = {"number": "80001", "name": "测试群"}
                    self.assertEqual((await ws.receive_json(timeout=2))["groups"], [group])
                    await ws.send_json({"type": "refresh"})
                    self.assertEqual((await ws.receive_json(timeout=2))["groups"], [group])
                    await ws.send_json({"type": "subscriptions", "account": "70001", "peers": [],
                                        "verification": {"peer": "", "command": "群连接核验 test", "probe": True}})
                    armed = await ws.receive_json(timeout=2)
                    self.assertEqual((armed["type"], armed["account"]), ("probe_ready","70001"))
                    await ws.send_json({"type": "subscriptions", "account": "70001", "peers": ["80001"]})
                    payload = {"type": "deliver", "request": "fixture", "account": "70001", "peer": "80001",
                               "parts": [{"type": "text", "text": "天气"}, {"type": "image", "base64": "AQID"}]}
                    await ws.send_json(payload)
                    self.assertEqual((await ws.receive_json(timeout=2))["seq"], str(sequence + 1))
                    self.assertEqual(calls[0]["group_id"], 80001)
                    self.assertEqual(calls[0]["message"][1]["data"]["uri"], "base64://AQID")
                    await ws.send_json(dict(payload, peer="80002"))
                    self.assertEqual((await ws.receive_json(timeout=2))["outcome"], "cancelled")
                    self.assertEqual(len(calls), 1)
                    incoming = {"time": timestamp, "message_seq": sequence, "sender_id": 80002, "peer_id": 80001,
                                "message_scene": "group", "segments": [{"type": "mention", "data": {"user_id": 70001}},
                                {"type": "text", "data": {"text": "/ping"}}]}
                    sample = Adapter.json_to_event({"time": timestamp, "self_id": 70001,
                                                    "event_type": "message_receive", "data": incoming})
                    await asyncio.wait_for(bot.handle_event(sample), 3)
                    frame = await ws.receive_json(timeout=2)
                    self.assertEqual((frame["seq"], frame["text"], frame["mentioned"]), (str(sequence), "/ping", True))


if __name__ == "__main__":
    unittest.main()
