import { PipelineCancelledError, StageTimeoutError } from './errors.js';

// Settle the caller even if a transport ignores AbortSignal. Late results stay observed,
// but may never mutate a cancelled run. The native raw transport is also aborted on timeout.
export function bounded(task, { stage = 'operation', timeoutMs = 180000, signal, onTimeout } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const deadline = Date.now() + timeoutMs;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, signal.reason instanceof Error ? signal.reason : new PipelineCancelledError());
    const expire = () => {
      if (settled) return;
      const error = new StageTimeoutError(stage, timeoutMs);
      finish(reject, error);
      try { onTimeout?.(error); } catch { /* Preserve the timeout result. */ }
    };
    const timer = setTimeout(expire, timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once:true });
    let promise;
    try { promise = task(); } catch (error) { finish(reject, error); return; }
    Promise.resolve(promise).then(value => {
      if (settled) return;
      if (Date.now() >= deadline) expire(); else finish(resolve, value);
    }, error => finish(reject, error));
  });
}

export function deadlineFor(config, stage) {
  const limits = config?.timeouts || {};
  const fallback = stage === 'relay' ? 60000 : /analysis|planning/.test(stage) ? 90000 : /save/.test(stage) ? 10000 : 180000;
  const value = limits[stage === 'relay' ? 'relayMs' : /analysis|planning/.test(stage) ? 'analysisMs' : /save/.test(stage) ? 'saveMs' : 'requestMs'];
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
