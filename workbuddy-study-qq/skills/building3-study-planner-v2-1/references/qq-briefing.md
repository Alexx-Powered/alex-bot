# 自习简报与本人 QQ 私聊

本扩展保留原始 OCR、逐节判定和规划规则。`run.ps1` 完成后额外保存 `study-briefing.png` 与 `briefing-manifest.json`，默认是未核对预览，不发送。完整表格与至少五条真实方案（不足时说明）仍需在 WorkBuddy 对话中展示；简报为1800像素宽双栏长图：左侧按上午、下午、晚上完整列出全部未排除教室的空闲课节及待确认项，右侧完整列出每时段最多5条真实建议、时间、换房信息和推荐原因；真实方案不足5条时说明缺口，不凑数。

## 核对后发送

核对本次 `review.json` 的局部疑点；必要时修正同目录的 `input.json`，未知保留 `?`，不以猜测补全。用户已要求这项功能在正常调用后向本人 QQ 额外发送简报，无需每次再次确认；用户本次指定不发送、仅预览或暂停时，以本次要求为准。

```powershell
$skillRoot = Join-Path $env:USERPROFILE '.workbuddy\skills\building3-study-planner-v2-1'
& (Join-Path $skillRoot 'scripts\publish.ps1') -InputJson (Join-Path (Get-Location) 'study-result\input.json') -OutDir (Join-Path (Get-Location) 'study-result') -Reviewed
```

若通过插件安装，`$skillRoot` 应使用宿主实际加载本 SKILL.md 的目录。不要假定插件缓存路径固定。

- 仅生成：增加 `-NoSend`；未完成核对时不要传 `-Reviewed`。
- 完整查询日期缺失：仍生成带“日期待确认”的预览，但不发送，不能用系统日期代替截图查询日期。
- 历史/未来查询按用户给出的日期展示，不能称为“今天”；发送清单超过两小时则重新从当前核对结果生成图片。
- `-Demo` 只适用于明确的功能测试，图片始终标“功能测试·模拟数据”，不得用于伪装真实查询。
- 修正输入后同步重新运行 `plan.py` 输出完整报告，避免对话与简报使用不同数据。

## 运行与边界

绘图使用 WorkBuddy 已有 Python + Pillow，直接复用原 `plan.analyze`，不调用大模型。发送脚本在 QQ Bot 已有 Python 环境中直接 invoke 一个 LangChain Tool，也不调用大模型，不消耗 DeepSeek 推理额度。

发送脚本只读取本机 `.private/admin-token` 到内存，用于固定 `http://127.0.0.1:19327` 的身份校验。不打印、复制或打包口令；不读取 QQ AppSecret / DeepSeek Key。不允许收件人、群号、任意 URL 或原截图上传参数。只上传本次已核对的简报 PNG，接收人由 QQ Bot 的已配对唯一主人决定。

发送前检查连接、配对、暂停和额度；不自动启动离线服务、不解除暂停、不提高额度。服务器继续应用原有发送额度及持久化幂等。不按日期、内容或图片去重。每次显式调用发送器都生成独立请求标识，本地 `.qq-delivery` 保留每次请求的回执用于排查；相同图片可以再次发送，无需删除旧记录。一次调用仅执行一次 POST，超时、失败不自动重试；用户再次明确调用时视为新的发送。

成功输出 `{"ok":true,"code":"SENT"}` 表示 QQ 接口接受，不等于用户已阅读。正常新调用使用新的请求标识；若接口意外返回 `DUPLICATE`，表示该次请求已被处理，不能声称本次新发。`DELIVERY_UNKNOWN` 或 `ALREADY_ATTEMPTED_CHECK_RECEIPT` 时查本地回执并让用户核对；不能声称送达。离线、暂停、限额、日期缺失时，交付本地图片和准确原因，完整分析仍照常交付。

运行依赖：本机 QQ Bot（D:\Projects\Alex Bot\codex-qq-plugin）已部署 `/api/study-briefing` 图片入口且本人已配对。该入口只接受认证的有限 PNG 和 `study:` 幂等键，不提供文件读取或群发功能。无需启动 Codex。


## v2.3.0 图表与推荐

采用陶土橙和暖白双栏长图。左栏逐节色块：绿色空闲、白色有课（浅边框）、黄色待确认；加大行距，顶部标上午08:00—12:15、下午14:00—18:15、晚上19:00起，另标第12节19:50。右栏保留五条真实建议与完整理由，以1—6级标签和橙色深浅体现推荐程度，不按时段配色。推荐等级及排序以SKILL.md和plan.py为准，未知不提升等级，等级不是实际有座概率。
