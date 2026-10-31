# ECS 运行与密钥交接

2026-10-29 已迁移。开发工作区仍为 `D:\Projects\Alex Bot`，GitHub 仅在用户明确要求时更新。

## 2026-10-31 QQ单次拒发导致全局停发（修复已上线，待群内复测）

23:09群天气请求已完成模型/工具阶段，发送阶段被QQ明确拒绝，旧BridgeCore将其归类PLATFORM_REJECTED并全局暂停；WebSocket仍connected，非断线、非模型掉线。旧诊断未保留具体业务码，不能断言QQ拒发的具体原因。现仅将明确消息/目标拒绝改为不全局暂停，保留不重试、计数及幂等；鉴权、平台限流、内容拒绝、致命、投递不确定和存储异常仍保持原暂停保护。Adapter新增可选lastSend脱敏诊断，仅记录时间、作用域、阶段、固定错误类别及HTTP/业务数字码，不记录内容、身份和密钥。

源码`2ec7167`，生产`linux-33e5b37f66f6`；主PID72564于2026-10-31 23:16:43 CST启动，早报PID72582，本机SSH PID35300。Windows/Linux相关117项回归通过；源码清单、实际监听、argv及源码先于启动核验。仅恢复本事故PLATFORM_REJECTED造成的暂停，不覆盖人工暂停。connected、paired、未暂停，计数15→15、无不确定投递，名单、限额、07:30规则及每日claim保持。已请用户在原群复测天气图。23:17只读检查已记录两次新请求成功投递（约1.3/1.4秒），计数17、connected且未暂停；尚未获得用户对天气图片实际收图的确认。

备份`alexbot-20261031T151552008Z.json`已本机内存验证19文件可恢复，旧release及`source-linux-b14a086d169c-before-outage-20261031T151643Z.tar.gz`保留。未推送GitHub；未完成定时提醒保留工作区，未进入提交或部署包。

## 2026-10-31 明天天气自然语言路由修复（已上线）

用户原句“大肥鱼 明天北京什么天气”曾返回unsupported_time。根因是两日天气图已覆盖明天，但Python工具描述、系统提示及确定性时间校验仍拒绝明天；与蓝色主题变更无关。现已同步修正：今天、明天、明早/明晚和未来两日可调用同一48小时图，历史/后天/更远日期仍拒绝，雷达仍仅当前观测；显式日期支持月末/年末滚动。

源码`ec30473`，生产`linux-b14a086d169c`；主PID72294，2026-10-31 23:07:06 CST启动，早报PID72312，本机SSH PID35300。源码清单、实际监听、启动时刻/argv及源码先于启动已核验。connected、paired、未暂停，计数13→13；两白名单群、运行配置及早报claim保持。Windows Python48/Node22通过；Linux Python48/Node36通过；真实模型在合成白名单群上下文正确将原句选为weather_image并生成317139字节图片，未发送QQ测试。

备份`alexbot-20261031T150506768Z.json`已在本机内存验证19文件可恢复，旧release及`source-linux-8bb44d1fce41-before-weather-route-20261031T150705Z.tar.gz`保留。仅本地Git，未推送GitHub。定时提醒需求按用户“先等下”暂停，尚未修改提醒功能代码。

## 2026-10-31 蓝色控制台与新 Logo（已上线）

用户要求提交并部署原本留在工作区的界面改动。源码提交`73c46c8`，生产`linux-8bb44d1fce41`，包含蓝色控制台/指南样式、PNG Logo及来源说明、PNG静态路由与正确MIME。未推送GitHub。

Windows与Linux控制台各14项测试通过。主服务PID71859于2026-10-31 22:59:25 CST启动，早报PID71877；源码清单、实际监听、argv及源码早于启动均核验。SSH隧道PID35300，启动13:58:30 +08。经本机隧道读取页面已确认蓝色变量、PNG引用、image/png及Logo SHA256一致。服务connected、paired、未暂停；发送计数10→10、无不确定投递，运行配置和每日早报claim保持一致，未发送QQ测试。

切换前加密备份`alexbot-20261031T145741603Z.json`已保存云端与本机受保护恢复目录，内存验证19文件及密钥配置可恢复、未写明文。旧release和`source-linux-3b543066a571-before-console-blue-20261031T145925Z.tar.gz`保留可回退。Workbench download本轮失败，改经已认证exec传回密文并验证成功。

