# Save 0.4.1 验证和差异

日期：2026-11-20（上海时间）。原版提交：29a86d7323eb409131fdb28d926e3ea451eccb5c。

## 运行时代码差异

- save-custom.js：显示层隐藏原版摘要尾部；世界书入口返回空；取消角色卡全文注入；显示接管状态及次数。
- settings-custom.js：仅隔离启用配置。原版摘要、状态、文件及检查点存储路径保留。
- index.js：接入以上适配；模板和教程按实际安装目录加载；刷新接管状态。
- bridge.js：三个原生更新消息的位置刷新显示缓存，并记录非 dry-run 的中继接管次数。请求内容、调用顺序、模型参数、重试和回退保持原版。
- manifest.json / settings.html：版本、独立 ID 和对应界面说明。

17 个其余原版 JavaScript 文件保持逐字节一致，包括 llm.js、orchestrator.js、constants.js、三个 Agent、context-router.js、readers.js、settings.js、state.js、store.js、utils.js 等。原版 CSS、许可证及教程保持不变。

## 已执行检查

- 12/12 离线检查通过。普通及召回模式请求逐条严格对比原版，完全一致；未使用删除片段后再比较的归一化。
- 21 个运行时 JavaScript 文件语法检查通过。
- 独立 SillyTavern 1.18.0 前端/后端，390×844 手机视口，本地 OpenAI 格式 HTTP 模拟接口，真实 Token Usage Tracker 1.2.0。
- 原版接管开启：计费插件 input=48，显示请求数=1；实际阶段=['relay', 'writing', 'analysis']。
- 本版接管开启：计费插件 input=48，显示请求数=1；实际阶段=['relay', 'writing', 'analysis']。
- 两版的 Relay、正文、摘要完整后端请求体分别严格相同，三个请求均未额外注入角色卡。
- 原版配置 enabled=false 的条件下，本版初始开关仍为 true。离线验证还覆盖两版分别开关、重新读取配置和独立保存。
- 显示不改原文、摘要和统计字段；刷新、编辑及切换分支的显示缓存检查通过。

本地计数随分词器设置变化，上表数字不替代用户手机实际统计。没有改写计费数据，没有调用真实付费接口。

本版继续采用原版停止、保存、重试及回退逻辑，不承诺未测试的实际环境问题已经修复。
