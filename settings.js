import { DEFAULT_CONFIG, EXTENSION_ID, MESSAGE_KEY } from './constants.js';
import { getSTContext, getConversationId, deepMerge, extractTurns } from './utils.js';

export function loadConfig() {
  const ctx = getSTContext();
  const saved = ctx?.extensionSettings?.[EXTENSION_ID] || {};
  const config = deepMerge(DEFAULT_CONFIG, saved);
  for (const name of ['recentTurnsForPlanning','recentTurnsForWriting']) config.pipeline[name] = Math.max(1, Math.min(20, Number(config.pipeline[name]) || DEFAULT_CONFIG.pipeline[name]));
  for (const name of ['planningGrowthMargin','writingGrowthMargin']) config.pipeline[name] = Math.max(0, Math.min(20, Number(config.pipeline[name]) || 0));
  for (const name of ['relayMs','requestMs','analysisMs','saveMs']) config.timeouts[name] = Math.max(name==='saveMs'?2000:10000,Math.min(600000,Number(config.timeouts[name]) || DEFAULT_CONFIG.timeouts[name]));
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
    <div class="inline-drawer-toggle inline-drawer-header"><b>Save · 原版源码裁剪版 0.3.0</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
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
      <details><summary>请求等待上限</summary>
        <p>超时会结束当前步骤并恢复操作。聊天保存不占用生成锁；未保存内容可导出备份。</p>
        <label class="save-na-field">回复超时（秒）<input class="text_pole" type="number" min="10" max="600" data-timeout="requestMs"></label>
        <label class="save-na-field">摘要/规划超时（秒）<input class="text_pole" type="number" min="10" max="600" data-timeout="analysisMs"></label>
      </details>
      <p class="save-na-note">请关闭原 Narrative Agent 和其他自动裁剪功能。默认每轮通常 3 次请求，召回通常 4 次；首次开场分析和技术故障恢复另计。旧历史不会自动批量分析。费用需合计全部请求。</p>
      <p id="save-na-status" role="status"></p>
      <details id="save-na-details"><summary>当前摘要与本轮执行记录</summary><pre id="save-na-preview"></pre></details>
      <button type="button" class="menu_button save-na-button" id="save-na-refresh">刷新执行记录</button>
      <button type="button" class="menu_button save-na-button" id="save-na-export">导出执行记录</button>
      <button type="button" class="menu_button save-na-button" id="save-na-recovery">导出未保存备份</button>
      <button type="button" class="menu_button save-na-button" id="save-na-retry-save">重试保存当前聊天</button>
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
  for (const input of panel.querySelectorAll('[data-timeout]')) {
    const key=input.dataset.timeout; input.value=config.timeouts[key]/1000;
    input.addEventListener('change',()=>{config.timeouts[key]=Math.round(Math.max(10,Math.min(600,Number(input.value)||10))*1000);input.value=config.timeouts[key]/1000;update();});
  }
  function refresh() {
    panel.querySelector('#save-na-status').textContent = getStatus();
    const summaries = extractTurns(getSTContext().chat || []).flatMap(t => t.summaryEntries);
    panel.querySelector('#save-na-preview').textContent = `已保存摘要：${summaries.length} 条\n${summaries.join('\n') || '暂无摘要'}\n\n执行记录（字符数不是账单 Token 数）：\n${JSON.stringify(bridge.lastRun, null, 2) || '尚未执行'}`;
  }
  panel.querySelector('#save-na-refresh').addEventListener('click', refresh);
  panel.querySelector('#save-na-details').addEventListener('toggle', refresh);
  panel.querySelector('#save-na-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ version:'0.3.0', ...bridge.lastRun }, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = 'save-run-log.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  panel.querySelector('#save-na-recovery').addEventListener('click',()=>{
    const contents=bridge.persistence.exportText();
    if(!contents){globalThis.toastr?.info('当前聊天没有未保存的备份。');return;}
    const blob=new Blob([contents],{type:'application/x-ndjson'});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download='save-unsaved-chat.jsonl';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  panel.querySelector('#save-na-retry-save').addEventListener('click',async()=>{
    if(bridge.isPipelineRunning||bridge._pending?.intercepted)return;
    const ctx=getSTContext();const key=getConversationId();
    const record=await bridge.persistence.save(ctx,key,{stage:'manual-save',timeoutMs:config.timeouts.saveMs,records:bridge.lastRun?.saves||[],onUpdate:()=>{if(bridge.lastRun)bridge.lastRun.unsaved=!!bridge.persistence.get(key);refresh();}});
    const ok=['saved','saved-late'].includes(record.status);
    globalThis.toastr?.[ok?'success':'warning'](ok?'当前聊天已确认保存。':'仍未确认保存，请导出未保存备份。');refresh();
  });
  target.append(panel); refresh();
  return refresh;
}
