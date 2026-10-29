# 亚历克斯 QQ Bot 开发交接

更新日期：2026-10-29。运行工作区：`D:\Projects\Alex Bot`。本文描述本机当前代码与已核对状态，不代表云端部署或未来平台权限承诺。

本轮维护已完成并发安全控制、MCP测试端口隔离和WorkBuddy陈旧测试修正；源码已建立工作区根目录Git管理。维护证据见 `codex-qq-plugin/deploy/maintenance-20261029.json`。GitHub交付信息见文末，原始只读交接与较早验收作为历史保留。

## 1. 接手先看这里

亚历克斯是通过腾讯官方 QQ Bot API 运行的独立机器人。日常 QQ 客户端不需要注入、替换或第三方协议登录。Node.js 服务负责接收消息、授权和发送；Python LangChain 负责自然语言工具选择及新增业务规则。**正常聊天、查询和早安任务不依赖 Codex 开着**；Codex 仅在自己的任务需要通知时调用本地 MCP。

四条入口共用同一个 QQ 发送核心：

1. QQ 本人私聊／白名单群：固定命令或自然语言 → 查询／聊天 → QQ。
2. 独立早安调度脚本：北京时间08:00，晚启动补发 → 本人。
3. Codex MCP：已授权通知或手动测试 → 本人；显式授权的广播可到当前白名单。
4. WorkBuddy 自习 skill：截图分析与核对 → Python 绘图 → 本地图片接口 → 本人。

接手顺序：读本目录 `AGENTS.md` → 本文 → 对应模块 → 测试与部署记录。`codex-qq-plugin/README.md` 包含大量历史记录，旧额度、旧路由说明不能直接当成当前配置。

### 本轮维护后的运行状态

| 项目 | 状态 |
|---|---|
| QQ 服务版本 | 0.2.1（本轮维护用Git提交定位，不修改各业务发布版本） |
| QQ 连接与配对 | connected、已配对本人、未暂停 |
| 群 | 1个白名单；已配置群备注“万通荆古帖v2.0”，实际按 groupOpenid 授权 |
| QQ 额度 | 15次/滚动分钟、300次/北京时间自然日，预留10次主动通知；普通回复上限290 |
| 增强早安 | `config/morning-report.json` enabled=true |
| Windows 任务 | `AlexQQ-Morning-Service`，本次查询为 Running |
| 聊天 | `chat-policy.md` 启用，安全输出上限600字符 |
| WorkBuddy skill | 2.3.1；标识仍为 `building3-study-planner-v2-1` |
| 云端 | 未部署；电脑关机、休眠或断网不保证服务与投递 |

本轮维护运行了完整离线测试，并重启本地桥接服务加载修复；没有发送真实QQ测试消息或调用在线大模型。重启前后均connected、已配对、未暂停、1个白名单群，当天发送计数均为39、无不确定投递；没有重置计数、配对或幂等记录。原早安计划任务核对为Running。上述状态是时点快照，API返回`SENT`仅表示接口接受，不等于用户已阅读。

## 2. 总体架构与流程

```mermaid
flowchart TD
  QQ[QQ 官方事件] --> SDK[qq-adapter.mjs]
  SDK --> CORE[core.mjs：本人和群授权、前缀、暂停、预算]
  CORE --> FIX[固定命令路由]
  CORE --> CHAT[conversation-agent.mjs]
  CHAT --> PIPE[python-agent.mjs：子进程与 JSON 行协议]
  PIPE --> LC[agent_worker.py：LangChain agent]
  LC --> MODEL[DeepSeek：理解意图与选择工具]
  LC --> PY[Python 固定业务工具]
  LC --> RPC[受限工具 RPC]
  RPC --> WEATHER[Node 天气、雷达、CAMS 与绘图]
  FIX --> WEATHER
  PY --> CORE
  WEATHER --> CORE
  LC --> CORE
  CORE --> SEND[qq-adapter.mjs：官方上传与发送]
  SEND --> QQOUT[本人或已授权群]
  TIMER[Windows 早安调度] --> HTTP[127.0.0.1:19327 本地接口]
  MCP[Codex MCP] --> HTTP
  WB[WorkBuddy 固定脚本] --> HTTP
  HTTP --> CORE
```

