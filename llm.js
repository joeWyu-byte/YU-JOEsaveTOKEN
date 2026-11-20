// Narrative Agent raw-generation route; preserve response metadata and classify failures.
import { getSTContext } from './utils.js';
import { decodeWritingResponse, extractText, canReadNativeData } from './response.js';
import { ProviderBlockedError, blockReasonOf, isProviderBlocked, describeFailure } from './errors.js';
import { bounded, deadlineFor } from './lifecycle.js';
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
    const record = { stage, attempt:attempt + 1, status:'pending', startedAt:Date.now(), inputChars:JSON.stringify(messages).length,
      messageRoles:messages.map(m => m.role) };
    session?.requests.push(record);
    if (session) { session.activeRequest = record; session.onUpdate?.(stage); }
    const started = Date.now();
    let accepting = true;
    try {
      const ctx = getSTContext();
      if (!ctx?.generateRaw) throw new Error('当前酒馆没有 generateRaw 接口');
      if(messages.length!==2 || messages[0].role!=='system' || messages[1].role!=='user')throw new Error('Save 请求结构校验失败，未发送请求');
      const execute = async () => {
      let text;
      if(isWriting && session) {
        if((session.writerAttempts || 0)>=3)throw Object.assign(new Error('本轮正文请求达到恢复上限'),{code:'request-budget'});
        session.writerAttempts=(session.writerAttempts || 0)+1;
      }
      if (isWriting && typeof ctx.generateRawData === 'function' && await canReadNativeData(ctx)) {
        const data = await ctx.generateRawData({ prompt:messages });
        if (!accepting) throw new Error('Pipeline cancelled');
        session?.check();
        const reason = blockReasonOf(data);
        if (reason) throw new ProviderBlockedError(reason, stage);
        if (data?.error) throw new Error(data.error.message || 'API returned an error');
        const decoded = await decodeWritingResponse(data, Date.now() - started, ctx);
        if (!accepting) throw new Error('Pipeline cancelled');
        session?.check();
        text = decoded.text;
        session?.onWritingResponse?.(decoded);
        record.reasoningReturned = !!decoded.reasoning;
      } else {
        const result = await ctx.generateRaw({ prompt:messages });
        if (!accepting) throw new Error('Pipeline cancelled');
        const reason = typeof result === 'object' ? blockReasonOf(result) : null;
        if (reason) throw new ProviderBlockedError(reason, stage);
        text = extractText(result);
        if (isWriting) {
          const decoded = await decodeWritingResponse(text, Date.now() - started, ctx);
          if (!accepting) throw new Error('Pipeline cancelled');
          session?.check();
          text = decoded.text; session?.onWritingResponse?.(decoded);
          record.rawResponseUnavailable = true;
        }
      }
      session?.check();
      if (!text?.trim()) throw new Error('API 返回空内容');
      return text;
      };
      const text = await bounded(execute, { stage, timeoutMs:deadlineFor(session?.config, stage), signal:session?.controller?.signal,
        onTimeout:() => { accepting = false; session?.abortNative?.(); } });
      record.status = 'complete'; record.outputChars = text.length;
      record.durationMs = Date.now() - started;
      return text;
    } catch (e) {
      const reason = blockReasonOf(e);
      lastErr = reason ? new ProviderBlockedError(reason, stage, e) : e;
      record.status = reason ? 'blocked' : e?.code === 'stage-timeout' ? 'timed-out' : e?.code === 'cancelled' ? 'cancelled' : 'failed';
      Object.assign(record, describeFailure(lastErr, stage));
      record.durationMs = Date.now() - started;
      session?.check();
      if (isAbortError(e)) throw new Error('Pipeline cancelled');
      // A provider block is terminal. Never change safety settings or reword and resend.
      if (reason || e?.code === 'stage-timeout' || !isRetryable(e) || (isWriting && session?.writerAttempts>=3)) break;
      await bounded(() => new Promise(resolve => setTimeout(resolve, 350)), { stage:'retry-delay', timeoutMs:1000, signal:session?.controller?.signal });
    } finally {
      accepting = false;
      if (session?.activeRequest === record) session.activeRequest = null;
      session?.onUpdate?.(stage);
    }
  }
  throw lastErr;
}
export function isAbortError(err) { return /abort|cancel|中断/i.test(err?.message || ''); }
export function isRetryable(err) {
  if (isProviderBlocked(err)) return false;
  return /\b429\b|\b5\d{2}\b|\bECONN\w*|fetch failed|NetworkError|network (?:error|failure)|timeout|timed out|rate[_ -]?limit(?:ed)?/i.test(err?.message || '');
}
