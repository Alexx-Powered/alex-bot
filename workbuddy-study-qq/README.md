# 三号楼自习规划 · WorkBuddy QQ 简报扩展

版本 2.2.0。插件采用本机 WorkBuddy 已使用的 `.codebuddy-plugin/plugin.json` + `skills` 结构。

本机直接更新原技能 `~/.workbuddy/skills/building3-study-planner-v2-1`，保留技能标识、原始 OCR、规划器和全部教室规则，避免安装两份同名技能。若现有 WorkBuddy 会话已缓存旧内容，请开启新会话再调用。

提供本次三号楼截图并说“分析自习教室并把简报发给我的 QQ”即可。WorkBuddy 仍输出完整表格与每时段建议，并核对识别疑点后运行固定脚本：1800px 双栏长图，左栏全部教室分时段空闲课节表，右栏每时段最多5条真实建议及完整理由。方案不足时如实说明。

绘图：WorkBuddy 自带 Python + Pillow。发送：本机 QQ Bot 的 Python + LangChain，直接 invoke 工具，无在线大模型调用。沿用本机 `D:\Projects\Alex Bot\codex-qq-plugin`，需已配对本人、连接正常、未暂停且有发送额度。无需启动 Codex。

详细运行步骤见技能的 `references/qq-briefing.md`。`publish.ps1 -NoSend` 只生成图片；默认发送仅针对已核对结果。本地失败或超时不自动重发。

此安装包不含 QQ 凭据、访问口令、截图、用户标识、测试数据或运行回执。迁移到其他电脑时须先安装并配对对应的 QQ Bot 桥接服务，不能只复制密钥文件。