模型不能直接发送 QQ、选择任意收件人、执行 shell 或读取任意文件。它只在有限工具及参数范围内决定业务动作，Node 在执行及发送阶段校验边界。图片数据留在本地链路，天气工具向模型返回简要完成信息，不把图片字节塞进模型上下文。

### 自然语言处理

1. 核验本人／已确认群；群命令必须有 `梁圣 / 梁祖 / 梁嗨 / 小难梁` 之一及空白分隔，不需要 @。
2. 固定命令先走确定性处理；自然语言进入 `conversation-agent.mjs`，检查聊天规则、预算与上下文。
3. `python-agent.mjs` 管理 Python worker，经 stdin/stdout JSON 行协议传递请求、工具调用与结果；stdout 不可混入普通调试日志。
4. `agent_worker.py` 使用 LangChain `create_agent`；参数由 Pydantic schema 约束，每个请求只允许一个工具动作。
5. 天气等通过受限 RPC 回调 Node 的 `WeatherToolbox`；换算、预算、官方状态、余额等由 Python 实现。
6. 天气／雷达成功直接输出图片；复杂换算、生活费及状态查询可在工具取得事实后追加一次**没有工具权限**的模型解释。余额结果直接输出，不交给模型续写。
7. 发送核心再次处理暂停、目的地、发送预算及请求标识，最后调用官方接口。

本轮修复：HTTP暂停（只限`paused:true`）与断开在认证、来源及JSON校验后绕过耗时操作锁；恢复发送与凭据修改仍按原规则串行。断开会取消正在等待凭据或尚未完成的连接，返回`CONNECT_CANCELLED`，避免稍后意外重新连接。暂停标志立即参与状态与发送判断；图片上传完成后、真正发消息前再核对一次。已提交给QQ平台的消息不能靠暂停撤回。

LangChain 的优势是统一工具描述、参数校验、上下文与语义路由，让“北京雷达图”“全马是多少马里”不必逐句编写关键词模板。它不是定时器，也不会自动获得网页、账户、文件或发送权限。新增业务默认按 `AGENTS.md` 使用 Python LangChain Tool，既有 Node 天气实现是保留的实现，不应为“统一语言”盲目重写。

## 3. 当前业务功能

| 功能 | 用户入口／行为 | 主要实现 |
|---|---|---|
| 天气三联图 | `发 天气 广州` 或自然语言；温度、PM2.5、逐小时降水概率，一张图无附文 | `weather*.mjs`、`locations.mjs`；LangChain `weather_image` |
| 雷达 | 单站、区域与全国拼图；北京默认大兴、天津默认塘沽；成功发官方原图 | `radar.mjs`；`radar_image` |
| 雷达目录 | 按省／站点查询与翻页 | `radar_catalog` |
| CAMS | 地点未来48小时 PM2.5 图，默认北京 | `air-quality.mjs`、`air-chart.mjs`；`air_quality_image` |
| 聊天 | 爱吃白饭的大肥鱼，限定话题下自然回复 | `config/chat-policy.md`、`reply_chat` |
| 单位换算 | HU$/人民币、马里/长度、马时/时间；支持复杂问题先算后解释 | `python/conversions.py`；`convert_units` |
| 生活费 | 已知可用余额是否撑到发薪日 | 同上；`living_cost_budget` |
| OpenAI 状态 | 泛问简报、具体服务或故障追问 | `python/openai_status.py`；`openai_service_status` |
| DeepSeek 余额 | 仅本人私聊，查本机已保存 API Key 的账户 | `python/deepseek_balance.py`；`deepseek_account_balance` |
| 早安报告 | 每天08:00天气三联图与运动建议，固定脚本，无需模型推理 | `morning-*.mjs`、`python/morning_report.py` |
| Codex 通知 | 执行任务的授权通知、阻塞求助；不是 QQ 任意遥控 Codex | `src/mcp.mjs`、`codex-package/` |
| WorkBuddy 自习图 | 分析截图，双栏长图发本人 | `workbuddy-study-qq/`、`src/study-briefing.mjs` |

