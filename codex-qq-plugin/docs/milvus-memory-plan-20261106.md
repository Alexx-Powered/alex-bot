# Milvus 记忆与知识检索开发交接

日期：2026-11-06。状态：开发方案，尚未实现。配套方案：[Agent 能力升级路线](agentic-roadmap-20261106.md)。

第一版让机器人能结合校园资料和用户保存的项目摘要回答问题，并为多条件自习规划提供依据。保留现有 SQLite 偏好记忆，增加可重建的 Milvus 语义索引。业务代码继续放在 Python LangChain，Node.js 负责 QQ 接入、身份与权限、请求预算和最终投递。

## 当前基础与开发范围

| 已有实现 | 开发时的用法 |
| --- | --- |
| [chat_memory.py](../python/chat_memory.py) | 稳定自述、称呼、回复风格、偏好与项目记忆；单命名空间最多 24 条，SQLite 当前上限 4 MiB。保留接口与数据。 |
| [social_memory.py](../python/social_memory.py) | 另有有限事件、交流统计和媒体摘要。其推断性内容不自动作为知识事实入库。 |
| [campus_recommendations.py](../python/campus_recommendations.py) | 根据结构化校园快照和课节时间计算候选。实时空闲状态仍由该类工具处理。 |
| [agent_worker.py](../python/agent_worker.py) | 已有受限 LangChain 工具。新增检索工具在这里接入，随后为多步规划提供观察结果。 |
| [conversation-agent.mjs](../src/conversation-agent.mjs) | 可信身份、群权限和 Node/Python 工具桥的接入位置。 |

当前 24 条稳定偏好使用直接读取与关键词匹配即可覆盖不少需求。第一版优先增加校园知识和用户主动保存的项目摘要；是否把更多稳定偏好向量化，根据语义改写问题的对照结果决定。

第一版不迁移现有记忆表，不修改其上限，不收录全部聊天记录。原始气象格点、雷达图和视频继续保存在业务文件缓存；当日天气与教室占用继续由实时工具或带时效的结构化缓存提供。

## 数据入库选择

| 优先级 | 内容 | 原文与来源 | 典型问题 |
| --- | --- | --- | --- |
| P0 | 校园知识 | 有出处的楼宇位置、设施、开放规则和自习说明；未知设施保持未知 | 哪些教学楼符合我对自习环境的要求？ |
| P0 | 个人项目摘要 | 用户明确要求保存的目标、阶段进展、已确认结论；关联原始请求 | 上次讨论这个项目时确定了什么？ |
| P1 | 气象解释知识 | 官方指标释义、观测与预报区别、数据源覆盖与时间分辨率；项目自定义指数单独标注 | 为什么预报有雨而当前雷达没有回波？ |
| P1 | 项目资料 | 用户指定导入的设计文档、论文或课程资料，保留章节和版本 | 比较几份方案的差异，并找出适合当前项目的做法。 |
| P1 | 语义偏好 | 现有记忆中通过校验的自述；仅在语义召回评测优于直接读取时建立索引 | 按我之前的习惯选一个自习地点。 |

公共资料按标题、自然段和完整规则切块，第一轮采用约 300—600 个中文字符的小块作为调参起点。包含时间、例外条件的规则不拆散。楼宇别名先用现有区域目录标准化；插座、安静程度、开放条件等属性只有在来源支持时才进入候选筛选。

个人项目摘要与普通偏好分开保存。模型提出的摘要先作为候选；只有当前请求明确要求保存且摘要有用户原文依据时才落库。新进展形成版本，保留替代关系，不能把旧目标和最新目标混在一起。

## 存储与索引设计

新增独立 SQLite 文件 `rag-store.sqlite3`，由运行配置指定私有目录，避免挤占现有 4 MiB 记忆数据库。它保存本轮新增资料的原文与版本。Milvus 是检索索引，可以从原文重建。

建议的 SQLite 表如下，名称为待实现接口：

