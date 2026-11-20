# Save 0.4.0 · 原版最小补丁

根据 Yu 于 2026-11-20 确认的范围制作，以本次重新下载的 [Lol1p0p/narrative-agent](https://github.com/Lol1p0p/narrative-agent) 原版为基础。GitHub HEAD 已核实为 `29a86d7323eb409131fdb28d926e3ea451eccb5c`，原版版本号为 0.2.1。

## 这一版的两项改动

1. **隐藏回复结尾的“轮次、用户意图、叙事要点”。** 仅改变聊天气泡显示，完整正文及 `<summary>` 摘要仍按原版保存、读取并用于后续上下文。
2. **插件不读取世界书。** 不读取角色卡内嵌 `character_book` 条目或外部世界书。角色卡通过原版 `CharacterReader.getFullInfo()` 读取，接入原有上下文位置；用户设定和预设继续走原版路径。

正文使用酒馆原生排版。本补丁不修改对话内容、字体或颜色规则。原始聊天导出和原生源码编辑中仍可能看到内部标签和摘要，这些数据用于原版上下文及恢复。

## 上传 GitHub / 安装

这个 ZIP 内只有一套文件，**解压后的全部文件都上传到 GitHub 仓库根目录**，与 `manifest.json` 放在同一层，覆盖同名文件；不要上传 ZIP 本身，也不要多套一层文件夹。

在酒馆扩展管理中更新后刷新页面，应看到 **Save 0.4.0 · 原版最小补丁**。通过新仓库安装时，使用你自己的仓库地址。

在扩展管理中禁用其他旧 Save 和原 Narrative Agent，只运行这一份；首次替换前可导出当前聊天备份。本版沿用原版的 `narrative-agent` 数据命名空间，读取原版配置和摘要；不自动迁移旧 Save 的专有设置。

## 原版流程的保留

17 个原版 JavaScript 文件完全未改，包括 `llm.js`、`orchestrator.js`、`constants.js`、全部 Agent、`context-router.js`、`readers.js`、`state.js`、`store.js`、`settings.js`、`utils.js` 等。原版的样式、许可证和教程也未改。

保留原版 Relay、`generateRaw({ prompt: messages })`、预设提取、近期窗口、逐轮摘要、存储、重试、回退和停止逻辑。本次没有加入 0.3.0 的生成框架、思考响应适配、旧历史批量分析或额外模型请求，也没有裁掉原版 RPG/MVU/状态代码。世界书中的工具定义因不读取世界书而不会加载。

一般每轮为 Relay、正文、摘要 3 次请求；开启原文召回时一般为 4 次。原版开场分析和失败恢复条件仍可能增加请求。

## 计数说明

本版不修改酒馆计费插件，也不修改 `token_count`、API 用量字段或模型参数。“30 多 input”需要区分是否只统计了 Relay；整轮用量应包含实际发出的全部请求。本补丁不承诺整轮实际输入只有 30 多 token。

## 核对资料

`PATCH-NOTES.md` 记录全部代码改动和验证结果；`UPSTREAM-PROVENANCE.json` 记录原版提交和文件哈希。`UPSTREAM-README.md` 与 `TUTORIAL.html` 是保留的原作者说明，其中世界书章节不代表本定制版会读取世界书。

实际手机浏览器和真实付费模型仍需安装后验证；本地模拟模型检查不代表真实接口的内容、费用或服务商返回已经验证。

原作版权及 MIT 许可见 `LICENSE`。