## 历史：两日风力与最大阵风（2026-10-31）

`linux-3b543066a571`，源码`fc5d920`；主PID71624，22:49:58 CST启动，早报PID71643，本机SSH PID35300。标题中间显示今明两日“主要风向 n–m级 · 阵风最大k级”，来源ECMWF/Open-Meteo；独立阵风字段按原生3小时窗口归入日期。计算在受限Python LangChain工具，固定stdio桥接仅传公开数值。Windows35/Linux45项相关回归及真实48小时天气/早报实图通过，计数10不变，配置/claim保留。最终备份`alexbot-20261031T144637734Z.json`已验证可恢复，旧源码/版本保留，本轮未推送GitHub。详细回执见HANDOVER。

## 历史：温度数值标注（2026-10-31）

`linux-159e04b54374`，源码`cd75b96`；主PID71071，22:37:22 CST启动，早报PID71088。气温和体感每6小时及末小时标数值，并标高低温，双城市适当减少密度；含碰撞避让与引导线。云端42项回归和真实图验证通过，配置/claim保持，计数10不变。备份`alexbot-20261031T143616205Z.json`已验证可恢复，旧源码及release保留，未另同步GitHub。详见HANDOVER。

## 历史：体感温度叠加（2026-10-31）

最新版本`linux-7aaa3509aa6c`，源码`e174e9e`，主服务PID70825于22:33:09 CST启动，早报PID70843，本机SSH PID35300。温度图新增淡色半透明体感温度虚线，来源为ECMWF数据经Open-Meteo派生；48小时字段、图例及早报实图已验证，云端42项回归通过。计数10→10，原配置与每日claim不变。备份`alexbot-20261031T143210197Z.json`已验证可恢复，旧release保留，本轮未推送GitHub。详细记录见根目录HANDOVER。

### 前版曲线修复记录

当前生产`linux-510fdf406d1a`，运行源码`9b5868a`。主服务实际监听PID69425，17:26:05 CST启动；早报PID69442。源码SHA256清单、argv、源码早于启动、云端19327端口及本机SSH PID35300均已复核。天气固定当天00:00至次日24:00，共48小时，包含ECMWF总云量，四行分别标明来源；双层日期轴与轻虚线保留。最新修复云量100%、PM2.5峰值及零值曲线被边缘裁切：纵轴留白、4px受限笔画溢出和monotone保形插值，数据与刻度范围不变。早报复用绘图，不改变07:30白名单群及三号楼推送规则。

本轮Windows/ECS相关31项回归通过，云端公开预报/真实LangChain调用及早报图验证正常，未另发QQ测试；前版完整回归为Windows Node468/Python262、Linux Node463通过/5项平台专用跳过/Python262。聊天规则、限额、名单及当日claim保留，最新切换前后计数6不变。备份`alexbot-20261031T091941002Z.json`已本机内存验证19文件可恢复；旧源码`source-linux-df983293b1fd-before-curves-20261031T092605Z.tar.gz`及旧release保留。天气四联图上一轮已按用户要求同步private GitHub；本轮裁切修复未另推送。详细回执见根目录HANDOVER最新记录。

## 功能与运行位置

| 部分 | 当前运行位置 |
|---|---|
| QQ官方SDK、配对、白/灰名单、前缀、限额与图片发送 | ECS `alexbot.service` |
| DeepSeek聊天/余额、LangChain换算、生活费与运动规则 | ECS Node → Python worker |
| 学院路全部教室JSON、全天图、即时推荐与记忆 | ECS独立校园worker、Chromium与中文字体 |
| 普通聊天偏好、成员沟通习惯、媒体摘要与衰减情绪 | Python LangChain + `.private/chat-memory/chat-memory.sqlite3`，按私聊/群及成员隔离；具体限额见根目录HANDOVER |
| 图片理解与可选语音识别 | 独立Python媒体worker；DeepSeek Flash视觉；QQ自带转写优先，百炼付费ASR缺省关闭；`/social`加密配置 |
| 天气、CAMS、雷达和增强早安图片 | ECS；异常仍明确缺数据，不补造数值 |
| 北京时间07:30白名单群早报与三号楼图 | `alexbot-morning.service`；保留每日claim，避免重复补发 |
| 本机设置页、Codex MCP、WorkBuddy发送 | 本机127.0.0.1:19327 → 受限SSH → ECS回环端口 |
| 本地响应耗时与可选LangSmith | Node只记录数值和固定阶段；第07节管理，`.private/monitoring-config.json`加密Key，`.private/telemetry/recent.json`最多50条 |

