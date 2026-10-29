# 亚历克斯 QQ Bot

通过腾讯官方 QQ Bot API 运行的本地机器人。Node.js 管理 QQ 接入、授权、预算和发送；Python LangChain 管理自然语言工具选择与新增业务规则。主要功能包括天气/雷达图片、固定换算、生活费预算、官方服务状态查询、本人账户余额、早安报告及自习简报。

开发前阅读 [AGENTS.md](AGENTS.md) 和 [HANDOVER.md](HANDOVER.md)。

GitHub：[Alexx-Powered/alex-bot](https://github.com/Alexx-Powered/alex-bot)，2026-10-29创建并核实为private；默认分支`main`。

| 目录 | 内容 |
|---|---|
| [codex-qq-plugin](codex-qq-plugin/README.md) | QQ主服务、Python工具、Codex MCP、本机控制页与测试 |
| [workbuddy-study-qq](workbuddy-study-qq/README.md) | WorkBuddy截图分析、三号楼自习规划、绘图及本人发送工具 |
| [buaa-classrooms](buaa-classrooms/README.md) | 学院路空教室采集原型，尚未接入QQ或LangChain |

## 本地开发

运行环境为 Windows、Node.js ≥22、Python ≥3.10。主服务依赖恢复：

```powershell
Set-Location -LiteralPath 'D:\Projects\Alex Bot\codex-qq-plugin'
npm ci
.\scripts\install-python-agent.ps1
```

凭据在本机设置页填写；首次配对与启动流程见主服务README。现有安装无需重新配对。MCP安装源和部分脚本含本机绝对路径，迁移时需调整，不能把Windows DPAPI材料直接复制到其他机器使用。

离线回归不发送真实QQ消息、不调用在线模型，可在服务运行时执行：

```powershell
npm test
.\.venv\Scripts\python.exe -B -X utf8 -m unittest discover -s python -p 'test_*.py'
```

WorkBuddy发送和绘图测试使用不同Python环境，命令见其README。在线数据、模型与真实QQ验收需要按当次授权单独执行。

## 仓库边界

本仓库仅保存源码、非密钥配置、依赖锁文件、测试和开发说明。`.private`、校园浏览器profile、QQ收件回执、备份、预览、采集样本、运行日志、虚拟环境及安装ZIP均忽略；本机保留这些文件，Git不管理它们。历史部署验收原件可能含用户信息，默认只留本地；Git中保存经过筛选的维护记录。

当前GitHub仓库设置为private。后续改变可见性前需重新检查文档、配置及提交历史。消息接收权限、发送暂停、计数及幂等记录不能通过Git回滚或复制来重置。