| 表 | 关键字段 | 用途 |
| --- | --- | --- |
| `rag_documents` | `doc_id, namespace, visibility, domain, source_ref, title, revision, status, valid_from, valid_until, content_hash` | 逻辑文档、范围、来源和当前版本；`status` 区分有效、替代、删除。 |
| `rag_chunks` | `chunk_id, doc_id, revision, ordinal, text, content_hash` | 完整可核对的文本片段。 |
| `index_outbox` | `event_id, target_collection, record_id, revision, operation, status, attempts` | 原文提交后待执行的向量索引更新；同对象合并待处理事件，设容量与失败上限。 |
| `index_manifests` | `collection, schema_version, embedding_model, embedding_revision, dimension, source_watermark` | 确认一个索引使用什么模型和原文版本，支持重建与切换。 |

Milvus 第一版分为两类 collection：`knowledge_chunks_v1` 与 `project_notes_v1`。前者保存校园和气象资料，后者保存用户主动留下的项目摘要。后续如需偏好索引，再增加 `memory_index_v1`，避免在第一版直接改造所有旧记忆写入路径。

每个向量实体至少包含 `record_id, doc_id, revision, chunk_id, namespace, visibility, domain, valid_from, valid_until, embedding_model, vector`。可保留短文本供诊断，但最终回答使用 SQLite 回源后的有效原文。向量维度与模型版本按 collection 固定；更换嵌入模型时新建索引并完成重建，再切换配置。