ECS：`cn-beijing / i-2ze8xb72xeng0xzu02bb / 182.92.164.251`，Ubuntu22.04，普通运行账户`alexbot`。源码`/opt/alex-bot/releases/<版本>`，`/opt/alex-bot/current`指向当前版本；数据`/var/lib/alexbot`。Node `/usr/local/bin/node`，Python `/opt/alex-bot-runtime/python/app-venv/bin/python`，浏览器`/opt/alex-bot-runtime/browsers`。

电脑关机后，QQ业务与云端早安继续运行。本机配置页、Codex/WorkBuddy调用仍需要电脑和隧道在线。Codex阻塞求助仍由Codex执行，未迁移给QQ agent；模型没有服务器命令、文件、账户或任意收件人权限。

## 密钥与数据保护

| 内容 | 保存方式 |
|---|---|
| QQ AppID/AppSecret、DeepSeek Key、学校学号/密码、LangSmith Key、可选百炼ASR Key | ECS `.private/credentials.json`、`agent-config.json`、`campus-config.json`、`monitoring-config.json`、`social-config.json`（保存新设置后创建），AES-256-GCM；目录0700、文件0600 |
| 校园Cookie/storage state | `.private/campus-session.json`，AES-256-GCM；Linux不保留明文持久浏览器profile |
| 加密主密钥 | `/etc/alexbot/master.key`，root0600、目录0700；systemd LoadCredential提供临时只读副本，不放命令行、Git或普通环境变量 |
| 管理/集成运行令牌 | `.private/admin-token` / `integration-token`，随机值、0600；本机副本在当前用户ACL保护的`.private`。这是权限保护文件，**不是加密文件** |
| SSH隧道私钥 | 本机`.private/migration/tunnel-identity.json`，DPAPI CurrentUser；连接期间短暂解密到同一受限目录，认证后删除临时文件 |
| Workbench AccessKey | 本机`C:\Users\Alex\.workbench\credentials.dpapi.json`，DPAPI；CredentialsCmd按需读取。配置仅有helper命令，不含AK；原明文恢复副本已移除 |
| 云端主密钥、管理/集成令牌恢复副本 | 本机`.private/migration/cloud-access.json`，DPAPI；RSA恢复私钥`local-identity.json`同样DPAPI |
| 备份 | 新AES-GCM密钥加密整个包，再用本机RSA公钥封装；云端和本机只留密文备份 |

`.private`、密钥、依赖和测试输出不进入Git。群配置、额度和记忆是权限保护的运行数据，备份包再整体加密。普通Python agent不继承主密钥/凭据环境变量；学校凭据只交给独立采集worker，不进入模型提示词。运行中必然短暂使用明文；拥有root或服务用户执行权限的程序仍在信任边界内，本方案不是KMS或抵御主机管理员的加密。

普通聊天记忆保存校验后的自述、表达统计、有重复证据的沟通习惯、有限媒体摘要及会衰减的情绪线索；授权群未唤醒时也按成员观察，不保存完整聊天原文或媒体文件。SQLite文件0600、目录0700，字段未额外加密。`backup.mjs`通过SQLite一致性快照纳入整体加密备份。用户可询问“你记得我什么”、按词忘记，或用`/记忆 查看/关闭/开启/清空`管理自己当前对话分区；不跨群或跨成员回忆。情绪推断可能误解，不作为人物事实；具体衰减及保留限额见根目录HANDOVER。聊天风格与记忆调研见`../docs/chat-research-20261029.md`。

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

## 已启用的多模态与成员记忆（2026-10-30）