固定比例不得被提示词改变：0.6 HU$=70人民币；1马里=3.08km；1马时=1.5小时；全马42.195km，半马21.0975km。古月币没有钱包、交易或实时外汇服务。

生活费按每天50人民币、每月10日发薪，包含今天、不含发薪日；10日按已领薪计算下月。不能猜用户余额，不自动加入房租、还款或其他开销。

OpenAI 状态来自固定官方 `status.openai.com` 数据端点，缓存60秒；泛问不主动带历史事件或示例型号，用户追问再展开。官方正常不保证个人网络、账号或某个具体模型可用。

DeepSeek 余额是 API 账户余额，不是网页版订阅／QQ钱包／生活费。自然语言可由模型选择；明确“查DeepSeek余额”保留无模型备用路径。群聊不开放此工具，结果不进入普通会话记忆。

### 天气数据与图表语义

- 雷达取中央气象台公开目录和图像，动态目录不等于所有站点持续供图。超过本地60分钟时效、缺时间或无图时报告不可用。
- 天气使用 Open-Meteo ECMWF IFS；空气使用 Open-Meteo 提供的 CAMS Global。不是直接登录 ADS 下载，也不是本地空气质量监测站。
- 地点先查 `data/weather-locations.json`，再走地理编码；同名地点澄清，不默认第一个。
- CAMS PM2.5 是浓度模型预报，不是综合 AQI、能见度、实况雾霾诊断；太阳辐照不是 UV 指数。
- 所有时间按北京时间；缺数留断点，不填0。最高逐小时降水概率不是“全天降雨概率”。
- 温度用固定温标颜色；PM2.5 分段色以当前代码和来源说明为准。交接文档不重新认定外部标准是否更新，改阈值前重新核对官方来源。

## 4. 上下文、模型与发送限制

白名单群只保留服务实际收到的最近10条、30分钟内的筛选匿名背景，不读取 QQ 历史消息。无前缀普通文字只更新背景，不调用模型；触发请求时背景会发给 DeepSeek。群之间隔离，移除、暂停、断开或重启清理背景；筛选不保证文本绝无个人信息。

模型配置由本地页面保存，经 Windows DPAPI 加密；源码默认 model 名不代表本机当前已配置型号。不要直接把模型固定成用户曾举例的型号。当前代码设置 `temperature=0.9`、`max_tokens=768`、模型超时20秒、SDK自动重试0；worker总超时上限60秒。

仅连接失败且工具尚未执行时，middleware 最多恢复一次；鉴权、余额不足、限流、超时和已经执行的工具不能靠重试掩盖。`model_transport.py` 沿用本机系统 HTTP(S) 代理，不关闭 TLS，不在日志打印代理凭据。

模型逻辑请求预算为单人9/分钟、scope12/分钟、全局15/分钟、每日180；核验修改点见 `chat-safety.mjs` 与对应测试。复杂解释可以用两次模型推理，但按逻辑请求计预算。600字符是输出安全兜底，不是要求每句都机械短答。

QQ发送预算是另一层：当前 `config/send-limits.json` 为15/分钟、300/日、预留10通知。本人、群、日报及广播共享；广播每个目标分别计数。不要把历史的20/日、200/日当腾讯官方额度。本地放宽不能解除腾讯侧限制。

## 5. 早安自动任务

```mermaid
flowchart TD
  LOGIN[Windows 用户登录] --> TASK[AlexQQ-Morning-Service]
  TASK --> RUN[run-morning-service.ps1]
  RUN --> TICK[morning-scheduler.mjs 每15秒检查]
  TICK --> READY{服务在线、已配对、未暂停、额度可用?}
  READY -- 否 --> TICK
  READY -- 是 --> TIME{北京时间已到08:00?}
  TIME -- 否 --> TICK
  TIME -- 是 --> CLAIM{当天调度登记是否存在?}
  CLAIM -- 是 --> TICK
  CLAIM -- 否 --> RECORD[先登记当天尝试]
  RECORD --> DATA[选城与取天气/CAMS]
  DATA --> RULES[Python 固定运动建议]
  RULES --> IMAGE[Node 合成图片]
  IMAGE --> OWNER[发本人并记录结果]
```

