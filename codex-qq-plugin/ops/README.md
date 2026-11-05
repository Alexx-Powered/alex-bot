# ECS 运行与密钥交接

2026-10-29 已迁移。开发工作区仍为 `D:\Projects\Alex Bot`，GitHub 仅在用户明确要求时更新。

## 2026-11-03 恢复 QQ 官方 Bot（当前生产）

地图确认过程的基线 `linux-wxmap-62fc72e4f7e0` 的[确认版审核交接](../docs/天气地图确认版审核交接-20261104.html)包含线上同版画面、官方原图对照和逐项审核编号。由用户明确通过相应范围后，按根目录 AGENTS.md 的确认版流程直接部署并记录结果。

**2026-11-04 地图发布。** 本轮地图及 FID 368 沿河调整已由用户确认并上线，具体通过范围见确认记录；后续新增地图改动仍按开发约定核对。所有地图部署均需在切换前对候选和现行插件目录运行 `ops/map_review.py`，包括临时补丁发布。常规安装需将 `ops/install-release.py` 与同目录 `map_review.py` 一起提供。发布凭证应与全部地图资产的 SHA256 一致。官方图幅、阿里云比对和待核地段见 `docs/map-boundary-audit-20261104.md` 和 `data/weather-boundary-review.json`。

本轮确认的用途包括公开群、频道及对外发布。政府原图的十个海上符号、克什米尔地区界与印巴停火线已进入本地校核图层。原图像素和曲线可用 `python scripts/verify-registered-map-ink.py` 复算。逐段结果在 `docs/map-regional-registration-20261104.md`。发布检查拒绝仍含 `review_` 图层的候选。

官方通道的动态云图、PM2.5、降水和温度视频使用 1080×1080 全幅地图，12 fps 播放。云量默认使用预报；云量、温度、降水和 PM2.5 可查询未来 24 或 48 小时。明确请求历史云图时，才收录近六小时可用的卫星观测；缺测跳时，时次过渡不代表新增观测。固定命令直接调用受限 LangChain 工具。PM2.5 使用 air 权限，其他使用 weather。ECMWF IFS 与 CAMS 原始格点优先，点位降级成片明确标为简略版。部署须包含绘图模块、`weather_video_worker.py`、`weather_video_codec.py` 和 Node 视频桥。绘图子进程先写私有目录中的无损编号帧并退出，再用 `imageio-ffmpeg==0.6.0` 单线程编码和核对 MP4 样本数。官方媒体只上传发送一次。时限和资源验证见 `../docs/weather-video.md` 与 HANDOVER 最新一节。

同时发布 `python/weather_map.py`、`python/weather_ground.py`、`data/weather-map.zip`、`data/weather-ground.sqlite3` 和两份 NOTICE。前一数据包提供国界与地名，后一空间索引库提供市界、省界、水域与浅地形阴影。相邻行政区的共边只存一次，跨省线段加粗。湖海按原有填色加深，岸线无独立描边。只有开发机需要原始 GIS 数据及构建依赖，ECS 只读取当前视口。温度、PM2.5 和降水保留参考 Windy 的色阶，卫星使用红外灰度。

区域视频还需 `data/weather-video-regions.json`、`data/weather-region-masks.zip` 和 `python/weather_regions.py`。词表与遮罩由 `scripts/build-weather-regions.py` 对同版 CTAmap 原始市级多边形离线生成。固定指令和自然语言工具共用目录，按区域 ID 区分缓存，并核验返回视口包含所选区域。发布前分别用一个跨省卫星区域和一个大省逐小时预报验证实际取景、卫星瓦片与成品帧数。

20 秒超时排查已确认发生在模型阶段，同期 DeepSeek 官方公告 API 部分中断；无本机 OOM/内存限流，生产上限保持 1500M。最新响应优化版本以 HANDOVER 首节为准：Python 对现有地名目录中的明确天气/空气/雷达请求直接调用原 LangChain Tool，未知、否定、复合、指代仍交模型；不绕过逐群权限或发送限额。动态可信上下文移至系统提示末尾，提高固定前缀复用；模型等待统一 30 秒，仍不自动重试超时。部署需同时包含 `python/quick_weather_route.py`、`agent_worker.py`、`model_transport.py` 和 Node 超时提示；地名目录仍为 `data/weather-locations.json`。单个模型请求仍可能因供应商异常失败，内存扩容不能修复其接口故障。