用户和会话范围由可信接入层注入，模型不能传入任意用户 ID、collection 名称或过滤表达式。共享知识只搜索管理员已导入且当前权限允许的集合。Milvus 支持在向量近邻搜索前按元数据缩小范围，适合实现上述范围与有效期过滤。[Milvus 过滤检索文档](https://milvus.io/docs/filtered-search.md)

## 写入 更新和删除流程

1. 导入器读取已选定的资料或当前用户要求保存的项目摘要，提取出处、适用范围、更新时间和内容哈希。
2. 在同一个 SQLite 事务里写入文档、片段及 outbox 事件。无需等待 Milvus 成功后才保存原文。
3. 索引 worker 批量生成 embedding，按记录 ID 幂等写入 Milvus。记录 ID 包含原文版本和片段序号。
4. 文档更新时先推进 SQLite 当前版本，再生成新索引。搜索过程中旧版本候选会被回源检查剔除；新版本暂未索引时可用词法检索补充。
5. 删除时先在 SQLite 标记失效，再异步移除向量。生成答案前重新确认所用原文仍有效；不能因向量删除滞后而继续引用已删除记忆。
6. 重启后处理尚未完成的 outbox。索引异常可重建，不能影响原文的更新与删除。

后续给旧偏好建立索引时，需在原记忆写入事务内记录索引事件，或使用明确的版本扫描机制；不能简单执行“写 SQLite 后调用 Milvus”并假设两次写入永远一起成功。旧数据库仍是旧记忆的权威来源。

## 检索与回答流程

先判断请求需要什么数据：称呼、回复风格等固定字段直接读取；天气和教室占用调用业务工具；需要回忆项目细节或解释领域知识时才检索 Milvus。

语义检索流程为：解析领域与实体 → 注入用户范围和有效期 → 召回候选 → SQLite 回源校验版本 → 合并与排序 → 返回少量证据片段 → 生成回答。第一版可取前 12 条候选、最多 4 条证据作为调参起点；不足时返回不足，不为凑数量放宽用户范围。

校园教室号、楼宇简称等更依赖精确词，语义同义表达更适合向量检索。先分别记录词法与向量基线，再评估混合检索和重排是否带来收益。中文词法通道需保留教室号并明确分词方式，不能默认英文分词规则适合中文。

回答中的实时值来自业务工具。知识库用于解释、补充设施资料和偏好依据。没有来源的设施信息不能参与硬条件判定；气象解释材料不能覆盖当前预报数值。检索到的文本只作为数据，不能修改工具权限或执行范围。

## LangChain 工具接口

以下是新接口建议，均由 Python 实现；实际参数采用严格 Pydantic schema。

| 工具 | 模型可填写参数 | 返回结果 |
| --- | --- | --- |
| `search_domain_knowledge` | `query, domain, limit` | 证据片段、来源、版本、适用范围及缺失项。 |
| `recall_project_notes` | `query, project_key, limit` | 当前用户当前范围内的项目摘要与版本时间。 |
| `save_project_note` | `project_key, text` | 保存结果与记录 ID；用户身份和依据消息由服务端绑定。 |

新查询工具返回结构化数据，而不是直接发送 QQ。建议统一包含 `schema_version, status, evidence, missing_fields, timings`；证据包含原文 ID、片段 ID、当前版本和来源。检索分数仅用于排序，不展示成事实正确概率。

固定问法可直接 invoke 相同工具；自然语言由 agent 选择。缺少 Milvus、embedding 配置或索引不可用时，保留既有聊天与查询功能，知识问答返回可解释的降级结果。

## 运行环境与依赖

2026-11-06 本机环境读取结果：`langchain 1.4.7`、`langgraph 1.2.18`、`langgraph-checkpoint 4.3.1`；未安装 `pymilvus`、`milvus-lite` 和 `langgraph-checkpoint-sqlite`。这是开发环境记录，不能代替部署版本核对。

开发阶段在独立环境中验证 Milvus Lite，锁定 Python、PyMilvus、Lite 与 embedding 模型版本。官方文档将 Lite 定位于本地开发和小规模工作负载，并提示其不同代际存在存储格式差异；安装和迁移以实际选定版本为准。[Milvus Lite 文档](https://milvus.io/docs/milvus_lite.md)

现有 ECS 为 2GB 内存。官方 Standalone 文档列出至少 8GB 内存、建议 16GB，因此本轮不在该 ECS 上直接部署完整 Standalone。[Standalone 硬件要求](https://milvus.io/docs/prerequisite-docker.md)

生产候选有两种：Lite 经与 Bot、浏览器和视频 worker 共存的资源实测后使用；或把向量服务部署到独立资源，ECS 只保留客户端。语料 embedding 尽量在开发机或独立 worker 批处理，在线查询仍需要同一模型的 query embedding。第一版不在现有 ECS 中常驻大型 embedding 或重排模型。

具体 embedding 提供方尚待选择。选型先比较中文同义问法、楼宇实体召回、单次 query 延迟与内存，再锁定 `model_id / revision / dimension`。开发时使用真实 embedding 跑一批独立问题，不能把随机向量 smoke test 当语义检索验收。

## 文件落点与开发顺序

以下路径为建议新增，尚不存在：

| 步骤 | 建议文件 | 交付与验收 |
| --- | --- | --- |
| 1 | `python/rag_store.py`、`python/rag_schema.py` | SQLite 原文、版本、过期与删除；同事务 outbox。 |
| 2 | `python/embedding_provider.py`、`python/vector_index.py` | 可替换 provider；真实 Milvus Lite 插入、检索、过滤、重启与删除。 |
| 3 | `scripts/ingest-knowledge.py`、`python/knowledge_ingest.py` | 白名单资料导入、切块、去重、增量更新；重复导入不增加重复片段。 |
| 4 | `python/rag_retriever.py`、`python/rag_tools.py` | 元数据过滤、回源、候选融合、证据返回；接入真实 LangChain 调用。 |
| 5 | `evals/rag/`、`scripts/evaluate-rag.py` | 问题集、相关文档标注、召回与答案检查、结果明细。 |
| 6 | 既有 worker 与配置桥 | 可选配置缺省兼容；模型不可配置路径、身份与任意索引名。 |

开工先建立少量有来源的校园资料和项目摘要测试库，冻结一批真实问法。第一版至少覆盖同义改写、教室号精确查询、无答案、版本替换、时间失效、同题不同用户、删除后查询、索引落后和 Milvus 离线等场景。

验收分别测 Recall@5、最终证据是否支持结论、项目摘要召回是否属于当前范围、响应时间及 embedding 成本。记录样本数、模型版本、语料版本和查询条件。用户满意度、检索准确率与响应改进在实测前不填写百分比。

备份以原文、配置和索引 manifest 为核心；向量索引必须有可执行的重建流程。新 SQLite 文件要接入项目现有的一致性备份机制，后续恢复演练再确认索引可重建。本轮只制定方案，不修改当前有未提交变更的 `ops/backup.mjs`。

## 接手者的第一项任务

先做只读原型：导入校园资料与人工构造的项目摘要，在独立 Milvus Lite 环境跑通“同义提问 → 正确范围 → 有效原文 → 带来源答案”。同时保留词法基线。该结果通过后，再实现用户保存、更新、删除及在线工具接入；生产发布仍遵循根目录 AGENTS.md 和 ops/README.md。