这是**用户登录启动**的任务，不保证停留在系统登录界面时运行。08:00前启动等待，之后启动／恢复且当天尚未登记则补发。服务不可达时调度器最多每5分钟尝试启动；不解除发送暂停。

调度登记 `.private/morning-scheduler/日期.json` 与核心 `weather-daily-YYYY-MM-DD` 是两层保护；实际登记后失败或送达不确定不自动补发，不能因改版清记录。WorkBuddy“每次调用都发”不影响日报规则。

增强版当前开启，`scripts/enable-morning-report.ps1 -Disable` 可回退旧北京日报；切换不改变当日登记。日常仅发本人，群不自动订阅。

选城依 `data/holidays-cn.json`：官方放假区间内（含区间内周末）天津，其余北京，普通周末不切天津。未知年份默认北京并提示日历待更新。2027资料应在接手时重新核对，不能沿用旧文档“尚未发布”当实时事实。

正常工作日周一、三重点20–22点；其他日期候选07–08:30、16–19、20–22点。按生成时刻剔除已过时段，选择连续30/60分钟；温湿度、降水、PM2.5、风、辐照及天气码按确定性规则评估。评分是产品自定义适宜度，不是官方或医疗结论。

## 6. WorkBuddy 接入与2.3.1行为

源目录：`workbuddy-study-qq/skills/building3-study-planner-v2-1`。
本机安装：`C:\Users\Alex\.workbuddy\skills\building3-study-planner-v2-1`。
安装包：`workbuddy-study-qq/building3-study-qq-2.3.1.zip`。

```mermaid
flowchart LR
  SCREEN[同一天截图] --> OCR[extract.py / Windows OCR]
  OCR --> REVIEW[input.json + review.json 核对]
  REVIEW --> PLAN[plan.py 六级规划]
  PLAN --> RENDER[briefing.py + briefing_layout.py]
  RENDER --> MANIFEST[PNG + briefing-manifest.json]
  MANIFEST --> SEND[send_qq.py LangChain Tool]
  SEND --> API[POST /api/study-briefing]
  API --> OWNER[本人私聊]
```

`run.ps1` 默认额外生成未核对预览；正常查询核对后由 WorkBuddy 执行 `publish.ps1 -Reviewed`，`-NoSend` 只生成，`-Demo` 明示模拟。完整聊天报告不应被图片替代。

固定绘图：1800px双栏、陶土橙／暖白；左侧空闲绿、有课白、未知黄，大行距和时段分界；晚间时段标题写19:00起、常用19:50起。具体建议保留可核验课节范围，不推定晚间无限使用。

六级优先顺序：小教室前节有课 → 小教室连续空闲 → 大教室前节有课 → 大教室连续空闲 → 换房 → 局部。先排序后截取五条；前节未知不能算有课；上午无前节依据；同等级晚间优先11–14完整覆盖。排除教室、原始课节及未知语义不因版式改变。

**2.3.1取消按内容跨调用去重**：每次明确调用发送器产生新的随机 `study:<64hex>` 请求标识，相同日期、截图或PNG也会发送；manifest里的旧内容摘要仍保留，但不是实际POST的发送身份。每次调用只POST一次，超时不自动重试；下一次用户明确调用是新的发送。

`.qq-delivery` 保留每次请求回执，不因旧记录拒绝新调用。不应删除回执或把这种行为扩展到早安任务、Codex通知。QQ核心仍保留单次请求标识保护和配额。

图片发送只读本机访问口令用于固定回环接口，不把口令写入输出。manifest必须已核对、日期合法、生成不超过2小时、SHA256与PNG匹配、PNG不超过1.5MB。服务额外限制请求大小、PNG签名及真实解码、1080/1800宽、200–16000高；接口不接受文件路径、远程URL或收件人。

两个Python环境不同：WorkBuddy自带Python有Pillow/NumPy负责OCR与绘图；QQ项目 `.venv` 有LangChain负责发送。不能假设任意 `python` 同时具备依赖。

