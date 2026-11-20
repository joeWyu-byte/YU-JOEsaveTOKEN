// Request lifetime and response ownership. No prompts or model settings here.
let active = null;

export function getGenerationSession() { return active; }

export function startGenerationSession(run) {
  if (active) throw new Error('A Save generation is already running');
  run.controller = new AbortController();
  run.requests = [];
  run.writer = null;
  run.assertActive = () => {
    if (run.controller.signal.aborted || !run.isCurrent()) throw new Error('Pipeline cancelled');
  };
  run.cancel = (reason = '已停止') => {
    if (run.controller.signal.aborted) return;
    run.cancelReason = reason;
    run.controller.abort();
    run.orchestrator._shouldCancel = true;
    // Native raw requests listen to GENERATION_STOPPED as well.
    try { run.context.stopGeneration?.(); } catch { /* already stopped */ }
  };
  active = run;
  return run;
}

export function endGenerationSession(run) {
  if (active === run) active = null;
}

export async function awaitRequest(operation, label) {
  const run = active;
  if (!run) return await operation();
  run.assertActive();
  const entry = { label, started: Date.now(), status: 'pending' };
  run.requests.push(entry);
  run.onStatus?.(label === 'writing' || label === 'merged-writing' ? '正在生成回复' : '正在整理记忆');
  let timer;
  let abortHandler;
  const aborted = new Promise((_, reject) => {
    abortHandler = () => reject(new Error('Pipeline cancelled'));
    run.controller.signal.addEventListener('abort', abortHandler, { once: true });
    timer = setTimeout(() => run.cancel('请求等待超过 5 分钟，已停止'), run.requestTimeout ?? 300000);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(operation), aborted]);
    run.assertActive();
    entry.status = 'complete';
    return result;
  } catch (error) {
    entry.status = run.controller.signal.aborted ? 'stopped' : 'error';
    entry.error = error?.message || String(error);
    throw error;
  } finally {
    clearTimeout(timer);
    run.controller.signal.removeEventListener('abort', abortHandler);
    entry.elapsedMs = Date.now() - entry.started;
  }
}

export function publishWriter(response) {
  const run = active;
  if (!run) return;
  run.assertActive();
  run.writer = response;
  const request = run.requests.at(-1);
  if (request) request.usage = response.usage ?? null;
  const accepted = run.onWriter?.(response);
  return typeof accepted === 'string' ? accepted : response.text;
}
