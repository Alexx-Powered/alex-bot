# 天气地图国界与标注核查记录

2026-11-04 进一步取得了青海天地图的县、州级原图，对藏新接边、克什米尔、东海及南海完成了图面配准。本页保存首轮基线，后续进展、可见偏差及公开使用状态见[逐段配准记录](map-regional-registration-20261104.md)。

**2026-11-04，用户已授权核实后直接上线。** 已在正式 ECS 读取实际底图哈希，核查基线仍为官方 QQ 机器人版本 `linux-wxregion-bb1118dc0769`。候选图有尚未解决的几何和符号问题。用户确认没有现成的成图审核材料。本页区分原件上能读出的事实、跨源比较及仍待核实的成图内容。[自然资源部规范](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) · [标准地图服务](https://bzdt.tianditu.gov.cn/)

## 原图实查与阿里云对照

外交部 2026 年 7 月发布的下载页提供自然资源部监制的横、竖两张中国地图原图。新疆自然资源厅的 2026 目录返回 141 项。下表的比例尺和编号均从相应图片边栏读取。目录年份与图上的审图年份有时不同。下列编号只识别参考原件。[外交部中国地图及两版原图](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml) · [新疆自然资源厅标准地图目录](https://xinjiang.tianditu.gov.cn/bzdt_code/bzdt.html) · [西藏自然资源厅标准地图](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/t20200430_139102.html)

| 原图 | 图面编号 | 主图比例尺 | 原文件 SHA256 |
| --- | --- | --- | --- |
| [中国横版](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/P020260722590998526390.JPG) | GS(2021)5448号 | 1∶7,400,000 | `bddee5487ab15591f9f3b4c83dd35bc6fde077390dcb9b6ca8aeec7807c1ef74` |
| [中国竖版](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/P020260722590999589753.JPG) | GS(2021)5447号 | 1∶10,000,000 | `d9c6c0d512ace25308cf03c744ff918f2da7e30b7f3959eb0cb3ddb1be53ff9c` |
| [新疆自治区政区](https://xinjiang.tianditu.gov.cn/resource/2026/00新疆维吾尔自治区/001新疆维吾尔自治区地图标准画法示意图.jpg) | 新S(2023)060号 | 1∶7,350,000 | `766c8fbae6fd9a86e4c08279a9fd37fac1e58a5fe0a6c42e53d4045bbe297694` |
| [和田地区政区](https://xinjiang.tianditu.gov.cn/resource/2026/14和田地区/126和田地区地图标准画法示意图.jpg) | 新S(2023)179号 | 1∶2,465,000 | `306b889ac882281de61b4eaf41ec6b0c9630a924f509b3ab0145fdfb22687404` |
| [喀什地区政区](https://xinjiang.tianditu.gov.cn/resource/2026/13喀什地区/112喀什地区地图标准画法示意图.jpg) | 新S(2026)179号 | 1∶2,135,000 | `aa744e4ab659be7a30d45c09f4f8847e53b9b61bb628d21fbf39c14552a637fa` |
| [西藏政区简图](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/P020240716635220044861.jpg) | 藏S(2024)034号 | 1∶7,420,000 | `c9768c2899ff66d353128e166814f97a79e584cf62cbaec8e637c4f9892c3e4b` |

- **克什米尔和朝鲜半岛。** 全国竖图在克什米尔用不同线型画出地区界和印巴停火线，并注明印、巴实际控制区。横图在平壤与首尔之间使用黑色点线，图例为“军事分界线”。旧版把来自这些地区的多种要素统一画成虚线。全国图能确认这种画法的错误，仍需按各局地视口核实具体几何。喀什原图分列国界、未定国界，和田原图仅列国界。把和田图例外推到所有邻国会产生新的错误。[全国两种原图](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml) · [新疆标准地图](https://xinjiang.tianditu.gov.cn/bzdt_code/bzdt.html)
- **西藏。** 逐点将西藏官方矢量的七个地级行政中心与阿里云省域多边形相交，两者均包含全部七个点及达旺测试点（东经 91.86°、北纬 27.59°），均不包含廷布和加德满都对照点。阿里云西藏分区的七个名称也与官图库一致。这项检查验证大范围归属。阿里文件未声明坐标参考系，未用于量测边界偏移或判定线型。[官方矢量库](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/P020220513410027712343.rar) · [阿里云全国轮廓](https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json) · [阿里云西藏分区](https://geo.datav.aliyun.com/areas_v3/bound/540000_full.json)
- **台湾省、东海、南海。** 阿里云标示台湾省为省级。全国文件含 34 个省级多边形及一个无地名的 `100000_JD` 要素，后者有 10 块多边形，未提供线型、地段分类或顶点精度。全国竖图可见台湾岛以东及南海的有关线段，不能把这 10 个多边形的外框或中线直接导入局地视频。候选台湾省视频在福建海岸实际地级城市位置补标“福建省莆田市”，优先保证台北和其余五个规定的地级行政中心排入画面。钓鱼岛、赤尾屿的位置符号与城市符号分开，图例可区分。[规定第七、八项](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) · [全国竖图](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/P020260722590999589753.JPG) · [阿里云台湾省](https://geo.datav.aliyun.com/areas_v3/bound/710000.json)
- **新疆标注层级。** 阿里文件把 24 项都标成 `city`，其中 10 项为 `6590xx` 自治区直辖县级市。候选省图按行政代码显示 14 个地级单位，未把这些县级市提升为地级。DataV 说明这版取自高德开放平台，更新时间为 2021 年 5 月，用途为学习交流。工程只用它作独立对照。[阿里云新疆数据](https://geo.datav.aliyun.com/areas_v3/bound/650000_full.json) · [数据版本与用途](https://datav.aliyun.com/portal/school/atlas/atlas_aigc)

**使用范围。** 《地图审核管理规定》第六条列出直接使用主管部门提供、具有审图号的公益性地图的情形。第十条关于部分基础图的条款针对申请材料中测绘资质证书的提交。上海市规划和自然资源局具体说明了对标准地图内容编辑、放缩或裁切后公开使用的处理。本项目按地点重新取景、编辑标注并叠加逐时天气，没有依据把生成的视频算作直接使用原图。是否属于向社会公开应按实际使用范围判断。参考图编号没有写入本项目视频。[《地图审核管理规定》](https://ghzrzyw.beijing.gov.cn/zhengwuxinxi/zcfg/gz/202205/t20220530_2724733.html) · [标准地图使用说明](https://ghzyj.sh.gov.cn/hyxw/20230222/c97d40c87fc84a0f8cd414a6bf2b8fb9.html) · [国家政务服务平台地图审核](https://gjzwfw.www.gov.cn/fwmh/item/v3/item_11100000MB032716991000115035000.do)

## 实际出图核对

- 比对了原始国界数据的 390 条要素和发布包中去重后的 539 条折线片段。逐点重建旧版抽稀、分段和跨经线处理，再与实际 ZIP 中的坐标及样式匹配。旧版整包全部 36 段虚线已逐段归回 33 条原始要素，没有余项。
- 33 条中有 21 条来自来源的争议线分类、7 条来自控制线分类、5 条来自待定线分类。旧程序将它们画成同一种虚线，无法由虚线推断其法律地位。另有 2 条 `Indeterminant frontier` 被画成国际边界实线。再纳入 5 条普通分类中带中国观点覆盖值的要素，共得 40 条重点记录，其中 33 条旧图为虚线、5 条为实线、2 条在旧国界层跳过。
- 发布底图 SHA256 为 `e7f5fa39c6fc94b1176bcd070786d3428d19f9accff393b026bcfef1702b2de9`，上游文件 SHA256 为 `2faac4f6b34386f3d21b6e018cf151f241f00e5c936d44dd17d7d9bfb147fa48`。每项的坐标框、旧图折线编号、第三方观点字段、地方图幅覆盖比例及未核状态均存于[逐要素数据](../data/weather-boundary-review.json)。Natural Earth 自身说明其默认边界及备选观点线来自不同规则。[数据提供方说明](https://www.naturalearthdata.com/about/disputed-boundaries-policy/)
- 全球雷达此前还会叠加动态 OpenStreetMap 栅格。栅格没有可按要素穷举的固定线清单，不能把上述 33 条的核对结果延伸到这些瓦片。当地国内雷达发布方直接提供的整幅产品同样不计入这 33 条。后续新增或更换上游图件，还须单独核对其来源和适用范围。

## 本地校核稿

**西藏。** 取得自治区自然资源厅标准地图服务提供的 A2 FileGDB，并与该页面提供的 A4 政区简图交叉检查。A2 数据库的“境界线”图层有 5 条记录名称为“国界”，FID 为 268、269、366、367、368。其中三条 RuleID 为 1，两条为空。数据库分类和 RuleID 不能说明整段是否已通过条约划定。保留全部五条源几何作为紫色核对线，不推断空属性，不将跨越不同邻国的长记录整条判为已定或未定国界。西藏行政中心直接取自同库的“行政居民地”图层。[官方服务及图例](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/t20200430_139102.html) · [A2 原始数据库](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/P020220513410027712343.rar) · [A4 政区简图](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/P020240716635220044861.jpg) · [外交部关于中印边界的表述](https://www.mfa.gov.cn/web/fyrbt_673021/202403/t20240325_11270445.shtml)

使用官方西藏省域替换区域遮罩，并裁除境外次级区划的重叠。对同一省域向内留 0.001° 的比较窗口，旧库有 64 个 IND、16 个 BTN、5 个 NPL 线段块与其相交，新库为 0。此计数只衡量误入省域内部的境外数据，不代替边界接口和线型审核。旧藏南 B00 大部分位于官方省域内部，不沿旧线绘国界。

**台湾省。** 标为省级行政单位。台北市使用省级行政中心符号，新北市、桃园市、台中市、台南市及高雄市使用地级行政中心符号。按公开坐标标示钓鱼岛、赤尾屿，所属范围及岛屿标注在成图中独立检查。不绘海峡中线作国界，不把第三方 TWN 县、乡镇线提升为省界或地级界。旧地面数据库中该来源的 974 个区划折线块在草稿中已排除。东海有关线段的几何与符号仍待单独核对。[自然资源部规范第七、八项](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) · [国家海洋局公布的岛屿坐标](https://www.mfa.gov.cn/diaoyudao/chn/xwdt/201209/t20120915_8523866.htm)

**标注。** 自动候选使用有行政代码的地级单位和规范指定的行政中心。逐省实测可放下内地 333 个地级行政单位，以及台湾省上述 6 个行政中心。四个直辖市作为省级单位另行处理。宏观区域地图按空间避让，可以省略放不下的标签。乡镇村庄不会补占上级名额。用户明确查询的小地点保留独立定位点。全球雷达草稿仅使用离线物理海岸线与行政标签，回波与覆盖数据仍来自其原天气源。

## 首轮核查的待办（12:48 时）

本机 34 项 Python 地图、雷达、天气和发布检查，以及 9 项 Node 视频与路由专项均通过。初版西藏和台湾省样片在 `test-output/cn-map/review-clips/`。本轮使用正式指令 `发 动态温度 台湾省`，通过 Node → Python LangChain 生成带新标注、图例的 1080×1080 MP4，实际完整解码 139 帧。成品 `test-output/cn-map/crosscheck/tw-final.mp4` 的 SHA256 是 `45a1b71e0e6e3f48c161bb13bad17ab6312d1c8e7bab599034e7a7b733932ea7`，同目录 `tw-final.png` 为抽帧。

1. 取得与实际区域视口比例尺相适应的国内及世界各国界线参考资料。已下载全国横、竖两张原图及西藏、新疆、和田、喀什图幅；尚未取得覆盖所有境外地段的相应比例尺图幅。国家基础地理信息中心另提供全国 1∶100 万公众版矢量数据目录，现势性为 2019 年。本次从公开查询入口未取得分幅矢量文件，目录本身不作为几何证据。[国家基础地理信息中心数据规格及使用说明](https://www.webmap.cn/commres.do?method=result100W)
2. 核对西藏资料与新疆等周边图幅的接边及各地段的最终符号。克什米尔须区分地区界、停火线和不同尺度下的标注要求。东海有关线段、南海断续线不在原始陆地界线图层内，另列校核项目；不得人工估画缺失线段。[自然资源部规范](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html)
3. 逐项保存正式图幅的可识别编号、比例尺、相关地段及证据哈希。核对最终渲染稿及适用的地图审核事项。校核稿中暂时不显示未确认的其他例外线，此处理本身不能作为发布依据。不得沿用参考原图的审图号。
4. 只读核实 ECS 正式 19327 监听 PID 117628，11:44:01 CST 启动。逐项取得现行 17 个地图文件的 SHA256，核对本地镜像再与候选 18 个文件比较，共 10 项新增或不同。对这两个实际版本运行 `ops/map_review.py`，结果为 `MAP_PUBLICATION_ON_HOLD`。回执保存在 `test-output/cn-map/crosscheck/release-comparison.json`。ECS 继续使用旧地图，旧版已发现的问题仍有可能在 QQ 出图中出现。

## 逐条清单

“旧图（片段数）”是对实际发布字节的回查。“来源种类”是第三方原字段的简译。表中方位名称方便检索原件。所有条目均尚未取得最终出图签核。

| 源要素 ID | 地段 | 来源种类 | 旧图（片段数） | 核查结果与依据 |
| --- | --- | --- | --- | --- |
| `1746705343` | 索马里北部 | 争议线 | 虚线（1） | 官方立场不足以支持把此岛内或境内分隔线画成国际边界。其他图例和范围仍需样图。 [SO](https://www.fmprc.gov.cn/wjbzhd/202601/t20260112_11811361.shtml) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746705331` | 埃塞俄比亚与索马里交界 | 待定线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746705323` | 加沙地带周边 | 争议线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746709121` | 约旦河西岸周边 | 争议线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746705327` | 黎巴嫩南部边区 | 争议线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746708629` | 戈兰高地西缘一带 | 控制线 | 虚线（1） | 已核对中方关于戈兰高地的表述，军事线与国界的具体走向仍需样图。 [SY](https://www.mfa.gov.cn/zwbd_673032/wjzs/202606/t20260624_11951325.shtml) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746708491` | 塞浦路斯岛内 | 控制线 | 虚线（1） | 官方立场不足以支持把此岛内或境内分隔线画成国际边界。其他图例和范围仍需样图。 [CY](https://www.mfa.gov.cn/ziliao_674904/1179_674909/202111/t20211130_10459117.shtml) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746705319` | 阿克赛钦西缘一带 | 争议线 | 虚线（1） | 已对照新疆自治区和和田图例。和田图例只列国界，自治区图例另列未定国界，均未给出此源要素与两省区接边的一一对应。 [XZ](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/t20200430_139102.html) [XJ](https://xinjiang.tianditu.gov.cn/bzdt_code/bzdt.html) [CN](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml) [IN](https://www.mfa.gov.cn/web/fyrbt_673021/202403/t20240325_11270445.shtml) [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) |
| `1746709141` | 克什米尔东北部 | 控制线 | 虚线（1） | 全国竖图以灰色虚线表示地区界、黑色点线表示印巴停火线，图上另有实际控制区文字。未逐段确认此几何在局地视口的对应及端点。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [CN](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml) [XJ](https://xinjiang.tianditu.gov.cn/bzdt_code/bzdt.html) |
| `1746705337` | 中印边界东段、藏南内侧旧线 | 争议线 | 虚线（2） | 旧线进入官方西藏省域，排除旧国界画法。替代几何和符号分别审核。 [XZ](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/t20200430_139102.html) [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [IN](https://www.mfa.gov.cn/web/fyrbt_673021/202403/t20240325_11270445.shtml) |
| `1746708623` | 朝鲜半岛军事分界线一带 | 控制线 | 虚线（1） | 全国横图朝鲜半岛段与图例均为黑色点线，类别为军事分界线。原包统一的争议虚线不适用；局地放大后的线形和端点仍待对位。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [CN](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml) |
| `1746705351` | 西撒哈拉境内沙墙一带 | 控制线 | 虚线（2） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746705329` | 伊莱米三角地带 | 争议线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746705371` | 戈兰高地北侧一带 | 争议线 | 虚线（1） | 已核对中方关于戈兰高地的表述，军事线与国界的具体走向仍需样图。 [SY](https://www.mfa.gov.cn/zwbd_673032/wjzs/202606/t20260624_11951325.shtml) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746708661` | 锡亚琴冰川北缘 | 待定线 | 虚线（1） | 全国竖图以灰色虚线表示地区界、黑色点线表示印巴停火线，图上另有实际控制区文字。未逐段确认此几何在局地视口的对应及端点。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [CN](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml) [XJ](https://xinjiang.tianditu.gov.cn/bzdt_code/bzdt.html) |
| `1746706755` | 科索沃与塞尔维亚其他地区之间 | 国际边界 | 实线（1） | 官方立场不足以支持把此岛内或境内分隔线画成国际边界。其他图例和范围仍需样图。 [RS](https://www.mfa.gov.cn/web/wjdt_674879/zcjd/202409/t20240916_11491613.shtml) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746707747` | 圭亚那与委内瑞拉交界 | 争议线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746708757` | 克什米尔西南部 | 控制线 | 虚线（1） | 全国竖图以灰色虚线表示地区界、黑色点线表示印巴停火线，图上另有实际控制区文字。未逐段确认此几何在局地视口的对应及端点。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [CN](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml) [XJ](https://xinjiang.tianditu.gov.cn/bzdt_code/bzdt.html) |
| `1746708045` | 摩洛哥与阿尔及利亚西南交界 | 待定线 | 虚线（2） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746705335` | 马拉维湖东北部 | 争议线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746705295` | 珠海与澳门 | 国际边界 | 跳过（0） | 原国界层已跳过，特别行政区界沿内地共边绘制，仍需相应大比例尺标准行政区域图核线。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) |
| `1746708389` | 深圳与香港 | 国际边界 | 跳过（0） | 原国界层已跳过，特别行政区界沿内地共边绘制，仍需相应大比例尺标准行政区域图核线。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) |
| `1746708827` | 北海道东北部邻海 | 争议线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746708403` | 阿卜耶伊地区 | 争议线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746705347` | 圭亚那与苏里南南部交界 | 争议线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746705345` | 苏里南与法属圭亚那南部交界 | 争议线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746708787` | 克里米亚半岛北部 | 争议线 | 虚线（1） | 外交部立场可查。该陈述并不提供逐段制图几何和图例；不能据第三方 CN 字段定线。 [UA](https://www.mfa.gov.cn/web/fyrbt_673021/jzhsl_673025/202304/t20230424_11064751.shtml) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746708603` | 锡亚琴冰川西侧甲段 | 未定边境 | 实线（1） | 全国竖图以灰色虚线表示地区界、黑色点线表示印巴停火线，图上另有实际控制区文字。未逐段确认此几何在局地视口的对应及端点。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [CN](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml) [XJ](https://xinjiang.tianditu.gov.cn/bzdt_code/bzdt.html) |
| `1746708607` | 锡亚琴冰川西侧乙段 | 未定边境 | 实线（1） | 全国竖图以灰色虚线表示地区界、黑色点线表示印巴停火线，图上另有实际控制区文字。未逐段确认此几何在局地视口的对应及端点。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [CN](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml) [XJ](https://xinjiang.tianditu.gov.cn/bzdt_code/bzdt.html) |
| `1746708449` | 中印边界西部地段 B03 | 争议线 | 虚线（1） | 旧线进入官方西藏省域，排除旧国界画法。替代几何和符号分别审核。 [XZ](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/t20200430_139102.html) [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [IN](https://www.mfa.gov.cn/web/fyrbt_673021/202403/t20240325_11270445.shtml) |
| `1746708457` | 中印边界西部地段 B04 | 争议线 | 虚线（1） | 旧线进入官方西藏省域，排除旧国界画法。替代几何和符号分别审核。 [XZ](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/t20200430_139102.html) [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [IN](https://www.mfa.gov.cn/web/fyrbt_673021/202403/t20240325_11270445.shtml) |
| `1746708463` | 中印边界中部地段 B01 | 争议线 | 虚线（1） | 旧线进入官方西藏省域，排除旧国界画法。替代几何和符号分别审核。 [XZ](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/t20200430_139102.html) [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [IN](https://www.mfa.gov.cn/web/fyrbt_673021/202403/t20240325_11270445.shtml) |
| `1746708469` | 中印边界中部地段 B02 | 争议线 | 虚线（1） | 旧线进入官方西藏省域，排除旧国界画法。替代几何和符号分别审核。 [XZ](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/t20200430_139102.html) [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [IN](https://www.mfa.gov.cn/web/fyrbt_673021/202403/t20240325_11270445.shtml) |
| `1746708751` | 中不边境 B75 地段 | 国际边界 | 实线（1） | 旧线进入官方西藏省域，排除旧国界画法。替代几何和符号分别审核。 [XZ](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/t20200430_139102.html) [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) |
| `1746708779` | 中不边境 B76 地段 | 国际边界 | 实线（1） | 旧线进入官方西藏省域，排除旧国界画法。替代几何和符号分别审核。 [XZ](https://zrzyt.xizang.gov.cn/fw/zyxz/202004/t20200430_139102.html) [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) |
| `1746708837` | 刻赤海峡一带 | 争议线 | 虚线（1） | 外交部立场可查。该陈述并不提供逐段制图几何和图例；不能据第三方 CN 字段定线。 [UA](https://www.mfa.gov.cn/web/fyrbt_673021/jzhsl_673025/202304/t20230424_11064751.shtml) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746708915` | 巴西与乌拉圭交界 | 争议线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746708703` | 南巴塔哥尼亚冰原 | 待定线 | 虚线（1） | 已核对原始种类、坐标和实际成图切段。缺少可判定该段走向和符号的中国政府适用比例尺样图。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [STD](https://bzdt.tianditu.gov.cn/) |
| `1746709133` | 克什米尔西部 | 控制线 | 虚线（1） | 全国竖图以灰色虚线表示地区界、黑色点线表示印巴停火线，图上另有实际控制区文字。未逐段确认此几何在局地视口的对应及端点。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [CN](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml) [XJ](https://xinjiang.tianditu.gov.cn/bzdt_code/bzdt.html) |
| `1746706305` | 喀喇昆仑山西北段 B08 | 待定线 | 虚线（1） | 全国竖图以灰色虚线表示地区界、黑色点线表示印巴停火线，图上另有实际控制区文字。未逐段确认此几何在局地视口的对应及端点。 [MNR](https://ghzyj.gz.gov.cn/zwgk/newzcfg/ywly/content/post_9466245.html) [CN](https://www.mfa.gov.cn/ziliao_674904/zgdt/202607/t20260722_11989560.shtml) [XJ](https://xinjiang.tianditu.gov.cn/bzdt_code/bzdt.html) |
