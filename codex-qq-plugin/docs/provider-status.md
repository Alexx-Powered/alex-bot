# 五家 AI 服务状态（已上线）

2026-11-03：用户要求使用各提供商自己的 Logo、品牌色，并新增 Gemini、
Claude、Kimi。用户随后取消 GLM；不提供 GLM 查询、图标或工具选项。
2026-11-03 20:03 CST 已部署 linux-status-57b98ae79662。ECS 可读取 OpenAI、DeepSeek、Claude、Kimi；Gemini 暂时返回状态待确认，不据此认定服务故障。未发送测试 QQ 或更新 GitHub。

## 使用与授权

- 固定指令：`查 OpenAI 状态`、`查 DeepSeek 状态`、`查 Gemini 状态`、
  `查 Claude 状态`、`查 Kimi 状态`。也支持 `/status gemini` 等形式。
- 固定指令直接调用 Python LangChain Tool，不读取模型配置或消耗模型额度。
- 自然语言通过受限 `ai_service_status(provider)` 调用；provider 仅允许五个
  固定值，不允许 URL、Key、账户、路径或收件人参数。
- 五家共用现有逐群“AI服务状态”开关；灰名单、关闭状态、撤销在途授权时
  不执行/不投递。官方 @ 与现有唤醒词规则保持。
- 保留旧 `deepseek_service_status()` 和 `openai_service_status()` 参数契约。
  泛问 OpenAI 当前状态改用图；指定 scope、query、include_recent 的旧精细
  查询继续使用原有说明流程。滑动变祖器原图与查询不变。

## 官方来源

| 提供商 | 来源 | 读取方式 |
| --- | --- | --- |
| OpenAI | https://status.openai.com/ | summary + incidents JSON；避免兼容 summary 漏事件 |
| DeepSeek | https://status.deepseek.com/ | 官方页面 JSON/Flight initialData；验证源域名与更新时间 |
| Gemini | https://aistudio.google.com/status | 公开页面同源配置与固定只读 ListIncidentsHistory RPC |
| Claude | https://status.claude.com/ | 官方 summary JSON（含当前事件） |
| Kimi | https://status.moonshot.cn/ | 官方 summary JSON（含当前事件） |

Gemini 状态覆盖 API、Multimodal Live API 和 Google AI Studio，不将它当作
Gemini 消费端或 Vertex AI 状态。读取官网当前匿名客户端标识，不使用/保存
用户 API Key、不调用模型、不读取账户。该网页协议不是版本承诺；若格式
变化或读取失败，显示“状态待确认”，不能据此宣布正常或服务故障。

所有请求限定来源、禁止跳转，单请求 8 秒、响应至多 2 MB；正常读取结果
缓存 45 秒并保留实际查询时间。失败不缓存为正常，不自动循环重试。
历史 resolved/completed 事件不算当前故障；进行中的维护仍显示；monitoring
及 Gemini 的 mitigated 不能算已恢复。非正常组件即使不在常用列表，也会
显示。缺少详细通报或字段未识别时写明信息不足，不猜维修进度和恢复时间。

## 图片与预览

`src/provider-status-image.mjs` 复用天气图背景、字体、1867 像素宽度和小块
PNG 编码。每家主卡使用自己的品牌色，Logo 取自官方页面公布的素材；
`public/provider-status/sources.json` 保留来源和 SHA256。故障详情保留红框，
包括影响服务、问题表现、处理阶段、最新进展及更新时间。

输入字段由 Python 产生，Node 严格验证来源/厂商匹配、时间及形状后只负责
排版。绘制最多 512 像素高的临时画布，20 Mpx 总像素和 1.5 MB 发送大小上限
保持；没有安装浏览器、常驻爬虫或放宽 ECS 内存限制。

```powershell
.venv/Scripts/python.exe -B -X utf8 scripts/preview-provider-status.py
node scripts/preview-provider-status.mjs
```

输出在 `test-output/status-providers/`，含五张完整预览、配色总览与两张
明确标注的历史故障回放。回放数据来自上一版真实历史验证；完整预览独立
于它们。`live-pipeline-check.json` 记录真实 Node → Python → LangChain →
官方公开源 → Node 绘图的只读联调；不会启动 Bot 或发送 QQ。

## 验证与将来发布

Python 79 项（主 agent、五家状态、旧公共状态、OpenAI、逐群权限）通过；
Node 69 项相关用例通过，包含五家真实跨语言离线调用、固定命令无模型调用、
自然语言 RPC、群开关及在途撤权、原协议/旧链路兼容、品牌文字对比度。
五家实时源均已实际读取。各完整图、品牌总览及异常红框已目视检查。

将来用户批准上线后，至少整体包含：
`python/provider_status.py`、`python/public_status_worker.py`、
`python/agent_worker.py`、`python/group_features.py`、
`src/provider-status-image.mjs`、`src/public-status.mjs`、
`src/conversation-agent.mjs`、`src/group-features.mjs`、`src/help-image.mjs`、
`public/provider-status/`。复用现有天气样式及 `png-strips.mjs`，不要遗漏依赖。
发布仍按 ops/README 备份、核对实际生产来源及 PID、受限 ECS 专项后执行；
当前没有做 Linux 平台验证或部署。
