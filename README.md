# 亚历克斯 QQ Bot

通过腾讯官方 QQ Bot API 运行的本地机器人。Node.js 管理 QQ 接入、授权、预算和发送；Python LangChain 管理自然语言工具选择与新增业务规则。主要功能包括天气/雷达图片、固定换算、生活费预算、官方服务状态查询、本人账户余额、早安报告及自习简报。

开发前阅读 [AGENTS.md](AGENTS.md) 和 [HANDOVER.md](HANDOVER.md)。

群权限现分两档：白名单群成员带原有前缀主动询问时，可使用全部业务工具，包括DeepSeek余额和学院路三号楼查询；灰名单群仅可基础聊天与固定单位换算。设置页第04节可选择名单绑定群、切换档位或移除，现有白名单保留。群管理与凭据设置仍由本机页面操作；早安和求助通知仍发本人。

GitHub：[Alexx-Powered/alex-bot](https://github.com/Alexx-Powered/alex-bot)，2026-10-29创建并核实为private；默认分支`main`。

| 目录 | 内容 |
|---|---|
| [codex-qq-plugin](codex-qq-plugin/README.md) | QQ主服务、Python工具、Codex MCP、本机控制页与测试 |
| [workbuddy-study-qq](workbuddy-study-qq/README.md) | WorkBuddy截图分析、三号楼自习规划、绘图及本人发送工具 |
| [buaa-classrooms](buaa-classrooms/README.md) | 最初的独立采集原型；当前Bot集成实现在主服务的Python校园模块 |

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

WorkBuddy原脚本保留不同Python环境入口；Bot环境现已加入Pillow，也可一次运行完整5项测试，命令见其README。在线数据、模型与真实QQ验收需要按当次授权单独执行。

学院路功能在本机控制页第06节配置。本人私聊或白名单群主动询问“查空教室”“三号楼简报”会查询学院路全部教室JSON，并直接生成三号楼图片回复当前会话；JSON可在控制页查询/下载。校园账号密码单独用Windows DPAPI加密，不进入模型、仓库或群聊。校园接口标空闲的课节为空闲，其余课节按用户指定记为有课。

## 仓库边界

本仓库仅保存源码、非密钥配置、依赖锁文件、测试和开发说明。`.private`、校园浏览器profile、QQ收件回执、备份、预览、采集样本、运行日志、虚拟环境及安装ZIP均忽略；本机保留这些文件，Git不管理它们。历史部署验收原件可能含用户信息，默认只留本地；Git中保存经过筛选的维护记录。

当前GitHub仓库设置为private。后续改变可见性前需重新检查文档、配置及提交历史。消息接收权限、发送暂停、计数及幂等记录不能通过Git回滚或复制来重置。
