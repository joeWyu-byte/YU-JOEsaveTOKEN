// Yu's requested changes, isolated from the original generation engine.
import { WorldInfoResolver as OriginalWorldInfoResolver } from './worldbook.js';
import { getSTContext } from './utils.js';

export class WorldInfoResolver extends OriginalWorldInfoResolver {
  constructor(stateManager) {
    super(stateManager, 'none');
  }

  // Do not inspect embedded character_book entries or load external world books.
  async _getAll() { return []; }
  _getAllFromCard() { return []; }
  async _getAllFromWorld() { return []; }
  _getWorldName() { return ''; }
  _trySyncBuildFormattingSet() { this._formattingContentSet = new Set(); }

}

let relayCount = 0;
export function getTakeoverStatus(enabled) {
  if (!enabled) return '接管已关闭：当前使用酒馆原生请求';
  return relayCount ? `接管已开启：本页已接管 ${relayCount} 次` : '接管已开启：等待发送';
}
export function noteRelayRequest() {
  relayCount++;
  if (typeof document !== 'undefined') {
    const status = document.querySelector('#save_original_takeover_status');
    if (status) status.textContent = getTakeoverStatus(true);
  }
}

const DISPLAY_KEY = 'save_original_summary_display';
function displayHash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return (value >>> 0).toString(16);
}

export function withoutSummaryFooter(raw) {
  if (typeof raw !== 'string') return null;
  const opening = /^\s*<context>\s*\n?/i.exec(raw);
  const close = raw.toLowerCase().lastIndexOf('</context>');
  if (!opening || close < opening[0].length) return null;
  const tail = raw.slice(close + '</context>'.length);
  const footer = /^\s*<summary>[\s\S]*?<\/summary>/i.exec(tail);
  if (!footer) return null;
  const narrative = raw.slice(opening[0].length, close).trim();
  const after = tail.slice(footer[0].length).trim();
  return [narrative, after].filter(Boolean).join('\n\n');
}

export function applySummaryDisplay(message) {
  if (!message || message.is_user || message.is_system) return false;
  const extra = message.extra;
  const ownership = extra?.[DISPLAY_KEY];
  const current = extra?.display_text;
  const ownsDisplay = ownership && typeof current === 'string' && ownership.hash === displayHash(current);

  // Preserve display overrides installed by another extension.
  if (current != null && !ownsDisplay) {
    if (ownership) delete extra[DISPLAY_KEY];
    return false;
  }

  const preview = withoutSummaryFooter(message.mes);
  if (preview === null) {
    if (!ownsDisplay) return false;
    delete extra.display_text;
    delete extra[DISPLAY_KEY];
    return true;
  }

  message.extra ??= {};
  message.extra.display_text = preview;
  message.extra[DISPLAY_KEY] = { version: 1, hash: displayHash(preview) };
  return current !== preview;
}

export function installSummaryDisplay() {
  const ctx = getSTContext();
  if (!ctx?.eventSource) return;
  const refreshOne = index => {
    const current = getSTContext();
    const message = current?.chat?.[Number(index)];
    if (!applySummaryDisplay(message)) return;
    if (typeof document !== 'undefined' && document.querySelector(`#chat .mes[mesid="${Number(index)}"] .edit_textarea`)) return;
    current.updateMessageBlock?.(Number(index), message);
  };
  const refreshAll = () => {
    const current = getSTContext();
    for (let i = 0; i < (current?.chat?.length || 0); i++) refreshOne(i);
  };
  for (const key of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED']) {
    if (ctx.eventTypes[key]) ctx.eventSource.on(ctx.eventTypes[key], refreshOne);
  }
  if (ctx.eventTypes.CHAT_CHANGED) ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, refreshAll);
  refreshAll();
}

export async function renderLocalSettings(ctx = getSTContext()) {
  const folder = decodeURIComponent(new URL('./', import.meta.url).pathname.split('/').filter(Boolean).at(-1));
  let render = ctx?.renderExtensionTemplateAsync;
  if (typeof render !== 'function') {
    const native = await import(new URL('../../../extensions.js', import.meta.url).href);
    render = native.renderExtensionTemplateAsync;
  }
  return await render(`third-party/${folder}`, 'settings');
}
