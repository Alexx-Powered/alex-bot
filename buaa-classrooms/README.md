# 学院路空教室查询

此目录保留最初的独立原型。当前QQ Bot集成入口在`../codex-qq-plugin/python/campus_classrooms.py`：由本机配置页单独加密保存校园凭据，查询返回固定JSON，直接生成三号楼简报图片发本人。集成说明见上级HANDOVER第10节。本原型的手动登录方式仍可独立使用。

你手动登录学校网页，Python 使用专用本地 Edge 会话查询；不在代码、命令行或聊天里提供学号密码。程序只输出日期、校区、教学楼、教室和空闲节次。

## 使用

在本目录运行：

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python crawler.py --date 2026-10-29
```

程序打开独立 Edge 窗口，在窗口中自行完成学校认证，程序等待最多 5 分钟。已安装 Microsoft Edge 时无需下载 Chromium。当前 Codex 内置浏览器的会话不能直接转给这个 Python 程序，所以首次需在新窗口登录一次。

之后可运行：

```powershell
.\.venv\Scripts\python crawler.py --headless
```

结果保存在 `output/xueyuanlu-日期.json` 和 CSV。`rooms` 包含接口返回的全部教室，包括空闲节次为空的教室；筛选 `free_periods` 非空得到有空闲标记的教室。`floorid` 为空表示全部教学楼；校区 ID 从初始化响应中按“学院路校区”查找，不硬编码 ID。

`.private-profile` 是本机认证材料，具有登录权限，勿分享、上传或提交到版本库。程序不导出 Cookie、不抓取登录请求、不保存 HAR、不截取登录画面；没有账号密码配置项。关闭浏览器后可删除该目录以清除程序保存的会话。登录态由学校决定有效期；失效后可见模式重新登录。不要并发使用同一 profile。

## 数据范围与验证状态

2026-10-29 已通过用户手动登录的 Codex 浏览器读取学院路页面 DOM，共 158 间：三号楼 45 间、主楼 69 间、新主楼 44 间，包含 1–14 节的原始空闲标记。页面提取结果见 `observed-2026-10-29.json`，已转换为 `output` 中的 JSON/CSV。已检查房间标识无重复、节次范围合法，以及解析器对错误响应、结构变化和空闲节次为空的处理。

公开前端确认使用 `GET /buaafreeclass/wap/default/index1`、`search1`，参数为 `xqid/floorid/date`，接口空闲字段为 `kxsds`。程序从真实初始化响应获取接口前缀，以兼容部署路径。

Python 独立浏览器的认证与接口全流程尚未实测；当前验证的是已登录页面数据提取和公开前端协议。若接口还要求额外校验，应根据实际响应调整，不能把返回 HTML 当作空列表。

系统提示“当前时间以前的空教室不显示”。采集保留原始标记；没有标记不等于占用，也不能由此保证现场开放、可进入或可预约。日期相同的重复运行覆盖该日期的快照。建议按需查询或用系统计划任务每 30 分钟运行一次，不需要高频轮询。

## 后续接入 LangChain

核心函数为 `crawl(day, headless=True)`，返回普通字典，认证信息不进入返回值。建议让采集程序定期更新 JSON，LangChain tool 只读取本地 JSON 并校验日期和 `fetched_at`，避免模型持有登录材料。尚未安装或固化 LangChain tool。

Playwright 会话与请求共享 Cookie 的说明：<https://playwright.dev/python/docs/api/class-apirequestcontext>。
