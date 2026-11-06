# 功能展示图

这些图片来自项目已有渲染器和控制台，用于仓库首页。天气和服务状态为历史采集样例，不表示阅读时的实时结果。

| 文件 | 来源 |
| --- | --- |
| `weather.webp`、`weather-summary.webp` | 2026-11-03 广州天气正式版渲染；摘要仅裁去下方曲线，完整图保留全部内容 |
| `forecast-video.gif`、`forecast-video.webp` | 2026-11-04 发布验证的广东降水原始格点视频；GIF 为完整时段预览，WebP 为清晰原帧，时轴见图内 |
| `providers.webp`、`provider-*.webp` | 2026-11-06 10:45（北京时间）五家官方状态快照；分别保存主卡片节选与可展开完整图 |
| `console.webp` | 当前控制台，使用隔离演示数据；不含实际群身份、成员或凭据 |
| `help.webp` | 当前帮助渲染器，按演示群启用的功能与唤醒词生成 |

静态图片以 WebP 保存，动态预览使用循环 GIF。GIF 由 `test-output/video-command-detail/native.mp4` 转换，源文件 SHA256 为 `0cc50c2a3f9f2444a2deac932436bc9acb95f4b84e39f7e81732353d80617ac3`，使用 640×640、8 fps、128 色；保留全片时间范围。没有重新绘制或改动地图。

OpenAI 故障详情依据[官方事件页](https://status.openai.com/incidents/01M6P50GPP1V98EF8MJ9SH393R)补全受影响组件，保留接口对其他服务的返回值。原始查询、展示输入、渲染脚本与核验记录位于本机 `test-output/readme-gif/`。公开来源说明见 `docs/public-assets.md`。

字体、天气素材和厂商标志的来源见主服务 `public/` 对应素材目录；视频图源见 `data/` 中的 NOTICE。