本轮只更新源目录陈旧测试与README，发送器行为仍为2.3.1，没有重发安装包或修改已安装skill。源目录与已安装`send_qq.py`的SHA256核对一致。发送测试覆盖同manifest两次独立POST、超时单次POST及回执、暂停/离线/额度拒绝、未核对与图片篡改；分别在Bot与WorkBuddy的现有环境运行，避免因缺少另一环境依赖而跳过验证。

## 7. 本地接口、插件与文件地图

服务监听 `127.0.0.1:19327`，UI `/`，开发说明页 `/guide`，公开健康检查 `/health`。`/api/*` 有本机认证与来源校验；不要在日志或交接文档写访问口令、带口令的设置URL。

| 接口组 | 用途 |
|---|---|
| GET `/api/status` | 安全状态，配对、连接、额度及agent状态 |
| `/api/config`、`/api/agent/config` | QQ凭据与模型配置；敏感值仅本地输入 |
| `/api/connect`、`/api/disconnect`、`/api/pause` | 生命周期与暂停 |
| `/api/pair/*`、`/api/group/*` | 本人和群本机确认绑定 |
| `/api/notify` | 已授权本人文本通知 |
| `/api/notify-all-allowed` | 显式授权后枚举当前本人和白名单广播 |
| `/api/weather/preview`、`/api/weather/briefing` | 天气预览、daily或test发送 |
| `/api/morning/preview`、`/api/morning/test-all-allowed` | 增强报告预览或显式广播测试 |
| `/api/study-briefing` | WorkBuddy本人PNG发送 |

MCP源码注册 `qq_status`、`qq_notify`、`qq_weather_preview`、`qq_weather_briefing`、`qq_broadcast`、`qq_morning_test`。安装缓存是否已加载以当前工具列表为准；只修改源码不会保证旧聊天立即刷新MCP。

| 文件／目录（相对QQ项目） | 责任 |
|---|---|
| `src/server.mjs` | HTTP路由、认证及组件装配 |
| `src/core.mjs` | 配对、群白名单、入站验证、发送队列、预算和状态 |
| `src/qq-adapter.mjs` | 腾讯SDK事件、上传及发送 |
| `src/storage.mjs` | DPAPI、受限目录、原子持久化 |
| `src/conversation-agent.mjs`、`chat-safety.mjs` | 自然语言边界、模型请求预算及上下文 |
| `src/python-agent.mjs`、`python/agent_worker.py` | Node/Python协议及LangChain运行 |
| `src/agent-config.mjs`、`python/model_transport.py` | 模型配置与网络客户端 |
| `src/weather-tools.mjs`、`weather-commands.mjs` | 固定天气工具与命令入口 |
| `src/morning-*.mjs`、`python/morning_report.py` | 日历、分析、早安图表 |
| `src/mcp.mjs`、`bridge-client.mjs` | Codex与回环接口桥接 |
| `config/` | 发送额度、早安开关、聊天话题与人设 |
| `data/` | 地点目录、节假日日历等非密钥数据 |
| `public/` | 控制页、guide、logo |
| `codex-package/` | Codex本地插件安装源；不要打包整个运行目录 |
| `deploy/`、`test-output/` | 验收记录、测试日志、预览；不是一律可公开的安装素材 |
| `.private/` | 凭据、身份与运行状态，禁止提交或拷入安装包 |

## 8. 启动、开发与验证

本机Node：`D:\Program Files\nodejs\node.exe`；要求Node≥22。
Bot Python：`D:\Projects\Alex Bot\codex-qq-plugin\.venv\Scripts\python.exe`。
WorkBuddy Python：`C:\Users\Alex\.workbuddy\binaries\python\envs\default\Scripts\python.exe`。

