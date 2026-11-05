# 天气图素材

`src/weather-report-image.mjs` 是当前天气查询与早间天气共用的正式渲染器。图表保留缺测断点；降水概率与云量分别标注坐标轴，PM2.5 颜色表示浓度分档。

- `template-weather.svg`：从用户提供的 `北京天气日报_改进版.pptx` 提取的原始太阳、云图形。
- `conditions/`：按查询首日天气代码匹配的摘要图形，来源记录与映射随目录保留。
- `outdoor/`：户外指数手写字素材，评分规则见 `../../docs/outdoor-index.md`。
- `GeistMono.ttf`：来自 [Google Fonts](https://github.com/google/fonts/tree/main/ofl/geistmono)，使用 SIL OFL 1.1，见 `GeistMono-OFL.txt`。

中文使用主机已安装字体和既有回退，不在这里分发系统字体。预览入口为 `scripts/preview-weather-report.mjs`。
