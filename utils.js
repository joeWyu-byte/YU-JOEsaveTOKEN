import { MESSAGE_KEY, PLACEHOLDER } from './constants.js';

export function getSTContext() {
  try { return globalThis.SillyTavern?.getContext() ?? null; } catch { return null; }
}
export function truncate(text, maxLen) { return !text || text.length <= maxLen ? text || '' : text.substring(0, maxLen) + '...'; }
export function deepMerge(target, source = {}) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (['__proto__','constructor','prototype'].includes(key)) continue;
    result[key] = source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
      ? deepMerge(target[key] || {}, source[key]) : source[key];
  }
  return result;
}
export function getConversationId() {
  const ctx = getSTContext();
  return `${ctx?.characters?.[ctx.characterId]?.avatar || ctx?.characterId || 'none'}:${ctx?.chatId || 'none'}`;
}
export function getLatestUserInput(chat) {
  const parts = [];
  let found = false;
  for (let i = (chat?.length || 0) - 1; i >= 0; i--) {
    if (chat[i]?.is_system || chat[i]?.extra?.[MESSAGE_KEY]?.failed) continue;
    if (chat[i]?.is_user) { parts.unshift(chat[i].mes || ''); found = true; }
    else if (found) break;
  }
  return parts.join('\n\n');
}
export function substitute(text) {
  const ctx = getSTContext();
  return typeof ctx?.substituteParams === 'function' ? ctx.substituteParams(String(text || '')) : String(text || '');
}

/** Derived from original extractPresetContext, fixing enabled order, main prompt and macros. */
export function extractPresetContext(nativeMessages = []) {
  const ctx = getSTContext();
  const settings = ctx?.chatCompletionSettings || {};
  const orders = settings.prompt_order || [];
  const order = orders.find(o => String(o.character_id) === String(ctx?.characterId))?.order
    || orders.find(o => Number(o.character_id) === 100001)?.order || orders[0]?.order;
  const prompts = settings.prompts || [];
  const selected = order ? order.filter(p => p.enabled !== false).map(p => prompts.find(x => x.identifier === p.identifier)).filter(Boolean) : prompts.filter(p => p.enabled !== false);
  const fields = ctx?.getCharacterCardFields?.() || {};
  const system = [], user = [], messages = [];
  for (const prompt of selected) {
    if (prompt.marker) continue;
    let value = prompt.content || '';
    if (prompt.identifier === 'main' && fields.system) value = fields.system;
    if (prompt.identifier === 'jailbreak' && fields.jailbreak) value = fields.jailbreak;
    value = substitute(value).trim();
    if (!value) continue;
    const role = ['system','user','assistant','developer'].includes(prompt.role) ? prompt.role : 'system';
    messages.push({role,content:value,...(prompt.name ? {name:prompt.name} : {})});
    (role === 'system' || role === 'developer' ? system : user).push(value);
  }
  // Preserve native static system injections (including active world info / author notes),
  // selected non-system presets and named examples. Never copy ordinary raw chat history.
  const native = nativeMessages.filter(m => typeof m.content === 'string' && (
    ['system','developer'].includes(m.role) || /^example[_-]/i.test(m.name || '')
    || messages.some(p => p.role === m.role && p.content === m.content.trim())
  )).map(m => ({role:m.role,content:m.content,...(m.name ? {name:m.name} : {})}));
  const ordered = native.length ? native : messages;
  if (native.length) for (const message of messages) {
    if (!ordered.some(m => m.role === message.role && m.content.includes(message.content))) ordered.push(message);
  }
  // CharacterReader also supplies card fields as in the original pipeline.
  return { messages:ordered, source:native.length ? 'native-static-and-presets' : 'presets',
    planningContext: system.join('\n\n'), writingSystemContext: system.join('\n\n'), writingUserContext: user.join('\n\n') };
}
// Change detector, not a security hash; works on HTTP mobile clients without crypto.subtle.
export function contentKey(text) {
  let a = 2166136261, b = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 2246822519); }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}
export function bodyOf(message) {
  const text = String(message?.mes || '');
  const match = text.match(/<context>\s*([\s\S]*?)\s*<\/context>/i);
  return (match ? match[1] : text).trim();
}
export function extractTurns(chat) {
  const turns = [];
  let pending = [], n = 1, previous = '';
  for (let i = 0; i < chat.length; i++) {
    const msg = chat[i];
    if (msg.is_system || msg.extra?.[MESSAGE_KEY]?.failed) continue;
    if (msg.is_user) { pending.push(String(msg.mes || '')); continue; }
    if (!msg.mes || msg.mes.includes(PLACEHOLDER)) continue;
    const narrativeText = bodyOf(msg);
    const turnNum = !turns.length && !pending.length ? 0 : n++;
    const userInput = pending.join('\n\n');
    const sourceKey = contentKey(previous + JSON.stringify([turnNum, userInput, narrativeText]));
    const saved = msg.extra?.[MESSAGE_KEY];
    const legacy = msg.mes.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)?.[1];
    const entries = saved?.schema === 2 ? (saved.sourceKey === sourceKey ? saved.summaryEntries : []) : legacy ? [legacy] : [];
    const summaryEntries = Array.isArray(entries) ? entries.filter(s => typeof s === 'string' && s.trim()) : [];
    const validSource = saved?.schema === 2 && saved.sourceKey === sourceKey;
    turns.push({ turnNum, userInput, narrativeText, chatIndex:i, sourceKey, summaryEntries,
      analysisState:validSource ? saved.analysisState : undefined, blockReason:validSource ? saved.blockReason : undefined });
    previous = sourceKey; pending = [];
  }
  return turns;
}
export function updateSwipe(message) {
  const id = message.swipe_id;
  if (!Number.isInteger(id) || !Array.isArray(message.swipes)) return;
  message.swipes[id] = message.mes;
  message.swipe_info ??= [];
  message.swipe_info[id] = { ...(message.swipe_info[id] || {}), extra: structuredClone(message.extra || {}), gen_started:message.gen_started, gen_finished:message.gen_finished, send_date:message.send_date };
}