```powershell
Set-Location -LiteralPath 'D:\Projects\Alex Bot\codex-qq-plugin'
# 日常入口，打开本机控制页；桌面“亚历克斯 Bot”快捷方式使用它
.\scripts\open-console.ps1
# 独立启动／停止服务
.\scripts\start-service.ps1 -AutoConnect
.\scripts\stop-service.ps1
# 只读检查计划任务
Get-ScheduledTask -TaskName 'AlexQQ-Morning-Service'
# 离线Python测试
.\.venv\Scripts\python.exe -m unittest discover -s python -p 'test_*.py'
# 完整Node离线回归，可与正式服务同时运行
npm test
# 模拟早安图，无QQ发送
node scripts/preview-morning-local.mjs
```

依赖恢复：Node用`npm ci`，Python优先检查 `scripts/install-python-agent.ps1` 与 `python/requirements*.txt`，保持虚拟环境隔离。安装自启动见 `scripts/install-autostart.ps1`，不要在不需要时重复创建任务。

MCP测试已改用系统分配的回环临时端口，子进程通过测试代码注入受信任客户端；可以在正式服务占用19327时执行完整`npm test`。正式MCP仍固定默认19327，不新增任意URL、主机、环境变量端口或工具参数。其他临时服务测试同样使用独立端口。

WorkBuddy测试在`workbuddy-study-qq`目录运行：Bot环境执行`-m unittest test_briefing.SenderTests`（4项），WorkBuddy环境执行`-m unittest test_briefing.BriefingTests`（1项）。只用模拟发送接口和本地渲染，不发送真实QQ消息。

新功能推荐流程：

1. 阅读AGENTS及对应模块，确认输入、工具权限、输出和失败语义。
2. Python实现确定性业务与受限LangChain Tool；Node只添加必要桥接与输出校验。
3. 增加缺数、歧义、权限隔离、超时和错误路径测试，勿只测试成功例子。
4. 本地预览、人工看图；明确需要时才调用真实模型、数据源和QQ。
5. 备份变更文件；同步源码、安装副本、元数据及ZIP，检查hash和版本；不要覆盖用户其他任务改动。
6. 重启影响到的服务并查状态。记录测试环境、命令、结果、未覆盖项；平台接受和客户端确认分开记录。

## 9. 本轮修复与后续优先级

最初审阅见`codex-qq-plugin/deploy/codex-review-20261029.json`；以下是本轮处理结果，以维护记录和当前源码为准。

| 优先项 | 证据与影响 | 建议 |
|---|---|---|
| HTTP全局操作锁 | 已修复：暂停/断开绕过慢操作锁，取消晚到连接，上传后复核暂停；相关并发回归通过 | 当前运行服务已重启加载，已发往QQ的请求不能撤回 |
| 全量测试端口冲突 | 已修复：MCP测试注入回环随机端口，在线服务19327持续运行时全量通过 | 测试端口不进入公共工具schema或正式环境配置 |
| WorkBuddy源目录测试陈旧 | 已修复：测试按2.3.1每次明确调用新发的规则重写，4项发送、1项绘图通过 | 保留单次超时不重试，不恢复跨调用内容去重 |
| 文档漂移 | 已更新WorkBuddy版本、QQ当前额度/余额路由说明、本交接与根README；旧验收按时间保留 | 以后发布同时更新行为、证据与待验项 |
| 版本控制 | 已建立工作区根Git仓库；源码与非密钥配置纳入管理 | `.private`、浏览器profile、备份、回执、ZIP与隐私样本保留本地 |
| 持续运行验收 | 历史人工测试不等于跨夜、休眠恢复或长期无互动投递成功 | 用真实调度记录与本人收件反馈验收，不循环补发 |

本轮实际回归：Node353项全部通过（含恢复运行的MCP子测试），Bot Python82项全部通过；WorkBuddy发送4项、渲染1项分别在正确环境全部通过，无跳过。定向Node回归55项通过。未重新调用在线模型、天气源或QQ发送作业务验收；长时间运行/休眠恢复与校园浏览器采集仍属待验，不能用离线测试替代。

### 常见排障顺序

