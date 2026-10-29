# ECS 运行与密钥交接

2026-10-29 已迁移。开发工作区仍为 `D:\Projects\Alex Bot`，GitHub 仅在用户明确要求时更新。

## 功能与运行位置

| 部分 | 当前运行位置 |
|---|---|
| QQ官方SDK、配对、白/灰名单、前缀、限额与图片发送 | ECS `alexbot.service` |
| DeepSeek聊天/余额、LangChain换算、生活费与运动规则 | ECS Node → Python worker |
| 学院路全部教室JSON、全天图、即时推荐与记忆 | ECS独立校园worker、Chromium与中文字体 |
| 普通聊天长期偏好记忆 | Python LangChain + `.private/chat-memory/chat-memory.sqlite3`，按私聊/群及成员隔离；24条/分区、180天有效 |
| 天气、CAMS、雷达和增强早安图片 | ECS；异常仍明确缺数据，不补造数值 |
| 北京时间08:00早安 | `alexbot-morning.service`；保留每日claim，避免重复补发 |
| 本机设置页、Codex MCP、WorkBuddy发送 | 本机127.0.0.1:19327 → 受限SSH → ECS回环端口 |
| 本地响应耗时与可选LangSmith | Node只记录数值和固定阶段；第07节管理，`.private/monitoring-config.json`加密Key，`.private/telemetry/recent.json`最多50条 |

ECS：`cn-beijing / i-2ze8xb72xeng0xzu02bb / 182.92.164.251`，Ubuntu22.04，普通运行账户`alexbot`。源码`/opt/alex-bot/releases/<版本>`，`/opt/alex-bot/current`指向当前版本；数据`/var/lib/alexbot`。Node `/usr/local/bin/node`，Python `/opt/alex-bot-runtime/python/app-venv/bin/python`，浏览器`/opt/alex-bot-runtime/browsers`。

电脑关机后，QQ业务与云端早安继续运行。本机配置页、Codex/WorkBuddy调用仍需要电脑和隧道在线。Codex阻塞求助仍由Codex执行，未迁移给QQ agent；模型没有服务器命令、文件、账户或任意收件人权限。

## 密钥与数据保护

| 内容 | 保存方式 |
|---|---|
| QQ AppID/AppSecret、DeepSeek Key、学校学号/密码、LangSmith Key | ECS `.private/credentials.json`、`agent-config.json`、`campus-config.json`、`monitoring-config.json`，AES-256-GCM；目录0700、文件0600 |
| 校园Cookie/storage state | `.private/campus-session.json`，AES-256-GCM；Linux不保留明文持久浏览器profile |
| 加密主密钥 | `/etc/alexbot/master.key`，root0600、目录0700；systemd LoadCredential提供临时只读副本，不放命令行、Git或普通环境变量 |
| 管理/集成运行令牌 | `.private/admin-token` / `integration-token`，随机值、0600；本机副本在当前用户ACL保护的`.private`。这是权限保护文件，**不是加密文件** |
| SSH隧道私钥 | 本机`.private/migration/tunnel-identity.json`，DPAPI CurrentUser；连接期间短暂解密到同一受限目录，认证后删除临时文件 |
| Workbench AccessKey | 本机`C:\Users\Alex\.workbench\credentials.dpapi.json`，DPAPI；CredentialsCmd按需读取。配置仅有helper命令，不含AK；原明文恢复副本已移除 |
| 云端主密钥、管理/集成令牌恢复副本 | 本机`.private/migration/cloud-access.json`，DPAPI；RSA恢复私钥`local-identity.json`同样DPAPI |
| 备份 | 新AES-GCM密钥加密整个包，再用本机RSA公钥封装；云端和本机只留密文备份 |

`.private`、密钥、依赖和测试输出不进入Git。群配置、额度和记忆是权限保护的运行数据，备份包再整体加密。普通Python agent不继承主密钥/凭据环境变量；学校凭据只交给独立采集worker，不进入模型提示词。运行中必然短暂使用明文；拥有root或服务用户执行权限的程序仍在信任边界内，本方案不是KMS或抵御主机管理员的加密。

普通聊天长期记忆只保存校验后的自述片段，不是完整聊天档案；SQLite文件0600、目录0700，字段未额外加密。`backup.mjs`通过SQLite一致性快照纳入整体加密备份。用户可询问“你记得我什么”、按词忘记或清空本对话自己的记忆；不从群背景提取他人资料，不跨群或跨成员回忆。聊天风格与记忆调研见`../docs/chat-research-20261029.md`。

LangSmith保持自动tracing关闭，手动上传白名单性能数据，不包含聊天/prompt/记忆/工具参数或凭据。Key留Node加密配置，不继承给Python，监控失败不阻塞回复。生产连接QQ前完成无模型请求的Python/provider预热；模型HTTP空闲连接复用60秒。诊断数据、配置和验证步骤见`../docs/latency-monitoring-20261029.md`。