户外指数按用户确认的 v3 自定义规则，由 `python/outdoor_index.py` 受限 LangChain Tool 计算，上午/下午取高分。普通单城市天气与早间天气共用，明天天气对应查询第 1 日；缺测或未定义天气类型不推算评级。新版狂草素材、金色档位、卡片镂空及无损条带 PNG 编码须整体发布，渲染调用需 `await`。详细规则见 `../docs/outdoor-index.md`，当前 release 和验证记录以 HANDOVER 最新节为准。

天气摘要图形由同一次 ECMWF 响应的 `daily.weather_code`、请求第 1 日日期匹配。固定映射在 Python LangChain `weather_summary`，复用 `wind_brief.py` 的可选 `weather` 包并保留旧风速协议。发布必须同时包含 `weather.mjs`、`wind-summary.mjs`、两个 Python 模块、天气渲染器及 `public/weather-report/conditions/` 八个 SVG；缺失日代码显示缺数据，不能用第二天或 PM2.5 猜图形。普通天气和早报共用，无新增定时订阅或模型请求。

新版帮助图已上线（`linux-help-page-25722e38d870`，后续以 HANDOVER 最新版本为准）。官方群 @ 或启用唤醒词后发送 `/help` / `帮助` / `菜单`；主人私聊 `/help`。只显示该会话已开的功能、实际唤醒词和已订阅的 07:30 项目，chat 关闭仍能查看帮助并显示红字。固定生成图片、不请求模型，额度检查在绘图前，默认不主动发送验收消息。渲染器及同目录天气目录须一并发布，保留控制台 `public/logo.png`。

官方版新版控制台采用分栏和 Apple 风格开关。快速匹配流程为：添加群 → 填备注 → 生成并复制指令 → 在目标群 @ 机器人发送 → 控制台确认并保存所选权限；匹配只捕获候选，不发群消息、不自动授权，不要求群成员 OpenID 等于主人私聊 OpenID。群名是备注，不能将数字 QQ 群号当作官方 group_openid。旧口令 API 的可选参数缺省行为保持兼容；新版界面始终提交明确的基础权限表，新群默认展示聊天与固定换算。

全局“唤醒词”及群页的词库操作使用同一 revision 和固定词 ID，新增/改名/删除影响全部群，各群开关独立保存。改名不重置开关，允许空词库，全部关闭仍可 @。官方 SDK 的普通消息/@ 副本去重使用当前群词库。群功能实际在 Node 和 Python 工具边界执行，不是仅隐藏界面；关闭权限立即使旧请求失效。天气与空气合并显示，固定换算独立展示；AI服务状态、DeepSeek余额及逐群早间日报沿用新名称。

逐群定时推送由官方单元 `alexbot-group-morning.timer` / `.service` 调用 `/api/group/morning/run`，与所有已屏蔽 OneBot/旧调度单元隔离。群页的“早间天气”（天气、空气与户外指数）和“三号楼自习简报”分别开关，均为每天北京时间 07:30；未开启的项目不生成、不发送。两项默认关闭，保存后从下一个 07:30 生效。旧 `morningReport` 合并开关的明确同意兼容映射到两个开关，旧 `notifications` 广播权限不授予任何定时订阅；旧 API 和 Python 参数形状保持兼容。

Persistent=false、不补发，执行窗口 07:30–07:45，保留逐群逐图的原幂等键及发送限额，不因拆分重新发送已投递的图片。关闭单项会取消该项在途结果，另一项仍可发送；关闭后重新开启不能复活旧结果。一项生成失败不抑制另一项，投递不确定仍暂停并停止剩余发送。旧增强配置及旧官方调度继续关闭，不因升级新增订阅。

升级前先备份最新状态、暂停排空并仅重启 `alexbot.service`。全局词库可从退役状态单独恢复；不得导入其中的 ownerId、群 ACL、数字身份或群开关。保留所有最新投递、模型预算、记忆和配置。回退新状态时必须先保全词库及逐群权限并显式迁移，不能用不认识新群权限的旧代码直接打开发送。

