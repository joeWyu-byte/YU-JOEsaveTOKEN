# 与 Narrative Agent 原版代码的对应

参考来源：<https://github.com/Lol1p0p/narrative-agent>，本地 ZIP 中的 **0.2.1**。原版位于 `E:\CODEXarea\joe&yuSAVEMONEY\original\narrative-agent-master`，保持不变。

| 原版代码 | 新版代码 | 保留与修改 |
|---|---|---|
| `bridge.js` `_onPromptReady`、`_onGenerationEnded` | `bridge.js` 同名方法 | 保留事件接管、两条Relay文本和返回标记后的pipeline执行顺序。补充请求隔离、停止与切换检测、普通/重生成/滑动/续写的消息处理。 |
| `orchestrator.js` `_mergedPipeline` | `orchestrator.js` `_mergedPipeline` | 保留近期窗口→构造生成上下文→`runMergedWritingAgent`→`runMergedAnalysisAgent`→追加SummaryStore→保存检查点的顺序；删除WorldInfo/MVU/工具执行和RPG事件应用。 |
| `orchestrator.js` `_fullPipeline` | `orchestrator.js` `_fullPipeline` | 原文召回时仍先规划，再取指定轮次原文，再写作、分析；删除工具执行。 |
| `orchestrator.js` `_getStableRecentTurns` | 同名方法 | **方法原样保留**。基础轮数及增长余量沿用原版3/6、4/5。 |
| `orchestrator.js` `_getRecentTurns` | 同名方法 | 方法原样保留。 |
| `agent-writing.js` | 同名文件 | 从原文件复制，保留合并/分离生成函数和消息拼接方式；删去游戏状态、工具结果和原版额外的思考规则。上下文中的worldinfo1目前承载角色卡，不读取世界书。 |
| `agent-planning.js` | 同名文件 | 从原文件复制，保留JSON规划、摘要、近期原文及原文召回需求；删除工具清单、游戏状态。 |
| `agent-analysis.js` `runMergedAnalysisAgent` | 同名函数 | 保留逐轮编号、双方原文、JSON摘要及LLM调用；删去事件提取、游戏状态。 |
| `context-router.js` | 同名文件 | 保留规划/写作/分析上下文分配；移除世界书、游戏状态和工具参数，接入角色卡。 |
| `state.js` `SummaryStore` | 同名文件/类 | **原样保留SummaryStore类**；删除RPG StateManager。 |
| `store.js` `FileManager` | 同名文件/类 | **文件原样复制**；存储前缀由本项目constants提供，隔离原插件缓存。聊天消息extras是恢复摘要的主要来源。 |
| `llm.js` `callLLM` | 同名文件/函数 | 保留`ctx.generateRaw({prompt:messages})`及网络错误默认一次重试；补取消检查和每次尝试的执行记录。 |
| `readers.js` | 同名文件 | 基于原读卡模块接入实际生成；新增getChatInfo，保留描述、性格、场景、示例、深度提示，不发送作者备注。 |
| `utils.js` `extractPresetContext` | 同名函数 | 沿用预设拆分，修复顺序/启用项/主提示/宏替换读取；增加普通消息与旧标签兼容读取、摘要来源校验、swipe更新。 |
| `parser.js` | 同名文件 | 保留JSON解析，补回原版漏读的scene_setting；裁掉事件提取和工具调用字段。 |
| `index.js`、`settings.js`、`settings.html` | `index.js`、`settings.js`、`style.css` | 移除原版跑团配置面板与硬编码模板路径，提供手机设置、摘要查看和执行记录。 |

两个会影响使用的修复：原版将摘要和内部标签写进 `mes`，本版改写进 `extra.save_na`；原版普通旧聊天没有逐轮摘要，本版补齐时复用分析模块，未补齐的旧消息仍携带原文。这些是聊天适配，不替换核心生成链路。

原版“完整链路失败再重新生成一次回复”的额外降级流程未保留，避免已经完成的回复在摘要失败后再次生成并计费。本版仍保留原网络重试规则；摘要失败保留回复和原文，不伪造摘要。

验证代码见 `tests/upstream.test.mjs`、`tests/pipeline.test.mjs`；实际浏览器请求明细见 `tests/evidence/mock-requests.json`。`UPSTREAM-PROVENANCE.json` 记录原版与当前文件哈希，区分逐字保留与裁剪重写的部分。
