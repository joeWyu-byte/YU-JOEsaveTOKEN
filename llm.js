// Narrative Agent raw-generation route; preserve response metadata and classify failures.
import { getSTContext } from './utils.js';
import { decodeWritingResponse, extractText } from './response.js';
import { ProviderBlockedError, blockReasonOf, isProviderBlocked, describeFailure } from './errors.js';
export { extractText } from './response.js';
let activeSession = null;
export function setCallSession(session) { activeSession = session; }
export async function callLLM(messages, options = {}) {
  const session = activeSession;
  const maxRetries = options.retries ?? 1;
  const stage = options.label || 'raw';
  const isWriting = stage === 'writing' || stage === 'merged-writing';
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    session?.check();
    const record = { stage, attempt:attempt + 1, status:'pending', inputChars:JSON.stringify(messages).length };
    session?.requests.push(record);
    const started = Date.now();
    try {
      const ctx = getSTContext();
      if (!ctx?.generateRaw) throw new Error('当前酒馆没有 generateRaw 接口');
      let text;
      if (isWriting && typeof ctx.generateRawData === 'function') {
        const data = await ctx.generateRawData({ prompt:messages });
        session?.check();
        const reason = blockReasonOf(data);
        if (reason) throw new ProviderBlockedError(reason, stage);
        if (data?.error) throw new Error(data.error.message || 'API returned an error');
        const decoded = await decodeWritingResponse(data, Date.now() - started, ctx);
        text = decoded.text;
        session?.onWritingResponse?.(decoded);
        record.reasoningReturned = !!decoded.reasoning;
      } else {
        const result = await ctx.generateRaw({ prompt:messages });
        const reason = typeof result === 'object' ? blockReasonOf(result) : null;
        if (reason) throw new ProviderBlockedError(reason, stage);
        text = extractText(result);
        if (isWriting) {
          const decoded = await decodeWritingResponse(text, Date.now() - started, ctx);
          text = decoded.text; session?.onWritingResponse?.(decoded);
          record.rawResponseUnavailable = true;
        }
      }
      session?.check();
      if (!text?.trim()) throw new Error('API 返回空内容');
      record.status = 'complete'; record.outputChars = text.length;
      record.durationMs = Date.now() - started;
      return text;
    } catch (e) {
      const reason = blockReasonOf(e);
      lastErr = reason ? new ProviderBlockedError(reason, stage, e) : e;
      record.status = reason ? 'blocked' : 'failed';
      Object.assign(record, describeFailure(lastErr, stage));
      record.durationMs = Date.now() - started;
      session?.check();
      if (isAbortError(e)) throw new Error('Pipeline cancelled');
      // A provider block is terminal. Never change safety settings or reword and resend.
      if (reason || !isRetryable(e)) break;
    }
  }
  throw lastErr;
}
export function isAbortError(err) { return /abort|cancel|中断/i.test(err?.message || ''); }
export function isRetryable(err) {
  if (isProviderBlocked(err)) return false;
  return /\b429\b|\b5\d{2}\b|\bECONN\w*|fetch failed|NetworkError|network (?:error|failure)|timeout|timed out|rate[_ -]?limit(?:ed)?/i.test(err?.message || '');
}
