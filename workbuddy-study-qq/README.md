# 三号楼自习规划 · WorkBuddy QQ 简报扩展

版本 2.3.1。插件采用本机 WorkBuddy 已使用的 `.codebuddy-plugin/plugin.json` + `skills` 结构。开发交接见上级目录 [HANDOVER.md](../HANDOVER.md)。

2026-10-29本仓库共享规划函数更新：上午/晚上小教室连续空闲一级、普通教室二级；下午第5节有课且下午整段空闲为一级，同级优先小教室，其余档位顺延。配色保持橙色，一级明显深于二级。QQ Bot直接导入此源目录的规划/绘图函数；本轮没有执行skill、OCR，也未同步或重新打包本机已安装的WorkBuddy技能副本。下文安装说明对应既有2.3.1安装。

本机直接更新原技能 `~/.workbuddy/skills/building3-study-planner-v2-1`，保留技能标识、原始 OCR、规划器和全部教室规则，避免安装两份同名技能。若现有 WorkBuddy 会话已缓存旧内容，请开启新会话再调用。

提供本次三号楼截图并说“分析自习教室并把简报发给我的 QQ”即可。WorkBuddy 仍输出完整表格与每时段建议，并核对识别疑点后运行固定脚本：1800px 双栏长图，左栏全部教室分时段空闲课节表，右栏每时段最多5条真实建议及完整理由。方案不足时如实说明。

绘图：WorkBuddy 自带 Python + Pillow。发送：本机 QQ Bot 的 Python + LangChain，直接 invoke 工具，无在线大模型调用。沿用本机 `D:\Projects\Alex Bot\codex-qq-plugin`，需已配对本人、连接正常、未暂停且有发送额度。无需启动 Codex。

详细运行步骤见技能的 `references/qq-briefing.md`。`publish.ps1 -NoSend` 只生成图片；正常发送需 `-Reviewed`，仅针对已核对结果。2.3.1每次用户明确调用发送器都生成新请求标识，即使manifest、日期或PNG相同也会发送；单次调用只POST一次，失败或超时不自动重发。再次明确调用属于新的发送，既有回执保留。

源目录的发送测试已与2.3.1同步。两个Python环境分别验证，无真实QQ发送：

```powershell
& '..\codex-qq-plugin\.venv\Scripts\python.exe' -B -X utf8 -m unittest test_briefing.SenderTests
& "$env:USERPROFILE\.workbuddy\binaries\python\envs\default\Scripts\python.exe" -B -X utf8 -m unittest test_briefing.BriefingTests
```

2026-10-29发送测试4项与绘图测试1项通过。随后校园功能接入时Bot环境已加入Pillow/Playwright，可在Bot环境一次执行完整`python -m unittest test_briefing.py`。WorkBuddy原有运行脚本与环境选择不变。

此安装包不含 QQ 凭据、访问口令、截图、用户标识、测试数据或运行回执。迁移到其他电脑时须先安装并配对对应的 QQ Bot 桥接服务，不能只复制密钥文件。
