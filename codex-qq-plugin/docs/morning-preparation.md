# 早报提前准备与定时发送

官方逐群早间天气、三号楼自习简报共用两阶段调度，时区为 Asia/Shanghai：

- `alexbot-group-morning-prepare.timer` 每天 07:25 准备群里已订阅的项目。此阶段只准备图片和重试生成。
- `alexbot-group-morning.timer` 每天 07:30 开始投递，每个项目就绪即可发送。最迟于 07:40 前向 QQ 提交消息，排队和媒体上传后都会复核截止时间。QQ 实际送达时间取决于平台。
- 两个定时器都关闭错过补跑。逐群逐图保留原幂等键。QQ 返回群级权限错误时，跳过该群当轮投递，继续处理其他群和剩余简报。服务日志记录控制台群名及 QQ 错误码，LangSmith 记录对应的群标识。已提交但因已识别的 QQ 暂时异常丢失回执时，保留该条未决投递和原键。
- `alexbot-daily-reboot.timer` 每天 05:30 由 systemd 重启 ECS。错过时刻不补重启。机器开机自动恢复官方 QQ、已启用的订阅与调度，Playwright 在下一次查询时启动新浏览器。已有登录态在有效期内复用，已暂停的发送继续暂停。

定时天气和空气每次 HTTP 上限 45 秒。天气与风速摘要、户外指数各有 30 秒计算时限，PM2.5 比较选源有 20 秒。每轮定时生成各取一次天气和空气。上游超时、网络问题、天气接口 HTTP 404、408、5xx、缺测和起报过旧可触发下一轮，429、错误单位和无效元信息按原规则处理。48 小时主要天气字段、PM2.5、首日天气类型、风摘要和户外指数全部通过检查后才渲染。

定时天气依次尝试 Open-Meteo Previous Runs 的当前 ECMWF IFS、Visual Crossing `ecmwf_2`、Open-Meteo ECMWF 专用接口，最后重试 Previous Runs。普通静态天气和管理员早报预览均先用 Previous Runs，暂时故障时切到 ECMWF 专用接口。两条 Open-Meteo 入口均固定同一 IFS 模型。普通静态查询共享 15 秒取数预算，Previous Runs 最多 8 秒。

有群订阅时，22:55 为次日城市保存 Visual Crossing 单模型 `ecmwf_2` 的凌晨 00–07 时预报。启用备用源时，补齐当天 08 时至后天 00 时，校验时区、城市、起报和 48 小时字段。降水量采用小时结束时刻，降水概率取 ECMWF ENS 公共存储格点并插值到整点，图中注明来源。北京和天津使用相同规则，缓存只含公开天气数据。快照过期、降水类型不明或数据缺失时，继续下一次取数。[Visual Crossing 单模型文档](https://www.visualcrossing.com/resources/documentation/weather-api/weather-forecast-model-comparison/) · [ECMWF 公共存储说明](https://github.com/open-meteo/open-data#updates-to-real-time-weather-forecasts)

按北京时间的报告日期，北京和天津的定时早报和普通静态天气图在 11 月至次年 3 月比较 CAMS 与 NOAA GEFS-Aerosols 同一 48 小时的平均 PM2.5，采用均值较低的一整套预报。相等用 CAMS，只有一套完整时用该套，两套均不完整时按该入口原有缺测规则处理。曲线、峰值和户外指数共用选定的逐小时值，图上沿用原有数据源位置。4 至 10 月使用 CAMS。[NOAA GEFS-Aerosols](https://www.emc.ncep.noaa.gov/emc/pages/numerical_forecast_systems/gefs_aero.php) · [公开存储](https://registry.opendata.aws/noaa-gefs/)

`alexbot-morning-gefs.timer` 在冬季 07:15 从同一批 NOAA 格点提取北京和天津的 72 小时预报，覆盖以今天或明天为起点的两个 48 小时窗口。用公开存储的索引和字节范围取近地面总 PM2.5，3 小时时次线性插值到整点。解码依赖 `python/requirements-pm25.txt` 单独装入 `python/.pm25-runtime`，复用运行环境的 NumPy。独立单元使用 128 MiB、Swap 0、CPU 50% 上限，取数由单个 Python 进程执行。快照过期或缺失时，今天的窗口在当前入口取数时限内尝试直取 NOAA，普通静态查询最多等 8 秒。LangSmith 分别显示 `morning_air_cams`、`morning_air_gefs`、`morning_air_select`。

校园定时采集的导航和教室接口各有 60 秒，登录阶段共用 120 秒，填账号、填密码和点击各最多 20 秒，整个工作进程调用最多 300 秒。平常导航 25 秒、登录 40 秒、查询 20 秒，填表和点击各最多 8 秒。重试由早报调度统一管理。定时参数仅由内部报告调用选择。

两个入口共享当天的任务和图片。每个项目首次生成后最多重试 3 次，每次间隔 15 秒，07:40 结束等待。状态账本保留当天的尝试次数和最近的失败代码，重启后继续使用剩余次数。天气取数可与校园采集重叠，渲染和浏览器继续通过重任务队列。准备时捕获订阅版本，后续新增或重新开启的订阅从下一次准备生效。

简报生成最终失败时，投递入口合并项目、次数、错误码和脱敏原因，通过已配对的主人 QQ 私聊发送一次日志。若当天已发过失败日志，使用相同日期的投递键去重。通知同样受暂停、连接和平台额度约束，通知结果留在投递追踪及 systemd 日志中。

单群发送失败时，打开「群聊与功能」，选中该群并展开「群聊日志」。页面展示最近 30 条可归属的失败或未决记录。群权限拒绝跳过该群本轮剩余投递，其他群按各自订阅处理。临时故障只影响对应请求，未决回执保留原幂等键。定时任务用 `MORNING_GROUP_FAILURES` 记录已处理的局部故障，分别统计发出、失败和跳过数。

控制台显示 07:25 准备、07:30 发送、07:40 截止及两项准备状态。管理员 `/api/morning/preview` 使用同样的长超时生成图片，默认预览天气。请求体可指定 `part` 为 `weather` 或 `campus`。预览返回校验结果及图像字节数。`/api/group/morning/prepare` 与 `/run` 只接收空对象。准备和发送期间可正常修改控制台配置。

经主人要求发送正式天气图测试时，运行 `node scripts/send-weather-briefing.mjs --scheduled-test <本次幂等键>`。这条路径与早报共用取数和绘图，只向配对的本人发图，追踪名为 `qq.morning.test`。结果不确定时保留原键。

LangSmith 中可按 `qq.morning.prepare`、`qq.morning.retry`、`qq.morning.dispatch` 和 `qq.morning.preview` 查找早报。每次重试拥有独立根条目，输入包含任务日期、项目和重试序号。`weather_fetch` 的子步骤分别记录主备预报接口、起报元数据及天气摘要。校园追踪逐步记录浏览器启动、网页加载、等待登录表单或已有会话、填账号、填密码、点击、等待认证结果、教室接口及绘图。登录动作的追踪只含步骤、时长和脱敏错误码。投递条目记录各项发送、媒体上传、消息提交和私聊日志发送结果。

部署与验收回执见根目录 HANDOVER 最新记录。回退时恢复上一版正式源码和准备定时器、准备服务文件，保留最新投递账本。