| 现象 | 首先检查 |
|---|---|
| 所有消息不回 | `qq_status`：连接、暂停、配对、额度；再看服务进程 |
| 群不回、私聊正常 | 实际群授权、前缀空白、接收全部消息与主动发送权限 |
| 固定雷达能回，自然语言失败 | 模型配置／Key状态、Python worker、代理路径、模型错误码与请求预算 |
| WorkBuddy只有本地图片 | 是否执行publish -Reviewed、manifest新鲜度、发送回执、实际加载的skill版本 |
| WorkBuddy旧版DUPLICATE | 旧发送器按内容去重；当前2.3.1每次新调用已修正，不删除服务器记录 |
| 早安没到 | 用户是否登录、任务是否运行、联网与暂停、当天是否已登记、日期与额度 |
| 测试EADDRINUSE | MCP已用独立临时端口；检查其他测试或旧代码副本，不停止不相关进程 |
| SENT却未看到 | 区分接口接受与QQ客户端实际收件，不换标识循环重发 |

## 10. 尚未接入的教室采集与迁移边界

`buaa-classrooms/` 是独立采集项目，目前**没有接入QQ或LangChain**。公开页面与协议分析、手动登录页面提取已有记录；独立Python浏览器认证全流程仍待实测，不能把静态样本当自动采集成功。

采集页面提示历史时段可能不显示，“无标记”不一定等于有课。不要直接把新采集数据映射成现有截图skill的白色=B语义；接入前定义时间、空闲/占用/未知与数据新鲜度契约。建议采集端维护本地JSON、受限Tool只读校验后的快照，不让模型持有校园登录材料。

尚无云端部署。迁移需重新确认QQ权限、定时任务、网络与认证存储；Windows DPAPI材料不能直接当跨机器可用密钥。迁移时调整绝对路径及统一的 `QQ_BRIDGE_HOME`，先验证单实例，避免本地与云端同时连接和重复调度。

Codex阻塞求助遵守最新AGENTS：至少三次有效诊断、已问具体问题且等待五分钟仍无响应、状态允许时仅通知一次。用户取消或问题解决即停止；不是脱离Codex运行的后台监控。WorkBuddy的重复发送规则不覆盖该约定。

## 11. 证据与维护

- 当前业务源码与配置：`codex-qq-plugin/src/`、`python/`、`config/`。
- 最近审查：`codex-qq-plugin/deploy/codex-review-20261029.json`。
- 本轮修复及离线/重启验收：`codex-qq-plugin/deploy/maintenance-20261029.json`。
- 真实验收历史：`deploy/langchain-live-verification.json`、`enhanced-morning-live-test.json` 等；结论限于各次记录。
- WorkBuddy实际规则：已安装及源目录的 `SKILL.md`、`references/qq-briefing.md`、`scripts/send_qq.py`。
- 备份：项目根 `backups/`。含运行文件与用户内容的备份不得默认公开。

每次发布请更新本文的日期、版本、变更行为、部署副本及验证状态。不要把凭据、本人或群的完整平台标识、带授权参数URL、校园profile或完整聊天日志写进交接资料。

## 12. Git与GitHub交付

仓库：[Alexx-Powered/alex-bot](https://github.com/Alexx-Powered/alex-bot)。2026-10-29新建并查询API核实为PRIVATE；默认分支main，origin指向该仓库。本地Git根目录是`D:\Projects\Alex Bot`，统一管理QQ主服务、WorkBuddy扩展、教室采集原型及交接资料。作者采用GitHub账号的noreply邮箱。

提交区分原始源码基线和本轮修复，后续用`git log`定位维护版本。旧版服务号仍为0.2.1，不用它判断是否包含本次修复。

根`.gitignore`排除所有`.private`、校园`.private-profile`、`.qq-delivery`、备份、依赖/虚拟环境、预览、运行日志、ZIP、真实采集样本及原始验收记录。这些本机文件保留不动。仅经过筛选的初始审阅与本轮维护摘要进入Git；`deploy`中其他原始证据及`test-output`在远端克隆中不存在。文中引用的安装ZIP和采集样本同样属于本地材料，不能声称远端仓库包含它们。

上传前检查了跟踪文件路径与常见凭据特征；命中的测试凭据为明确合成值。后续每次提交仍需检查暂存区，private并不能替代凭据保护。改可见性、迁移登录材料或新增对外部署需另行授权与验证。