用户因封号要求退出 OneBot。官方接入的回滚基线为 `linux-10443702394a`、源码 `e0c356c7828572b78894619ecf5e076009e97bac`，当时 266 个文件哈希全部通过；新版界面在此官方基线上移植，具体发布版本见 HANDOVER。`alexbot.service` 显式使用 `QQ_TRANSPORT=official`，原 AppID/AppSecret、主人 OpenID 和两个官方白名单群保持。OneBot 的业务、网关、登录控制、试运行及其早报 service/timer 均 disabled/masked，不得为调试解除或重新扫码。旧 `alexbot-morning.service` 和增强配置仍关闭，逐群日报改用上文独立的官方单元，默认全部关闭。

本机分支 `codex/official-bot-rollback-20261103` 以官方源码为基线，`codex/onebot-migration` 保留 OneBot 阶段提交。未完成提醒和其它本地工作不纳入部署，未推送 GitHub。当前使用官方群身份及新版控制台、全局唤醒词与逐群功能；OneBot 扫码功能不移植。最新运行数据仍有云端及本机密文备份，不将 OneBot 数字账号授权套用到官方 OpenID。

回滚先停全部新链路，制作 21 文件标准加密备份以及完整运行目录加密快照。官方授权取自切换前冻结状态，投递/发送尝试/去重记录与最新状态合并；184 条投递、50 条尝试、152 个入站去重键进入恢复计划，无未决投递。模型预算、聊天记忆、模型和校园配置、管理/集成令牌及发送规则保持最新。回滚操作和回执在 root 专用 `/var/backups/alexbot-official-rollback/20261103`，完整密文为 `onebot-full-before.json`；对应本机密文在 `.private/migration`。不要直接覆盖最新 state 或把旧 OneBot 服务作为故障回退。

维护按 AGENTS.md 的 2G 主机预算执行：全量测试默认本机，ECS 仅做受限专项；已退役的 OneBot 会话检查不适用于官方服务。发布时检查实际 `alexbot.service` 的 19327 监听 PID、argv、源码清单和启动时刻、本机 SSH 隧道及官方连接/配对/暂停/未决投递。具体进程、备份哈希与本轮验证限制见 HANDOVER。

## 2026-11-02 普通 QQ 账号接入试运行

本次 GitHub 回退标签为 `ecs-pre-onebot-20261102`，指向与 ECS 255 个发布文件一致的 `9787355`。私有仓库 main 的 `bfb1ada` 另含上线记录。云端和本机均保留加密状态包 `alexbot-20261102T021203325Z.json`，本机已在内存验证 21 个文件和凭据可恢复。云端源码归档为 `source-linux-5e4d642a771d-before-onebot-20261102T021203Z.tar.gz`。

业务桥默认使用官方 SDK。候选 OneBot 传输只读取 systemd 的 `onebot.json` 凭据，逐次核对登录身份、在线状态和回执。身份、限额与发送历史绑定运行状态。试运行使用独立目录，禁止复制旧 OpenID 白名单。只收验证程序 `ops/onebot-probe.mjs` 只统计带一次性试运行口令的私聊和群事件。它不调用业务工具、不写聊天记忆。群权限和主人须通过绑定流程重新确认。

网关固定 NapCat v4.18.42、QQ 53644 amd64。维护者用 `ops/stage-onebot-gateway.py fetch` 下载，完成 SHA-256 验证后运行 `stage`，再运行同一发布目录的 `ops/configure-onebot-gateway.py prepare`。服务账号为 `alexqqgw`，WebUI 关闭，OneBot 仅在 `127.0.0.1:19328` 提供受令牌保护的服务。下载可断点续传，源码发布包从当前 Git 提交生成。

网关准备好后，主人在 Windows 运行 `scripts/set-onebot-account.ps1` 录入专用号，再由维护者或主人运行 `scripts/start-onebot-login.ps1` 取当次二维码。在手机 QQ 核对账号并授权。号码在本机使用 DPAPI，在交接命令中使用短期 RSA-OAEP 密文。二维码只写本机受保护的恢复目录。已有登录窗口可加 `-QrOnly` 读取新鲜图片。登录等待上限为 150 秒，服务没有自动重启。先核对失败原因再由主人重新发起。

