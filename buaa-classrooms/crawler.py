"""学院路空教室查询：用户手动登录，程序只读取教室接口。"""
from __future__ import annotations

import argparse
import csv
import json
import time
from datetime import date as Date, datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent
PAGE = "https://app.buaa.edu.cn/site/classRoomQuery/index"
CAMPUS = "学院路校区"
INDEX_SUFFIX = "/buaafreeclass/wap/default/index1"


class QueryError(RuntimeError):
    pass


def normalize(payload: dict, day: str) -> list[dict]:
    """仅保留教室字段；空闲节次为空时仍保留教室记录。"""
    if not isinstance(payload, dict) or payload.get("e") != 0:
        raise QueryError("查询失败或登录态失效，请在可见窗口重新登录。")
    data = payload.get("d")
    if not isinstance(data, dict) or "list" not in data:
        raise QueryError("接口结构变化：缺少 d.list。")
    groups = data["list"]
    if groups == []:
        return []
    if not isinstance(groups, dict):
        raise QueryError("接口结构变化：d.list 应为教学楼映射。")
    rows = []
    for building, rooms in groups.items():
        if isinstance(rooms, dict):
            rooms = rooms.values()
        elif not isinstance(rooms, list):
            raise QueryError("接口结构变化：教室列表类型不符。")
        for room in rooms:
            if not isinstance(room, dict) or not {"name", "kxsds"} <= room.keys():
                raise QueryError("接口结构变化：教室缺少 name/kxsds。")
            try:
                free = sorted({int(p) for p in str(room["kxsds"] or "").split(",") if p.strip()})
            except ValueError:
                raise QueryError("接口返回了无法识别的节次。") from None
            if any(p < 1 or p > 14 for p in free):
                raise QueryError("节次超出当前已验证的 1–14 范围。")
            rows.append({"date": day, "campus": CAMPUS, "building": building,
                         "room": room["name"], "free_periods": free})
    return rows


def crawl(day: str, *, headless: bool = False, login_timeout: int = 300) -> dict:
    """返回学院路所有教学楼的教室及空闲节次，不返回任何认证信息。"""
    Date.fromisoformat(day)
    from playwright.sync_api import sync_playwright

    initial = {}

    def capture(response):
        # 不记录登录请求、请求头、Cookie、URL 查询参数或其他接口响应。
        parsed = urlsplit(response.url)
        if parsed.hostname != "app.buaa.edu.cn" or not parsed.path.endswith(INDEX_SUFFIX):
            return
        try:
            body = response.json()
            if body.get("e") == 0 and isinstance(body.get("d", {}).get("xqs"), list):
                initial.update(payload=body, endpoint=urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", "")))
        except (ValueError, AttributeError):
            pass

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(ROOT / ".private-profile"), headless=headless,
            channel="msedge", accept_downloads=False,
        )
        try:
            page = context.new_page()
            page.on("response", capture)
            page.goto(PAGE, wait_until="domcontentloaded", timeout=60000)
            if not headless:
                print("如出现认证页，请在浏览器手动登录；无需在终端输入账号密码。")
            deadline = time.monotonic() + (30 if headless else login_timeout)
            while not initial and time.monotonic() < deadline:
                if page.is_closed():
                    raise QueryError("浏览器已关闭。")
                page.wait_for_timeout(250)
            if not initial:
                raise QueryError("未收到教室初始化数据。请去掉 --headless 手动登录，或检查网络。")
            candidates = [c for c in initial["payload"]["d"]["xqs"] if c.get("name") == CAMPUS]
            if len(candidates) != 1 or "xqid" not in candidates[0]:
                raise QueryError("初始化数据中无法唯一确定学院路校区，已停止。")
            endpoint = initial["endpoint"].removesuffix("index1") + "search1"
            # context.request 自动复用当前本地会话，不导出 Cookie。
            response = context.request.get(
                endpoint, params={"xqid": candidates[0]["xqid"], "floorid": "", "date": day},
                headers={"Referer": PAGE, "X-Requested-With": "XMLHttpRequest"},
                timeout=30000, max_redirects=0,
            )
            try:
                if not response.ok:
                    raise QueryError(f"教室接口返回 HTTP {response.status}。")
                try:
                    payload = response.json()
                except ValueError:
                    raise QueryError("教室接口未返回 JSON，可能需要重新登录。") from None
                rows = normalize(payload, day)
            finally:
                response.dispose()
            return {"source": PAGE, "campus": CAMPUS, "date": day,
                    "fetched_at": datetime.now(timezone(timedelta(hours=8))).isoformat(),
                    "semantics": "原样保留系统空闲标记；未标记不等同于占用，系统称不显示已过时段。",
                    "rooms": rows}
        finally:
            context.close()


def save(result: dict, target: Path):
    target.mkdir(parents=True, exist_ok=True)
    stem = f"xueyuanlu-{result['date']}"
    path = target / f"{stem}.json"
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)
    with (target / f"{stem}.csv").open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["date", "campus", "building", "room", "free_periods"])
        writer.writeheader()
        for row in result["rooms"]:
            writer.writerow({**row, "free_periods": ",".join(map(str, row["free_periods"]))})
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", default=datetime.now(timezone(timedelta(hours=8))).date().isoformat())
    parser.add_argument("--headless", action="store_true", help="复用会话；失效后报错，不自动登录")
    parser.add_argument("--login-timeout", type=int, default=300)
    parser.add_argument("--output", type=Path, default=ROOT / "output")
    args = parser.parse_args()
    try:
        result = crawl(args.date, headless=args.headless, login_timeout=args.login_timeout)
        path = save(result, args.output)
        print(f"成功：{len(result['rooms'])} 间教室；已保存到 {path}")
    except (QueryError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    except Exception:
        parser.exit(1, "浏览器或网络错误。请检查 Edge/Playwright 安装、网络，以及是否有另一进程占用本程序会话。\n")


if __name__ == "__main__":
    main()