API仅监听127.0.0.1:19327，未开放公网管理端口。SSH账户`alexbridge`没有shell、PTY、密码登录、代理转发或任意端口转发，只允许目标127.0.0.1:19327。客户端固定服务器公钥。集成令牌只允许状态及已有通知/图片/天气接口，不能修改账号、权限、暂停或校园设置；目标、白名单和限额仍由发送核心控制。

现有2GiB `/swapfile`已转换为随机密钥dm-crypt交换空间，crypttab/fstab生成开机单元；服务禁用core dump。未重启整台ECS验证启动链，已验证服务实际启动和加密swap。未调整无关安全组或RAM授权。

## 运行与更新

原桌面配置入口继续使用。`start-service.ps1`检测`.private/cloud-mode.json`后只确保SSH隧道；`open-console.ps1`不会启动本机早安。Windows `AlexQQ-Morning-Service`已禁用，`AlexQQ-Cloud-Tunnel`当前用户登录后启动。不要手动在本机运行`node src/server.mjs --connect`或重新启用旧早安任务。

Workbench入口：`D:\Projects\Alex Bot\tools\workbench\bin\workbench-windows-amd64\workbench.exe`，参数`--profile alex-bot -r cn-beijing -i i-2ze8xb72xeng0xzu02bb`。**不能单独运行并打印workbench-credentials.mjs的stdout**，它专供Workbench获取凭据。

云端检查（经Workbench exec执行）：

```sh
systemctl status alexbot.service alexbot-morning.service
systemctl show alexbot.service -p MainPID -p ExecMainStartTimestamp
ss -ltnp 'sport = :19327'
runuser -u alexbot -- /usr/local/bin/node /opt/alex-bot/current/codex-qq-plugin/ops/verify-api.mjs
```

更新：本地测试 → `ops/package-release.py`打包与SHA256清单 → 上传`/tmp/alex-release.zip` → `ops/install-release.py`校验安装 → 安排短暂停机更新服务 → 核对远端实际监听PID、源码版本和启动时刻，以及本机19327的SSH PID。不能只凭health或旧PID文件认定上线。

服务设置`NODE_OPTIONS=--network-family-autoselection-attempt-timeout=1500`，避免默认250ms在到海外预报服务的连接中过早放弃IPv4；HTTP总超时、时效与缺失校验不变。公开接口和学校搜索偶发超时仍返回固定失败码，不做无限重试。

## 备份与回退

`ops/backup.mjs create`在ECS运行，systemd临时提供root保存的恢复公钥，输出`/var/backups/alexbot/alexbot-<时间>.json`：

```sh
systemd-run --wait --collect --uid=alexbot --property=LoadCredential=backup.public:/etc/alexbot/backup-public.pem /usr/local/bin/node /opt/alex-bot/current/codex-qq-plugin/ops/backup.mjs create
```

密文下载到本机`.private/migration/`后，在codex-qq-plugin目录验证：

```powershell
node ops/backup.mjs verify '<备份文件绝对路径>' 'D:\Projects\Alex Bot\codex-qq-plugin'
```

验证在内存解密，核验原四份加密配置及存在时的LangSmith配置可恢复，不打印密钥或写明文。已保存迁移快照；本轮未新增自动备份定时器。恢复需对应源码/依赖、密文备份和本机DPAPI恢复身份。DPAPI绑定当前Windows用户：仅复制JSON到新电脑不能解密，重装Windows前须安排恢复材料迁移。

紧急回退先停云端alexbot-morning和alexbot，确认不再连QQ，再停本机隧道和任务。依据`.private/migration/`中保存的旧令牌、原Windows DPAPI配置和迁移前暂停状态恢复；移除cloud-mode后才启动本机Bot。**不要直接覆盖迁移前旧state**：上线后的权限、计数、幂等和缓存可能已变化，须先取云端最新状态。旧早安只在云端已停且最新claim同步后恢复。恢复操作只供维护者，不开放给聊天模型。

## 验收

响应监控与预热维护：Windows Node423项通过；Linux完整回归416项通过、5项平台测试跳过，最终监控相关补充回归33项通过；两端Python185项通过。基线及优化后真实模型合成评测、监控配置和隐私范围见`../docs/latency-monitoring-20261029.md`。以下为此前迁移时的历史验收。

Windows Node398项通过；Linux Node393项通过、5项Windows专用测试跳过；Linux Python138项通过，包含真实LangChain跨语言协议回归。

云端真实验证三份加密配置、学校158间教室JSON、全天/即时图、DeepSeek聊天/余额、固定换算、天气、48小时CAMS、雷达和早安运动图；已检查中文和橙色版式。正式systemd权限下校园查询及加密session重用已验证。

用户在切换后的本人QQ确认全天图、当前推荐图和普通聊天三项正常。切换前后计数54不变，验收后58、无不确定投递；当日早安claim保留，没有因迁移重发。跨夜08:00触发和整机重启尚未实际验收。