这台 2 核 2G ECS 的试运行门槛为启动前可用内存至少 600 MiB。试运行每 3 秒采样，可用内存连续三次低于 300 MiB、一次低于 192 MiB、持续换出或出现 OOM 时，先停网关。诊断摘要在 `/run/alex-qq-gateway/health.json`。只收握手、实际私聊和独立测试群确认后才进入 limited，最多一个群，按目标每分钟 3 次、按请求人 2 次、全局最多 6 次、每天最多 100 次，预留 10 次通知。试运行关闭广播及生产记忆。

正式切换前暂停并清空旧发送队列，制作新备份。逐个验证新旧目标身份、未决投递、已用额度、当日早报 claim、记忆关闭与删除记录。未完成对账时保持原生产服务和早报为唯一发送方。恢复旧链路也使用停发时的最新记录。至少观察一次 07:30 周期及校园抓取高峰，记录最低可用内存和换页情况后再扩群。

## 2026-11-01 全球雷达与国内缺图自动回退（已上线）

默认radar_image先取中央气象台，目标不在目录、无当前图或图过期等情况下自动尝试RainViewer全球拼图；有多个国内站名匹配时仍要求澄清，不猜位置。新增可选source=global，旧调用省略参数仍为auto。支持自然语言海外地名，“发 雷达 纽约”“发全球雷达 东京”“发 雷达 全球”“全球雷达图”。全球视图与区域图同条发送图片、简短来源；灰名单权限不变，国内原图保持原样。模型提示已明确雷达不限中国，并清理此前残留的“天气仅当天”冲突句。

新业务由受限Python LangChain global_radar_image实现，仅target地名参数，无URL/路径/命令/凭据/收件人。固定RainViewer清单、雷达/覆盖瓦片与Open-Meteo地理编码域名，禁止重定向/未知host/path；验证最新拼图帧60分钟时效。透明覆盖区与缺测区分开处理，灰纹明确表示无覆盖，不把无覆盖当作无降水；帧时间标明北京时间，非单站统一观测时刻。全球图1080×1370含回波图例、查询位置和来源。全球worker90秒、外层radar工具阶段150秒；单次公网请求10秒，有超时提示。Node仅路由、图像验证与QQ发送。

底图优先OSM，仅加载当前视口瓦片，独立UA，缓存至少7天，缓存512项上限；缓存过期清理不提前删除7日内瓦片。ECS无法访问OSM瓦片，已加入公有领域Natural Earth 1:50m海岸线+国家名位置底图，坐标与雷达同为Web Mercator；底图失败只替换底图，不替换回波或覆盖数据。失败后一小时内不重复请求OSM。来源/上游SHA256在data/global-radar-base-NOTICE.txt。RainViewer要求署名、无Key及免费个人用途条款已核对：https://www.rainviewer.com/api/weather-maps-api.html；底图条款：https://www.naturalearthdata.com/about/terms-of-use/。

当前生产`linux-5e4d642a771d`，源码`9787355`（功能首提交11b738b）；主PID81523于2026-11-01 22:19:00 CST启动，早报PID81541，本机SSH PID44864。源码清单、实际监听、argv、源码早于启动均核验，connected/paired/未暂停、计数18→18、无不确定投递；两白名单群、配置、限额、07:30规则与每日claim保持。Windows Node482/Python274（海岸线补充后专项5项通过）；首候选Linux完整Node477通过/5项Windows专用跳过、Python274；最终候选相关Node70、完整Python275通过。真实模型、真实跨语言及纽约/东京/全球图片、模拟国内NOT_FOUND后实际全球回退均通过，无QQ测试发送；云端东京海岸线版下载后已目视核验，图片/坐标/署名正常。实际QQ收图仍需用户使用新命令确认。

最新备份`alexbot-20261101T141540561Z.json`已本机内存验证20文件可恢复；旧release及`source-linux-e47eeccc6667-before-global-radar-20261101T141900Z.tar.gz`保留。未推送GitHub；提醒仍暂停且未纳入本次提交或部署，其tracked补丁保存位置见上一记录，恢复时须合并server等最新修改。

