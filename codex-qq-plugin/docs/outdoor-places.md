# 天气地点检索

已上线：linux-places-a3ab366e73e4，2026-11-03。

固定命令：`发 天气 珠峰`、`发 天气 措玉村`、`发 天气 麦理浩径`。群聊照常需要 @ 或已启用唤醒词。自然语言通过现有 weather_image 工具；已收录地标的简单天气句可走 quick_weather_route，不调用模型。天气、空气权限保持原样。

行政目录保持原3577条；新增10条带来源代表点，明细见 data/outdoor-locations.json。其他地点用 Photon/OpenStreetMap 动态搜索，保留省市县与同名候选，不取第一条、不给未知村庄套县城坐标。部分地名仍可能未收录，补充省市县或使用完整名称。

路线只返回数据源命名步道对象代表点；麦理浩径固定用北潭涌代表点，图中标明；不是沿线预报。户外指数规则未变，不代表路线开放或通行状态。地标坐标按原值传入天气和CAMS，不改用行政中心。

来源与使用：
- Photon API：https://github.com/komoot/photon （公共演示源允许合理低量项目使用，不保证可用性）
- 地图数据与署名：https://www.openstreetmap.org/copyright
- 精选点坐标出处、别名、核查日期逐条记录于 data/outdoor-locations.json；图片底部附地图/Wikimedia署名，成功查询只发送图片，不附带文字。

限额：固定HTTPS主机，网络7秒，Python桥接11秒；单worker并发，排队上限4；响应512KiB；最多8候选；同名请求合并，缓存24小时。无自动重试，无大地图数据库，无新API Key。
