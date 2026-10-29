# 官方 DSH QQ Bot 风险与验证方案

调研日期：2026 年 10 月 28 日。对象：[tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)。用途：私人 QQ 对话助手、每日定时汇报，以及 Codex 任务异常通知。

**建议优先验证官方插件路线，但先收紧权限并补齐发送控制。** 它不需要将日常 QQ 号登录到第三方协议端，也不需要注入日常 QQ 客户端，符合“不干扰正常 QQ”的方向；但官方接入并不保证机器人或关联账号绝不被封。当前源码还存在空白名单放行、默认限流阈值未启用等需要处理的问题。

本文是初期调研和静态代码审阅。建议配置与改造尚未应用，没有进行登录、收发、定时推送或长期运行测试。社区项目全景见[QQ机器人项目调研与选型](<D:/Projects/Alex Bot/QQ机器人项目调研与选型.md>)。

## 它实际接入的是什么

插件用 AppID / AppSecret 初始化腾讯 QQ Bot SDK，通过官方 WebSocket 接收事件、调用官方 API 发消息。扫码绑定取得的也是机器人应用凭据，不是普通 QQ 登录会话。架构是“本人 QQ ↔ 官方机器人平台 ↔ dsh-qqbot ↔ DSH agent”。[初始化源码](https://github.com/tencent-connect/dsh-qqbot/blob/6d2564fc59ae00632debff25453caf8f8f24af0f/src/gateway/bootstrap.ts#L55)、[扫码绑定凭据](https://github.com/tencent-connect/dsh-qqbot/blob/6d2564fc59ae00632debff25453caf8f8f24af0f/src/setup/binding-service.ts#L161)

因此，官方插件没有 NapCat / SnowLuma 那种普通账号协议接入或客户端注入的同类结构性风险。它仍需占用本机计算和网络资源，DSH 所运行的工具也受自身权限影响；“没有 QQ 进程注入”不等于整个 agent 对电脑完全没有影响。

## 封号风险要分三层理解

| 对象 | 可以作出的判断 | 不能作出的保证 |
| --- | --- | --- |
| 日常 QQ 客户端进程 | 官方 API 路线无需注入或修改客户端 | 不能代替实际安装后的资源、兼容性检查 |
| 官方机器人应用 | 仍可能被限流、拒绝主动消息、限制接口或停用 | 官方项目不等于内容和行为免审 |
| 管理员与关联用户账号 | 与开发主体、机器人运营行为有关联 | 不能承诺违规处罚一定止于机器人应用 |

腾讯《安全使用须知》正文标注 2026-07-09 生效，第三节列出的处置包括“用户/机器人相关账号临时或永久封禁”。它没有说每次机器人违规都会封个人 QQ，但足以否定“官方机器人绝不牵连个人号”的保证。该条来自官方规则中心的可检索正文，部署时应再核对实际绑定页所展示的协议。[安全使用须知](https://rule.tencent.com/rule/202603270003)

与本项目最相关的规则是避免骚扰和垃圾消息、接口滥用、不当内容，以及未经同意收集或传输用户数据。平台也可因严重问题停止向开发主体提供服务。官方渠道降低的是接入方式的一类风险，内容、行为和授权责任仍然存在。[运营规范](https://bot.q.qq.com/wiki/business/)

**风险控制应以减少暴露、明确授权和发生拒绝后停止为中心。** 不以轮换账号、伪造设备、混淆消息或反复试探平台限制作为“防封”方案。没有可核验的公开统计支持给此插件报出一个可靠封号概率。

## 当前版本的源码发现

| 组件 | 审阅快照 |
| --- | --- |
| dsh-qqbot | package 0.5.4；commit 6d2564fc59ae00632debff25453caf8f8f24af0f |
| qqbot-nodejs | 1.0.5；commit 429a0f1b798f3b0fcef3679e207dbc0469a1df2d |
| 依赖对应关系 | 插件 package-lock.json 锁定 SDK 1.0.5；结论对应该组合 |

源码固定链接用于复核；以后发布的版本可能改变行为。安装时需核对实际版本与依赖，不能把下述结论永久套用到上游最新版。

### 空白名单不能用于拒绝所有人

默认私聊和群聊访问模式都是 open。更重要的是，插件会把空的 c2cAllow / groupAllow 转成包含星号的数组，而 SDK 将星号解释为匹配所有。因此“只把模式切成 allowlist，名单暂时留空”并不会形成预期的限制。[名单转换](https://github.com/tencent-connect/dsh-qqbot/blob/6d2564fc59ae00632debff25453caf8f8f24af0f/src/gateway/middleware-setup.ts#L42)、[SDK 匹配规则](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/middleware/access-policy.ts#L49)

建议使用真实、非空、没有星号的本人 user OpenID；不用的群聊直接 disabled。实施时还应把“空白名单拒绝所有”修正为明确行为，并添加对应测试。OpenID 不是直接填写 QQ 号码，且须在当前应用中取得。将来开放群聊时，groupAllow 只限制哪些群可以访问，并不限制群里的哪些成员；工具调用还需另做发送者鉴权。

### 默认中间件没有配置入站限流阈值

插件调用 rateLimiter() 时未传入选项；SDK 只在存在 perSender、perGroup、global 配置时创建相应限流器，无参数时三层都未创建。准确结论是：**这条默认中间件路径没有启用这些入站限流阈值。**[插件调用](https://github.com/tencent-connect/dsh-qqbot/blob/6d2564fc59ae00632debff25453caf8f8f24af0f/src/gateway/middleware-setup.ts#L82)、[SDK 实现](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/middleware/rate-limiter.ts#L81)

已有会话串行、消息合并和 maxQueue 控制，不能替代按时间计算的入站限速，更不能替代发给 QQ 的出站限速与每日预算。不能只凭文档中的“三层限流”描述就认为防刷屏已完成。

### 主动发送与任务调度是两回事

发送目标解析会优先使用已有消息或事件 ID；候选耗尽时，可不携带这些 ID，走主动发送。它并不预先证明该应用当前具有主动发送权限。[目标解析](https://github.com/tencent-connect/dsh-qqbot/blob/6d2564fc59ae00632debff25453caf8f8f24af0f/src/transport/reply-target.ts#L23)

已审阅代码提供 DSH QQ 会话的回复和错误通知，但未找到完整的业务日报日程、持久化通知队列或外部 Codex 告警 webhook。因此“能主动发”不等于“装好即可每天可靠汇报”，更不等于“自动监听 Codex”。[DSH 回合错误处理](https://github.com/tencent-connect/dsh-qqbot/blob/6d2564fc59ae00632debff25453caf8f8f24af0f/src/transport/outbound.ts#L270)

### 发送拒绝后还需要统一停止机制

静态文本发送没有发现无限重试，但分块发送在一块失败后会继续下一块。流式发送虽有更新节流和有限重试，writer 后续更新仍可能继续尝试；这些都不能替代按接收人停止整个发送队列的机制。[静态分块](https://github.com/tencent-connect/dsh-qqbot/blob/6d2564fc59ae00632debff25453caf8f8f24af0f/src/transport/outbound.ts#L283)、[流式 writer](https://github.com/tencent-connect/dsh-qqbot/blob/6d2564fc59ae00632debff25453caf8f8f24af0f/src/transport/streaming-writer.ts#L150)

SDK 的流式限流识别字段与 ApiError 的字段定义还有覆盖疑点，需通过真实 ApiError 的模拟测试确认。不能把“代码里有重试”当成所有 429 都会正确退避的保证。[流式错误处理](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/streaming.ts#L223)、[ApiError](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/protocol/types.ts#L19)

网关对不可恢复的关闭码已有保护：SDK 将 4914（下线或沙箱状态）、4915（封禁）归类为不可继续重连，普通可恢复断连则退避重连。外层守护程序必须保留这个停止语义，不能一退出就无限重启。插件当前对永久断开主要记日志，仍需备用告警。[断开分类](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/protocol/gateway/reconnect.ts#L103)、[插件断开处理](https://github.com/tencent-connect/dsh-qqbot/blob/6d2564fc59ae00632debff25453caf8f8f24af0f/src/gateway/bootstrap.ts#L152)

## 仅本人使用时的配置建议

这是后续实施清单，不是已经生效的配置，也不是腾讯认可的“免封参数”。

| 现有配置项 | 初期建议 | 目的或注意点 |
| --- | --- | --- |
| access.c2cMode | allowlist | 只开放本人 |
| access.c2cAllow | 当前 AppID 下本人的非空 user OpenID 列表 | 禁止空列表和星号；不要填写普通 QQ 号码冒充 OpenID |
| access.groupMode | disabled | 先关闭群入口；以后单独验证群白名单 |
| requireMention | true | 将来开放群时保留明确触发条件 |
| streaming | false | 首版只发完整文本，便于预算和故障控制 |
| sendFile.sendPresentedFiles | false | 关闭交付物自动外发 |
| sendFile.restrictPaths | true | 保持文件发送路径限制 |
| sendFile.extraRoots | 空列表 | 不扩大可发送文件范围 |
| cwd | D:\Projects\Alex Bot | 使用专用工作目录；它本身不是操作系统沙箱 |
| showToolResults | false | 减少工具输出；错误仍可能展示，另外做脱敏 |
| media.enabled | 初期 false | 先验证文本，后续按需要开放图片或其他媒体 |

这些字段来自[配置源码](https://github.com/tencent-connect/dsh-qqbot/blob/6d2564fc59ae00632debff25453caf8f8f24af0f/src/config.ts)。默认文件白名单会包含 cwd；设置了 cwd 并不限制所有 agent 工具的访问范围。DSH 的工具权限、审批与文件发送权限要分别收紧。将来创建多个实例时，还需把凭据、数据和配置分开。

## 需要另外实现的发送控制

以下是工程建议，不能仅修改上表就自动获得。

| 控制 | 建议行为 | 对风险的作用 |
| --- | --- | --- |
| 统一出口 | 正文、错误、文件、日报、Codex 通知都通过同一发送层 | 避免某条路径绕过限制 |
| 订阅与接收人 | 只向固定本人 OpenID 投递；明确暂停和退订状态 | 减少误发与非预期触达 |
| 日报合并 | 初期一天一份完整摘要，包含信息日期与来源 | 控制频率与内容质量 |
| 告警去重 | 按任务 ID、事件类别、状态变化去重；重复失败合并 | 防止错误循环变成刷屏 |
| 入站与出站限速 | 分别实现，并限制单接收人和全局发送预算 | 一个请求可能产生多条输出，二者不能混用 |
| 有限重试 | 网络故障、可恢复服务错误采用有限退避；遵守 Retry-After 等接口信息 | 防止故障时放大发送量 |
| 拒收与无权限 | 停止该目标主动推送，记录原因，等待人工恢复或合法权限变化 | 尊重用户设置和平台拒绝 |
| 内容拒绝与封停 | 停止发送并转本地提醒，不靠改写同一内容反复提交 | 避免试探和持续违规 |
| 脱敏 | 不发令牌、完整终端环境、隐私聊天和未授权文件 | 减少数据泄露与滥用 |
| 持久化队列 | 重启后仍识别已发、待发、失败和已停用的项目 | 避免补发风暴和重复通知 |
| 备用提醒 | QQ 不可用时留下本地待办或桌面通知 | QQ 故障时仍能发现问题 |

一天一份日报只是本项目的保守初始产品设计，并非腾讯公布的安全阈值。平台是否限制账号，还取决于内容、授权、投诉和实际行为。涉及内容过滤的服务需在实施时另选并验证；单独一段 system prompt 不能承担所有输出约束。

腾讯安全须知还对接入模型提出备案等要求。未来若把 QQ 对话直接交给 Codex / OpenAI 模型，需要先核对适用条件；插件能配置某个 provider，并不等于平台认可任何接法。只转发脱敏任务状态可缩小数据流，但不自动豁免平台规则。[安全使用须知第二节](https://rule.tencent.com/rule/202603270003)

## 每日报告与异常通知的官方能力

现网消息概述已列出主动消息：单聊和群聊每天每个接收关系上限为 1000 条；用户可以关闭允许主动发送。这个数字是文档额度，不能当作当前应用已获得权限的证明，也不应作为日常发送目标。[消息收发概述，2026-07-21 更新](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)

发送接口还定义主动消息无权限、接收关系不满足、拒收等错误；例如 40034105 表示主动消息无权限。首个验证必须是：在隔天且没有新用户消息的情况下，能否主动发送一条已订阅的报告。[单聊发送接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)、[群聊发送接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)

被动回复存在时效和次数限制，当前官方单聊正文与部分参数说明还存在 60 分钟 / 5 分钟的差异。插件自身缓存常量也不能代替平台规则。设计上尽快确认收到任务，长任务完成后使用已验证的主动路径；不能依靠旧 msg_id 长期续发。互动召回有分段周期限制，也不能替代每日推送。

## Codex 通知应独立接入

推荐路线是“Codex 可用事件接口 → 本地事件接收器 → 脱敏和去重 → 通知队列 → 官方 QQ API”。DSH 对话仍可由官方插件处理，日报和任务状态不必每条都经过语言模型。

接入现有 Codex 桌面工作流，优先验证当前客户端的生命周期 hooks 能否覆盖审批、需用户处理和结束事件；若由自建执行器管理 Codex，则可使用 app-server 的结构化事件。只有已注册、已验证的任务或会话才应宣称受到监控。[OpenAI Hooks](https://learn.chatgpt.com/docs/hooks)、[App Server](https://learn.chatgpt.com/docs/app-server)

首版只通知，不在 QQ 自动批准危险操作。一次可恢复工具错误不立即报警；最终失败或明确需用户处理才进入通知队列。QQ 不可用时记录本地状态，不能让“发送告警失败”再次无限生成 QQ 告警。

## 后续验证与验收

验证应分“本地模拟错误”和“少量正常实发”。不要为了测试主动制造平台封禁或刷到真实限流。

| 验证项 | 方法 | 通过标准 |
| --- | --- | --- |
| 客户端独立 | 启停 DSH 插件，检查日常 QQ 进程、登录和收发 | 不注入、替换或重启日常 QQ；正常聊天不受干扰 |
| 本人权限 | 配置真实 OpenID；用授权测试身份验证允许与拒绝路径 | 非白名单请求不能触发 agent 工具；空白名单按修正后的设计拒绝 |
| 隔日主动消息 | 用户先同意订阅，隔天不发新消息，只投递一条日报 | 官方接口成功且目标客户端实际收到 |
| 用户关闭推送 | 关闭主动发送开关后验证一次投递 | 记录拒收，停止后续主动推送，不循环重试 |
| 限流和错误分类 | 本地模拟 429、40034105、内容拒绝、4915、断网 | 只重试可恢复错误；停用状态持久化；本地备用提醒可见 |
| 去重与重启 | 同一任务重复产生事件，进程在发送前后重启 | 不重复刷屏；状态可追踪；不把全部历史日报一次补发 |
| 数据与文件 | 使用不含真实秘密的测试数据检查日志与发送 | 自动文件交付关闭；敏感字段被遮蔽；越界文件不能发送 |
| Codex 覆盖 | 在实际使用的客户端分别触发可恢复失败、最终失败、审批等待 | 通知语义正确；未支持的事件明确记为缺口 |
| 小范围运行 | 仅本人、低频运行若干天，记录送达和错误 | 无异常发送；停止开关和故障恢复有效；这不构成长期免封证明 |

建议先做官方接入的最小可用验证，再建设完整对话 agent。若无法接受任何关联个人账号被限制的可能，就应把 QQ 定义为可选通知入口，而不承诺它承担唯一关键告警通道。

