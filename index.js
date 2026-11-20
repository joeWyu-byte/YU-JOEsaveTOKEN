import { SummaryStore } from './state.js';
import { FileManager } from './store.js';
import { CharacterReader, UserPersonaReader } from './readers.js';
import { Orchestrator } from './orchestrator.js';
import { ChatContentSource } from './compat.js';
import { SillyTavernBridge } from './bridge.js?v=0.3.0';
import { loadConfig, mountSettings } from './settings.js?v=0.3.0';
import { getSTContext, getConversationId } from './utils.js';

export async function initExtension() {
  const ctx = getSTContext();
  if (!ctx?.eventSource || !ctx?.eventTypes) throw new Error('SillyTavern context 未就绪');
  if (globalThis.SaveNarrativeLite) return globalThis.SaveNarrativeLite;
  let status = '已加载原版接管链路；尚未执行生成。';
  let refresh = () => {};
  const config = loadConfig();
  const orchestrator = new Orchestrator({
    summaryStore:new SummaryStore(), fileManager:new FileManager(getConversationId()),
    characterReader:new CharacterReader(), userPersonaReader:new UserPersonaReader(), contentSource:new ChatContentSource(), config,
  });
  const bridge = new SillyTavernBridge(orchestrator, text => { status = text; refresh(); });
  bridge.enabled = config.enabled;
  bridge.install();
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
    orchestrator.fileManager = new FileManager(getConversationId());
    status = '已切换聊天；将从当前聊天数据重新读取摘要。'; refresh();
  });
  refresh = mountSettings({ config, bridge, getStatus:() => status, onConfig:next => {
    bridge.enabled = next.enabled; orchestrator.config = next;
    if (!next.enabled) bridge.cancel();
    status = next.enabled ? '已启用原版接管链路，等待下一次回复。' : '已停用；下次回复使用酒馆原生请求。';
  } });
  const api = { version:'0.3.0', bridge, orchestrator };
  globalThis.SaveNarrativeLite = api;
  return api;
}
function boot() {
  initExtension().catch(error => {
    console.error('[Save] 初始化失败', error);
    globalThis.toastr?.error(`Save 加载失败：${error.message}`);
  });
}
if (typeof document !== 'undefined') {
  if (typeof globalThis.$ === 'function') globalThis.$(boot);
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once:true});
  else boot();
}
