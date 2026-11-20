// Preserve ST's compiled prompts. Only summarized history is compressed.
import { getSTContext } from './utils.js';
import { getGenerationSession } from './generation-session.js';
import { withoutSummaryFooter } from './save-custom.js';

let latest = null;
let installed = false;
let regexHelpers = null;

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const normalize = value => String(value ?? '').replace(/\r\n/g, '\n').trim();
const contentText = content => typeof content === 'string' ? content :
  Array.isArray(content) ? content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';

function toMessage(item) {
  return {
    role: item.role, content: clone(item.content),
    ...(item.name ? { name: item.name } : {}),
    ...(item.tool_calls ? { tool_calls: clone(item.tool_calls) } : {}),
    ...(item.role === 'tool' ? { tool_call_id: item.identifier } : {}),
    ...(item.signature ? { signature: item.signature } : {}),
    ...(item.reasoning ? { reasoning: item.reasoning } : {}),
  };
}

function flatten(item, path = []) {
  const id = item.identifier || '';
  if (typeof item.getCollection === 'function') return item.getCollection().filter(Boolean).flatMap(child => flatten(child, [...path, id]));
  if (!item.role || (!item.content && !item.tool_calls)) return [];
  return [{ identifier: id, path, message: toMessage(item), sourceIndex: null }];
}

export function captureNativeCompletion(completion, ctx = getSTContext(), regex = regexHelpers) {
  const root = completion.getMessages();
  const nodes = flatten(root);
  const raw = (ctx.chat || []).map((m, index) => ({ index, role: m.is_user ? 'user' : 'assistant', is_system: m.is_system, mes: m.mes || '', owned: m.extra?.save_native_writer === 1 }));
  const candidates = raw.filter(m => !m.is_system && m.mes);
  let cursor = candidates.length - 1;
  // Match from the end so repeated short replies keep their original identity.
  for (const node of [...nodes].reverse()) {
    if (!node.path.includes('chatHistory') || !/^chatHistory-/.test(node.identifier)) continue;
    const text = normalize(contentText(node.message.content));
    for (let i = cursor; i >= 0; i--) {
      const source = candidates[i];
      if (source.role !== node.message.role) continue;
      let expected = source.mes;
      if (regex?.getRegexedString) expected = regex.getRegexedString(expected,
        source.role === 'user' ? regex.regex_placement.USER_INPUT : regex.regex_placement.AI_OUTPUT,
        { isPrompt: true, depth: candidates.length - i - 1 });
      const target = normalize(expected);
      if (!target || !(text === target || text.includes(target))) continue;
      node.sourceIndex = source.index;
      cursor = i - 1;
      break;
    }
  }
  return { nodes, raw, chat: ctx.chat, chatId: ctx.getCurrentChatId?.() ?? ctx.chatMetadata?.chat_id, captured: Date.now() };
}

export async function installNativePromptCapture(isEnabled, isRunning) {
  if (installed) return;
  const [openai, regex] = await Promise.all([
    import(new URL('../../../openai.js', import.meta.url).href),
    import(new URL('../../regex/engine.js', import.meta.url).href),
  ]);
  regexHelpers = regex;
  const manager = openai.promptManager;
  if (!manager?.setChatCompletion) throw new Error('当前酒馆缺少原生提示编译接口');
  const original = manager.setChatCompletion;
  manager.setChatCompletion = function (completion) {
    // Snapshot before ST squashes system messages, while source groups exist.
    if (isEnabled() && !isRunning()) latest = captureNativeCompletion(completion);
    return original.call(this, completion);
  };
  const ctx = getSTContext();
  if (ctx.eventTypes.WORLDINFO_SCAN_DONE) ctx.eventSource.on(ctx.eventTypes.WORLDINFO_SCAN_DONE, args => {
    if (!isEnabled()) return;
    // Native scanning may run before prompt compilation. Do not let any WI
    // position (including depth, examples and author's note) enter this run.
    args.activated?.entries?.clear();
    if (args.activated) args.activated.text = '';
  });
  installed = true;
}

export function takeNativePromptSnapshot(ctx = getSTContext()) {
  const snapshot = latest;
  latest = null;
  return snapshot?.chat === ctx.chat ? snapshot : null;
}

export function hasNativeWriter() { return !!getGenerationSession()?.snapshot; }

export function buildNativeWritingMessages(writing) {
  const run = getGenerationSession();
  run.assertActive();
  const snapshot = run.snapshot;
  if (!snapshot) throw new Error('本轮原生提示快照不可用');
  const recent = writing.recentTurns || writing.recentNarratives || [];
  const recentNumbers = new Set(recent.map(t => t.turnNum));
  const store = run.orchestrator.summaryStore;
  const summaries = store.getEntryCount() === 0 ? '' : store.getAllSummaries();
  const summarized = new Set([...summaries.matchAll(/\[第(\d+)轮\]/g)].map(m => Number(m[1])));
  const discard = new Set();
  for (const turn of run.turns || []) {
    if (recentNumbers.has(turn.turnNum) || !summarized.has(turn.turnNum)) continue;
    discard.add(turn.chatIndex);
    // Keep unsummarized messages and unmatched native injections verbatim.
    const user = snapshot.raw.slice(0, turn.chatIndex).findLast(m => m.role === 'user' && !m.is_system);
    if (user) discard.add(user.index);
  }
  let insertedMemory = false;
  const messages = [];
  for (const node of snapshot.nodes) {
    if (node.path.includes('worldInfoBefore') || node.path.includes('worldInfoAfter') || /^worldInfo/.test(node.identifier)) continue;
    const inHistory = node.path.includes('chatHistory');
    if (inHistory && !insertedMemory && summaries) {
      messages.push({ role: 'system', content: `<story_summary>\n${summaries}\n</story_summary>` });
      insertedMemory = true;
    }
    if (inHistory && discard.has(node.sourceIndex)) continue;
    const message = clone(node.message);
    if (inHistory && node.sourceIndex != null && message.role === 'assistant') {
      const source = snapshot.raw[node.sourceIndex];
      const plainSource = withoutSummaryFooter(source.mes, source.owned);
      if (plainSource !== null && typeof message.content === 'string' && message.content.includes(source.mes)) {
        // Preserve a user-enabled native reasoning prefix around our envelope.
        message.content = message.content.replace(source.mes, plainSource);
      } else {
        const body = withoutSummaryFooter(contentText(message.content), source.owned);
        if (body !== null && typeof message.content === 'string') message.content = body;
      }
    }
    messages.push(message);
  }
  if (writing.textRecall) {
    const text = typeof writing.textRecall === 'string' ? writing.textRecall : JSON.stringify(writing.textRecall);
    // Recall is factual context, not a new writing guide or tone instruction.
    const position = messages.findLastIndex(m => m.role === 'user');
    messages.splice(position < 0 ? messages.length : position, 0, { role: 'system', content: `<text_recall>\n${text}\n</text_recall>` });
  }
  if (!messages.length) throw new Error('酒馆本轮没有可用的聊天提示');
  run.promptAudit = {
    nativeMessages: snapshot.nodes.length, writerMessages: messages.length,
    removedHistoryMessages: snapshot.nodes.filter(n => n.path.includes('chatHistory') && discard.has(n.sourceIndex)).length,
  };
  return messages;
}
