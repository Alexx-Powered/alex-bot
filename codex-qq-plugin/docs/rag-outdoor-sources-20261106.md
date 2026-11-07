# 气象与户外知识首批证据审计

核查日期：2026-11-06（北京时间）。导入文件：`data/rag-outdoor-knowledge.json`；格式：`rag.import.v1`；首批 14 条后同日增补 7 条，现共 21 条，气象 9 条、户外 12 条，覆盖党岭、武功山和黄山。内容为人工选取的简短释义，不保存整站页面、私人游记或未经核实的轨迹。

## 使用边界

这是供规划组合工具检索的背景资料，不是当前路线通行数据库。资料是否相关与是否足够回答是两件事；检索返回仍为 `answer_status=not_assessed`。尤其不能将历史封闭记录转成“今天关闭”，或将旧旅游报道转成“今天开放”。

所有记录均有明确来源 URL，保留来源年份或方法版本；核查日至 2027-05-06 00:00 UTC 为本批资料的复核窗口，`valid_until=1809561600`。这是项目的检索复核期限，不是来源发布机构的有效期，也不代表路线在这段时间可通行。`valid_from=0` 表示作为带日期背景可供检索，不表示历史管制从 Unix 起点生效。到期后规范存储自动排除，需人工复核后更新版本。稳定文档 ID、SQLite revision 和 content_hash 记录后续变化。

`rag.import.v1` 不允许任意额外元数据；资料类型写入标题及正文首句，不能靠标题推断当前状态。类别为气候原理、历史数据、路线背景、历史管制、高海拔历史记录、装备、导航、行前核验和山地风险。今后若增加结构化类别，需同步改导入校验及版本，不能静默接受未知字段。

## 来源与支持范围

