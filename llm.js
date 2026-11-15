// Derived from Narrative Agent callLLM: same generateRaw route and network retry policy.
import { getSTContext } from './utils.js';
let activeSession = null;
export function setCallSession(session) { activeSession = session; }
export async function callLLM(messages, options = {}) {
  const session = activeSession;
  const maxRetries = options.retries ?? 1;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    session?.check();
    const record = { stage:options.label || 'raw', attempt:attempt + 1, status:'pending', inputChars:JSON.stringify(messages).length };
    session?.requests.push(record);
    try {
      const ctx = getSTContext();
      if (!ctx?.generateRaw) throw new Error('当前酒馆没有 generateRaw 接口');
      const text = extractText(await ctx.generateRaw({ prompt:messages }));
      session?.check();
      if (!text?.trim()) throw new Error('API 返回空内容');
      record.status = 'complete'; record.outputChars = text.length;
      return text;
    } catch (e) {
      record.status = 'failed'; lastErr = e;
      session?.check();
      if (isAbortError(e)) throw new Error('Pipeline cancelled');
      if (!isRetryable(e)) break;
    }
  }
  throw lastErr;
}
export function extractText(result) {
  if (typeof result === 'string') return result;
  if (result?.choices?.[0]?.message?.content) return result.choices[0].message.content;
  if (result?.message?.content) return result.message.content;
  return '';
}
export function isAbortError(err) { return /abort|cancel|中断/i.test(err?.message || ''); }
export function isRetryable(err) { return /fetch|network|ECONN|timeout|ETIMEDOUT|429|rate|\b5\d{2}\b/i.test(err?.message || ''); }
