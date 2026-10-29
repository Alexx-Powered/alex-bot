# 亚历克斯 0.2.1 · 第三方来源与许可

本项目自行实现本地设置、单用户桥接、固定天气命令和 Codex MCP 接口。以下版本来自当前锁文件及已安装依赖；分发时保留各包完整 LICENSE、NOTICE 和传递依赖声明。软件许可不自动覆盖外部数据、雷达图或字体。

## 软件依赖

| 组件 | 来源 | 许可与版权声明 |
| --- | --- | --- |
| `@tencent-connect/qqbot-nodejs` 1.0.5 | [腾讯 QQ Bot SDK](https://github.com/tencent-connect/qqbot-nodejs) | MIT；Copyright (c) 2026 Tencent |
| `@modelcontextprotocol/sdk` 1.32.2 | [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MIT；Copyright (c) 2024 Anthropic, PBC |
| `zod` 4.6.7 | [Zod](https://github.com/colinhacks/zod) | MIT；Copyright (c) 2025 Colin McDonnell |
| `chart.js` 4.6.1 | [Chart.js](https://github.com/chartjs/Chart.js) | MIT；Copyright (c) 2014-2024 Chart.js Contributors |
| `@napi-rs/canvas` 1.0.13 | [napi-rs/canvas](https://github.com/Brooooooklyn/canvas) | MIT；Copyright (c) 2020 lynweklm@gmail.com；包内另附 Chromium 图标许可，见下文 |

Chart.js 与 `@napi-rs/canvas` 用于在本地生成 PM2.5 PNG 曲线。原生平台包及其底层组件的许可仍以随包声明为准；本项目未将其改为单一自有许可。

[tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) 为 MIT 许可的腾讯 DSH 插件，本项目参考其官方 QQ Bot 接入架构，没有复制其 DSH 插件实现，也不宣称由腾讯维护。未复制 `qqbot-connector` 实现，运行不依赖该包。

## 数据及图片归属

| 内容 | 来源与署名 | 本项目的使用方式 |
| --- | --- | --- |
| 官方雷达单站、区域拼图及动态目录 | [中央气象台 NMC](https://www.nmc.cn/publish/radar/chinaall.html) | 按官网目录取得原图，保留原图的图例、时间与署名，并附来源页面；不对原图重新授予本项目的软件许可，使用以源站条款为准 |
| 北京、天津天气预报 | [Open-Meteo ECMWF API](https://open-meteo.com/en/docs/ecmwf-api)，ECMWF / Open-Meteo | 使用 ECMWF IFS 0.25° 数据及接口派生变量；明确标注模型预报，非观测。ECMWF 开放数据与 Open-Meteo 数据归属、署名要求按提供方说明保留 |
| 北京 PM2.5 预报 | [CAMS Global 官方数据集](https://ads.atmosphere.copernicus.eu/datasets/cams-global-atmospheric-composition-forecasts)，Copernicus Atmosphere Monitoring Service (CAMS) / ECMWF；访问途径为 [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) | 本地生成曲线，标注 CAMS / ECMWF / Open-Meteo、预报而非实测、约 45 公里网格及 3 小时原生数据的小时插值；没有直接使用 ADS 账号下载 |
| 模型更新时间元数据 | [Open-Meteo Model Updates](https://open-meteo.com/en/docs/model-updates) | 用于时效与覆盖范围检查；不把提供方最新模型元数据宣称为具体响应的精确批次 |

Open-Meteo 数据提供 [CC BY 4.0 署名许可说明](https://open-meteo.com/en/licence)，免费公共 API 的使用条件与数据许可分别适用：[服务条款](https://open-meteo.com/en/terms)。输出保留 ECMWF、CAMS 和 Open-Meteo 来源署名。若将来切换 CAMS 官方 ADS 访问，应按其[账号、访问令牌和数据条款流程](https://ads.atmosphere.copernicus.eu/how-to-api)接入。

## MIT 许可正文

以下正文适用于上表的 MIT 软件，版权声明分别如表所列及各包 LICENSE 文件所示。

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## `@napi-rs/canvas` 随包 Chromium 图标许可

该包 LICENSE 另列 `src/svg_doc/broken_image.png` 为 Chromium 的 broken-image 图标，原路径为 `third_party/blink/public/default_100_percent/blink/broken_image.png`，适用以下许可：

Copyright 2015 The Chromium Authors

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

* Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
* Neither the name of Google LLC nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