| 文档 ID | 一级来源及版本 / 日期 | 核实的内容 | 不支持的推断 |
| --- | --- | --- | --- |
| weather-climate-normals | [国家气候中心：新旧气候场有何不同](https://www.ncc-cma.net/channel/news/newsid/100015)，2022-04-02 | 三个整年代的气候平均；中国气候业务自 2022 年采用 1991—2020 基准 | 一年样本等于常年值，或基准值预测某天 |
| weather-era5-history | [CDS：ERA5 hourly time-series](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-timeseries)，发布 2025-03-17；目录更新 2026-11-05；DOI 10.24381/1cf1ad76 | 1940 年起的逐时再分析，模型结合观测，点序列使用最近网格 | 逐点实测、未来预报、完整无误的野外实况 |
| weather-era5-land-history | [CDS：ERA5-Land hourly time-series](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land-timeseries)，发布 2025-06-04；更新 2026-11-05；DOI 10.24381/ee82e357 | 1950 年起的逐时陆面再分析，ERA5 大气强迫，较细陆面网格仍有不确定性 | 全变量独立同化、更细即精确到营地 |
| weather-mountain-grid-limits | [Copernicus：Reanalysis Q&As](https://climate.copernicus.eu/reanalysis-qas)，页末版本 October 2020 | “limitations / spatial representation”说明区域网格与测站有别，受地表、模型和观测限制 | 用网格温度确认垭口积雪或道路通行 |
| weather-climate-period-meaning | [Copernicus：About the data and analysis](https://climate.copernicus.eu/climate-bulletin-about-data-and-analysis)，2024-12 更新的方法说明，适用于 2024-01 后公报 | 区域与变量定义、参考时段、1991—2020 基准、三个月季节定义 | 全国或全球变化代替党岭逐日预报 |
| weather-china-climate-2024 | [中国气候公报（2024 年）](https://www.cma.gov.cn/zfxxgk/gknr/qxbg/202503/W020250302606211127018.pdf)，2025 年发布，印刷页 4 | 2024 全国平均气温、相对常年偏差及年度降水偏差 | 最新年度报告、党岭当地数值、从单年证明长期趋势 |
| outdoor-dangling-route-background | [丹巴县：甘孜——丹巴党岭的迷途引路人](https://www.danba.gov.cn/ttxw/article/680325)，2025-12-03 | 党岭穿越区域在丹巴、道孚交界；山地景观背景 | 具体路线 GPX、里程、爬升、补给、难度已核定 |
| outdoor-dangling-landscape-season | [丹巴县：党岭，雪山为幕，揭开夏日秘境的诗行](https://www.danba.gov.cn/yzdb/article/657808)，2025-06-22 | 官方文章提到葫芦海、卓雍措、森林与雪山 | 固定最佳月份、彩林峰值日期、当天开放 |
| outdoor-dangling-access-history-2025 | [丹巴县：甘孜——丹巴党岭的迷途引路人](https://www.danba.gov.cn/ttxw/article/680325)，2025-12-03 | 文章明确记载当年 11 月 15 日起冬季关闭党岭全部徒步线路及相关活动 | 每年固定 11 月 15 日封闭、2026 当前关闭或已恢复 |
| outdoor-dangling-altitude-record | [丹巴县卫生健康局：国庆丹巴旅游季，医疗守护与暖心救援并行 2](https://www.danba.gov.cn/dbxrmzf_zdmsxx_gzdt/article/673547)，2025-10-09 | 当年 10 月 2 日卓雍措附近高原反应救援事件 | 个人是否能适应高海拔、今日驻点救护车或随叫随到 |
| outdoor-gear-layering | [国家体育总局：户外徒步做好安全准备](https://www.sport.gov.cn/n20001280/n20001265/n20066978/c25592746/content.html)，转自 5 月 17 日中国体育报；[地方体育部门同文](https://jyj.jiyuan.gov.cn/tygz/qzty/t896453.html)核定为 2023-05-17 | 背包鞋具、分层衣物、水食、按地形考虑登山杖 | 对所有高海拔路线均充分的装备，或医疗用药建议 |
| outdoor-navigation-preparation | [应急管理部：假期出行出游安全知识发布会](https://www.mem.gov.cn/xw/xwfbh/2025n09y29xwfbh/wzsl_4260/202509/t20250929_560335.shtml)，2025-09-29 | 开放路线、导航和头灯、应急物资、结伴与路线返程报备 | 具体线路信号、补给、救援时效 |
| outdoor-route-weather-notices | [应急管理部：同次发布会](https://www.mem.gov.cn/xw/xwfbh/2025n09y29xwfbh/wzsl_4260/202509/t20250929_560335.shtml)，2025-09-29 | 目的地气象、地质预警与避开极端天气、不要盲信野路线攻略 | 无公告等于开放、户外分数等于安全或管理许可 |
| outdoor-rain-season-risks | [国家体育总局登山运动管理中心：加强雨季登山户外运动安全的通知](https://www.sport.gov.cn/dszx/n5414/c29589103/content.html)，2026-04-29 | 雨季湿滑、地质风险，以及降雨、雷电、山洪、滑坡的风险范围 | 对党岭某日某路段的实时灾害判断 |

“项目应用边界”开头的句子是基于来源范围采取的工程限制，未冒充原文引述。来源内容均为短摘要，保留站点归属和链接；没有复制来源图片、地图或全文。本任务不新增地图资产和边界。

## 同日新增的路线与实际天气解释

本轮只追加以下 7 个稳定 ID，原有 14 条不变，可使用同一导入器增量导入。路线记录给出实际官方节点与交通方式，景观记录说明可看的内容；均不填入来源未提供的里程、坐标或当前运行时间。

| 新文档 ID | 一级来源及日期 | 核实的内容 | 本轮获取情况与适用限制 |
| --- | --- | --- | --- |
| outdoor-wugongshan-jinding-route | [萍乡武功山景区：两天怎么玩](https://www.wugongshan.cn/page/strategyList%21info.htm?id=1228)，2019-09-24 | 石鼓寺至金顶段的主要节点、寺观/栈道/草甸组合 | 官方页面搜索索引提供正文和发布日期；直接读取超时。只取路线背景，不收旧票价、车次或营业时间 |
| outdoor-wugongshan-autumn-landscape | [萍乡武功山景区：四种秋色](https://www.wugongshan.cn/page/strategyList%21info.htm?id=1312)，2019-10-29 | 深秋金色草甸、层林、日出与云雾的景观类型 | 官方页面搜索索引核对正文和日期；直接读取超时。不写死年度草甸变色日或保证晴天 |
| outdoor-huangshan-xihai-route | [黄山风景区管委会：西海大峡谷游玩线路推荐](https://hsgwh.huangshan.gov.cn/lyfw/xltj/9195903.html)，2024-07-14 | 排云亭至谷底步行、谷底缆车至天海，以及往玉屏衔接 | 官方搜索索引核对全文相关段；直接读取返回 412。明确推荐方案包含缆车，不假称全程徒步；不假定季节开放 |
| outdoor-huangshan-winter-landscape | [黄山市政府 / 黄山风景区管委会：雾凇云海贺新春](https://www.huangshan.gov.cn/zxzx/zwyw/8419369.html)，2026-02-18，报道 02-17 事件 | 玉屏峰、始信峰、光明顶低温和水汽背景下的雾凇及云海 | 官方搜索索引核对正文及日期；直接读取返回 412。只作为已发生景观案例，不计算年度发生概率 |
| weather-mountain-valley-wind | [中国天气网：哪种风会影响森林火灾](https://news.weather.com.cn/2019/04/3173547.shtml)，2019-04-02 | 晴天山谷风日夜转换、背风坡焚风的干热特点 | 成功打开原页；只摘天气机理，没有导入林火扑救操作 |
| weather-rain-amount-window | [中国气象局 QX/T 489—2019《降雨过程等级》](https://www.cma.gov.cn/zfxxgk/gknr/flfgbz/bz/202209/P020220921706540516277.pdf)，2019 版本 | 第 2、3 章日雨量定义及表 1 分档 | 原 PDF 可访问；文字编码不完整，检索索引可核对定义及表格。本条引用明确版本，不宣称已复核现行所有标准；不把日累计阈值当小时雨强 |
| weather-radar-reflectivity | [深圳市气象局：雷达图像说明](https://weather.sz.gov.cn/mobile/qixiangfuwu/qixiangjiance/leidatuxiang/index.html)，无署期，核查 2026-11-06 | 反射信号和雨滴大小/数量关系，图例强度，以及非降雨回波 | 官方搜索索引核对三条说明；直接读取返回 403。未编造发布日期或把所有彩色回波直接定性为地面降雨 |

没有导入虎跳峡的旧高路行走攻略。本轮发现[香格里拉市政府 2026-02-10 通告](https://xianggelila.gov.cn/zwxx/tzgg/202602/20260210_238273.html)涉及保护区未开发未开放区域，并提及虎跳峡高路等范围；与旧旅游推介存在时间、地域及管理口径差异，需专项核定后再提供可执行路线。本轮选两个证据较清晰的目的地，不把这个发现扩写为新的通行规则。

## 重要缺口与冲突

- **党岭当前开放状态未知。** 本轮查到的是 2025 冬季历史记录；未找到足以核定 2026-11-06 或用户具体出行日期的正式开放/封闭公告。不把第三方旅行帖的 2026 开放窗口、局部解封或公路施工时间写入事实库。
- **党岭并非单一路线。** 未核得政府发布且能确认坐标系、起终点及适用日期的完整轨迹，也没有核定营地、供水、客栈、通讯覆盖或固定接驳服务。没有编造路线长度和累计爬升。
- **代表点已核，线路坐标仍未核。** 政府文章未提供路线或营地测绘坐标；用户已允许天气查询使用代表坐标，无需把政府公布数字坐标当作前置条件。同日通过现有 LocationService.resolve('党岭') 在四川、陕西同名候选中选择“四川省·丹巴县·丹东镇·党岭”，获得 OSM node 3790391144（place ID osm-n-3790391144），纬度 31.0733589、经度 101.4052803。回执见 test-output/rag-climate/dangling-location.json。该点用于地点天气/气候代表取样，来源是现有地名服务，不是政府测绘、登山口、垭口、营地或全程轨迹；不能把代表点气象当作整条徒步线实况。
- **卓雍措高度表述存在差异。** 县卫生健康局事件报道写“约 4700 米”，县融媒体转载报道写“4600 米”。可能涉及地点、估值或报道口径，缺乏测绘证据，不擅自选一个作为精确湖面/路线最高海拔；语料只保留高海拔风险事实。
- **物候资料仍有缺口，历史气象已另行取样。** 夏日景观文章与秋季游客报道不能证明每年最佳月份；没有凭印象写死封山日或红叶日期。同日已通过 Open-Meteo Archive 的明确 ERA5 模型取得党岭代表点 1991—2025 年历史资料，独立数据库中保存完整 1991—2020 参考期及 2021—2025 近年样本，回执见 `test-output/rag-climate/dangling-reference-and-recent.json`。源网格为 31.0°N、101.5°E、模式地形 4066 m，未做海拔降尺度；这是再分析网格统计，不是村落/营地站点实测，也不是彩林物候观测或当前道路状态。
- **再分析旧 FAQ 不作当前目录。** 2020 FAQ 的 ERA5 起始年份和其它产品可用年份已旧；当前起始年使用核查日 CDS 目录，FAQ 仅用于长期稳定的方法限制。
- **天气与通行必须独立。** 模型预报、气候样本、户外指数与路线管理状态分别有来源和时效；任何一个良好都不能填补另一个未知值。

## 本地验收

导入使用独立测试 SQLite；未连接生产库、未查询私人记忆、未部署到 ECS。后续数据补充继续由操作员显式选择文件，并通过白名单目录与共享域校验；网页内容不会自动成为模型写入或调用工具的指令。

2026-11-06 本地验证：14 条 JSON 经真实导入器全部接受；14 项检索回归通过，包含 outdoor 域经 LangChain 调用时的共享授权、私人项目隔离和到期失效。真实 Milvus Lite 与固定本地 BGE 中文嵌入模型建立 14 条索引，失败为 0；六个开发探针均在前四条中找到预先指定的相关证据，总流程约 2.4 秒（含初始化，本机结果）。这是开发样本的相关证据命中检查，不是答案正确率或冻结评测，也未验证实时路线开放。详细回执保存在忽略目录 test-output/rag-outdoor-real-check/receipt.json。

同日扩充验证：全文件 21 条导入成功，changed=7，原有 14 条 revision 仍为 1；真实 Milvus 增量索引 processed=7、failed=0。七个针对新增资料的开发探针均在前四条中命中预期证据，仍为 answer_status=not_assessed，不能当作整体回答正确率。回执：test-output/rag-outdoor-real-check/extension-receipt.json。当前语料 SHA256：e05c6f65841e724d097a1c1b0b588127fdfb1209100c28360a5c44b4703ce036。