## 2026-11-01 分环节超时提示（已上线）

用户要求超时失败时明确提示具体原因。新增固定阶段/时限文案及安全超时元数据：区分模型20秒、预报/定位15秒、雷达10秒、Python任务的实际60/120/210等时限、校园页面25秒/教室接口20秒/登录等待40或交互150秒/页面操作3秒、余额接口每次8秒、媒体下载10秒/视觉和ASR模型20秒、记忆任务10秒和风速计算10秒。仅实际超时使用超时措辞，不把普通网络、鉴权、格式错误伪称超时；不显示上游错误原文或凭据。天气部分源超时仍发送可用图，同条富媒体文字说明缺失原因；校园失败保持JSON并附安全message。后台观察/监控不额外发群消息。

QQ上传超时且确认尚未提交消息时，使用独立幂等键尝试一次文字提示，不重发图片；消息已提交后超时仍属投递不确定，保留暂停及去重保护，无法保证再通过QQ发送提示。未设置统一端到端时限，本轮不改变原有各环节时间限制。未完成提醒功能不在提交/部署中。

源码`7a374fe`，生产`linux-e47eeccc6667`；主PID79917，2026-11-01 21:36:49 CST启动，早报PID79935，本机SSH PID44864。源码清单、实际监听/argv、源码先于启动核验。connected、paired、未暂停，计数14→14、无不确定投递；两白名单群、限额、07:30规则与每日claim保持。Windows Node480/Python269通过；Linux Node475通过、5项Windows专用跳过，Python269通过；真实Python进程短时限触发与之后正常LangChain固定换算均验证，无模型请求/QQ测试发送。云端验收初次缺QQ_PYTHON路径，补齐生产固定路径后全量通过；全量耗时超过Workbench60秒窗口，最终独立回执核验通过。

备份`alexbot-20261101T133046002Z.json`本机内存验证20文件可恢复；旧release及`source-linux-19d649813824-before-timeout-notices-20261101T133649Z.tar.gz`保留。仅本地Git，未推送GitHub。暂停的提醒tracked补丁保存在忽略目录`codex-qq-plugin/test-output/timeout-notices/paused-reminders.patch`，旁边有core/python-agent/server/backup完整.paused副本；未自动重新应用，恢复开发前须与当前超时修复合并检查，禁止直接覆盖新文件。提醒独立源码仍为未跟踪文件。

## 2026-11-01 明天气象图改为明后两日（已上线）

按用户要求，“北京明天天气”现在展示明天00:00至后天24:00；未指定日期/今天保持今天与明天。受限LangChain weather_image新增可选day=today|tomorrow，旧调用省略参数仍默认today。自然语言明天/明早/明晚及明天ISO日期由Python固定传递tomorrow，避免模型漏掉可选参数。Node只按有限day选择既有天气/CAMS采集及绘图；实际获取时间及模型新鲜度仍使用真实now，不通过伪造now移动日期。温度/体感、降水、云量、CAMS PM2.5、风力简报及所有日期文字一同平移。每日07:30早报默认不变。

生产`linux-19d649813824`，源码`127157c`；主PID77915于2026-11-01 21:12:49 CST启动，早报PID77934；源码清单、实际监听/argv、源码早于启动均核验。connected、paired、未暂停、计数13→13、无不确定投递；两白名单群、限额、配置及每日claim保持。Windows Python49/Node52通过；Linux Python49/Node53通过。云端真实模型原句路由和真实LangChain执行产生48小时天气+CAMS图：2026-11-02 00:00至2026-11-04 00:00（即11月3日24:00），图已下载目视核验日期/明天后天/风速文字及曲线。未发送QQ测试。

备份`alexbot-20261101T131107793Z.json`已本机内存验证20文件可恢复；旧release及`source-linux-33e5b37f66f6-before-weather-start-20261101T131249Z.tar.gz`保留。发现本机19327隧道未运行，已通过既有start-cloud-tunnel恢复受限SSH，实际PID44864、21:13:21 +08启动，无本机Bot。未推送GitHub。定时提醒仍停留未完成工作区，未提交/部署。

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
| DeepSeek聊天/余额、LangChain换算与户外规则 | ECS Node → Python worker |
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