用户明确要求备份旧版后上线，当前生产`linux-a26f058f2340`；生产PID、启动时刻、源码清单与本机SSH隧道均已核验。用户已确认图片等功能、话题切换/口吻及本人QQ原生语音接话正常，本轮验收完成。按用户反馈，聊天先通过受限工具提交话题延续与语气判断；模型可见字段必填，旧的确定性调用保留可选参数默认值。普通续聊直接发送校验后的回复；换话题且有旧背景时先移出旧对话/旧图，再根据本轮输入及稳定偏好生成，失败不发送旧草稿，长期记忆保留。Node452/Python251本地通过；Linux聊天/跨语言52项和完整Python251通过，真实模型已验证有口令及无口令的话题切换。空行清理保持。LangSmith普通续聊可能只有router_model，新话题独立生成或记忆表达才有chat_model。当前语音复用QQ转写，百炼ASR未启用，不需要新增Key；若QQ未附转写则明确提示配置可选备用。完整最终证据、回滚材料和实际进程以根目录HANDOVER最新记录为准；后续维护先读实际状态，不单凭文件存在认定版本。

新配置入口`/social`，用`open-setup.ps1 -Page /social`进入；付费语音缺省关闭，Qwen3-ASR-Flash北京区。图片复用DeepSeek Flash。Key在Node平台加密存储，传Python仅走私有stdin管道；不写argv、模型提示词或日志。原媒体不存盘，SQLite保存有界摘要、沟通习惯与衰减的情绪线索，仍纳入原一致性加密备份。白/灰名单和暂停继续在Node鉴权。

用`ops/evaluate-social.mjs`可在systemd LoadCredential环境做真实模型合成样本评测（不发QQ、不读取群友内容）。需要先跑测试再评测，不以HTTP在线替代QQ媒体验收；语音无Key时优先使用SDK自带转写，没有则明确不可用。来源接口、模型输出结构和QQ附件域名都可能变化，失败不编造观察结果。

## 历史上线记录：公开服务状态与滑动变祖器（2026-10-30）

最新生产`linux-62ec608eb101`，主服务PID63918，22:07:30 CST启动，早报PID63936；源码清单、实际端口/argv及源码早于启动已核验。本机仍为SSH PID7236。最新补充“大肥鱼=DeepSeek”的别称：`大肥鱼 大肥鱼还活着吗`、直接@后询问存活/故障/恢复均可查询状态，普通招呼仍聊天。常见问法直接调用固定工具，不依赖模型；更灵活表达由agent语义选择。本轮定向Node39/Python29、云端精确例句无模型图文实查及4条真实模型合成路由通过。聊天规则文件哈希、07:30规则、名单和限额保持；前版完整回归及本人QQ图文同条验收仍见根目录HANDOVER历史记录。

`查DeepSeek状态`与`查滑动变祖器状态`（也支持“变阻器”）无Key直接调用受限Python LangChain工具；自然语言由既有agent选择。本人与白名单开放，灰名单拒绝。前者使用DeepSeek官方状态，后者只读原站API实时评分，按固定作者提交的0–30档素材生成图片，附来源。新独立worker不接触模型/校园密钥，也没有任何QQ收件人或通用命令接口。

Linux需系统`/usr/bin/curl`（ECS已安装），只读固定HTTPS接口；仅在该域名DNS实际返回的至多两条公网IPv4间有限切换，保留TLS验证。只读取API前部当前数值，避免下载历史事件流。静态素材目录`.private/public-status-frames`按SHA256校验，可在运行账户工作目录执行`python <源码>/codex-qq-plugin/ops/prewarm-public-status.py`重新获取；素材不是运行密钥，不进Git或密钥备份。每次状态重新查，不以缓存数值作实时回复。

仅新增内部可选`richMedia=true`，让腾讯`msg_type=7`同次携带`content`与`media.file_info`；默认兼容原纯图。两处来源链接仍受QQ后台消息URL配置约束。失败不自动重发，沿用原暂停及幂等规则。详见根目录HANDOVER的新记录。

本次加密备份`alexbot-20261030T130018635Z.json`在云端和本机受保护恢复目录均保留，本机已内存验证18文件可恢复。旧release及`source-linux-a26f058f2340-before-public-status-20261030.tar.gz`保留可回退。不更新GitHub，无关本地界面/素材改动未纳入本次部署。

别称更新前另有加密快照`alexbot-20261030T140549150Z.json`及源码备份`source-linux-9a3bb6dba221-before-deepseek-alias-20261030.tar.gz`，本机密文副本已验证可恢复。只记录本地Git，不更新GitHub。
