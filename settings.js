import { DEFAULT_CONFIG, EXTENSION_ID, MESSAGE_KEY } from './constants.js';
import { getSTContext, deepMerge, extractTurns } from './utils.js';

export function loadConfig() {
  const ctx = getSTContext();
  const saved = ctx?.extensionSettings?.[EXTENSION_ID] || {};
  const config = deepMerge(DEFAULT_CONFIG, saved);
  for (const name of ['recentTurnsForPlanning','recentTurnsForWriting']) config.pipeline[name] = Math.max(1, Math.min(20, Number(config.pipeline[name]) || DEFAULT_CONFIG.pipeline[name]));
  for (const name of ['planningGrowthMargin','writingGrowthMargin']) config.pipeline[name] = Math.max(0, Math.min(20, Number(config.pipeline[name]) || 0));
  return config;
}
export function saveConfig(config) {
  const ctx = getSTContext();
  ctx.extensionSettings[EXTENSION_ID] = config;
  ctx.saveSettingsDebounced?.();
}
export function mountSettings({ config, bridge, onConfig, getStatus }) {
  const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
  if (!target) throw new Error('找不到酒馆扩展设置容器');
  document.getElementById('save-na-panel')?.remove();
  const panel = document.createElement('div');
  panel.id = 'save-na-panel'; panel.className = 'extension_container';
  panel.innerHTML = `<div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><b>Save · Narrative 精简版 0.2.2</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content">
      <label class="save-na-check"><input type="checkbox" id="save-na-enabled"> 启用省 Token 接管</label>
      <p>沿用原版的短请求接管 → 回复生成 → 每轮摘要。聊天正文只显示回复。</p>
      <label class="save-na-check"><input type="checkbox" id="save-na-recall"> 原文召回（增加一次规划请求）</label>
      <details><summary>近期原文窗口（原版默认值）</summary>
        <p>轮数按“你的一次输入＋Joe 的一次回复”计算。窗口逐步增长，超过上限后回缩。</p>
        <label class="save-na-field">回复窗口基础轮数<input class="text_pole" type="number" min="1" max="20" data-config="recentTurnsForWriting"></label>
        <label class="save-na-field">回复窗口增长余量<input class="text_pole" type="number" min="0" max="20" data-config="writingGrowthMargin"></label>
        <label class="save-na-field">召回规划基础轮数<input class="text_pole" type="number" min="1" max="20" data-config="recentTurnsForPlanning"></label>
        <label class="save-na-field">召回规划增长余量<input class="text_pole" type="number" min="0" max="20" data-config="planningGrowthMargin"></label>
      </details>
      <p class="save-na-note">请关闭原 Narrative Agent、Horae、内置总结和其他自动裁剪功能。默认每轮有 3 次 API 请求；启用原文召回通常为 4 次，接入旧聊天时可能额外补摘要。费用应包含全部请求。</p>
      <p id="save-na-status" role="status"></p>
      <details id="save-na-details"><summary>当前摘要与本轮执行记录</summary><pre id="save-na-preview"></pre></details>
      <button type="button" class="menu_button save-na-button" id="save-na-refresh">刷新执行记录</button>
      <button type="button" class="menu_button save-na-button" id="save-na-export">导出执行记录</button>
      <button type="button" class="menu_button save-na-button" id="save-na-reset">清除当前聊天的 Save 摘要</button>
    </div></div>`;
  const enabled = panel.querySelector('#save-na-enabled'); enabled.checked = config.enabled;
  const recall = panel.querySelector('#save-na-recall'); recall.checked = config.pipeline.enableTextRecall;
  const update = () => { saveConfig(config); onConfig(config); refresh(); };
  enabled.addEventListener('change', () => { config.enabled = enabled.checked; update(); });
  recall.addEventListener('change', () => { config.pipeline.enableTextRecall = recall.checked; update(); });
  for (const input of panel.querySelectorAll('[data-config]')) {
    const key = input.dataset.config; input.value = config.pipeline[key];
    input.addEventListener('change', () => {
      config.pipeline[key] = Math.floor(Math.max(Number(input.min), Math.min(20, Number(input.value) || 0)));
      input.value = config.pipeline[key]; update();
    });
  }
  function refresh() {
    panel.querySelector('#save-na-status').textContent = getStatus();
    const summaries = extractTurns(getSTContext().chat || []).flatMap(t => t.summaryEntries);
    panel.querySelector('#save-na-preview').textContent = `已保存摘要：${summaries.length} 条\n${summaries.join('\n') || '暂无摘要'}\n\n执行记录（字符数不是账单 Token 数）：\n${JSON.stringify(bridge.lastRun, null, 2) || '尚未执行'}`;
  }
  panel.querySelector('#save-na-refresh').addEventListener('click', refresh);
  panel.querySelector('#save-na-details').addEventListener('toggle', refresh);
  panel.querySelector('#save-na-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version:'0.2.2', ...bridge.lastRun }, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = 'save-run-log.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  panel.querySelector('#save-na-reset').addEventListener('click', async () => {
    if (bridge.isPipelineRunning || bridge._pending?.intercepted) return;
    const ctx = getSTContext();
    const records = ctx.chat.map(m => m.extra?.[MESSAGE_KEY]);
    for (const m of ctx.chat) {
      if (m.extra?.[MESSAGE_KEY]?.schema === 2) delete m.extra[MESSAGE_KEY];
      for (const info of m.swipe_info || []) if (info?.extra) delete info.extra[MESSAGE_KEY];
    }
    try { await ctx.saveChat?.(); }
    catch (e) { ctx.chat.forEach((m,i) => { if (records[i]) { m.extra ??= {}; m.extra[MESSAGE_KEY] = records[i]; } }); }
    refresh();
  });
  target.append(panel); refresh();
  return refresh;
}
