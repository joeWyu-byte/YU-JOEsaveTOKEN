// Classify provider feedback without weakening or bypassing provider safety decisions.
export class ProviderBlockedError extends Error {
  constructor(reason, stage = '', cause = null) {
    super('API blocked the ' + (stage || 'generation') + ' request: ' + reason);
    this.name = 'ProviderBlockedError';
    this.blockReason = reason;
    this.stage = stage;
    this.cause = cause;
  }
}
export function blockReasonOf(value) {
  if (value?.blockReason) return String(value.blockReason);
  const feedback = value?.promptFeedback || value?.prompt_feedback || value?.error?.promptFeedback;
  if (feedback?.blockReason || feedback?.block_reason) return feedback.blockReason || feedback.block_reason;
  const rejected = value?.candidates?.find(c => ['PROHIBITED_CONTENT','SAFETY','BLOCKLIST','SPII','IMAGE_SAFETY'].includes(c.finishReason));
  if (rejected) return rejected.finishReason;
  const message = typeof value === 'string' ? value : value?.message || value?.error?.message || '';
  if (/\bPROHIBITED_CONTENT\b/i.test(message)) return 'PROHIBITED_CONTENT';
  const match = message.match(/(?:blockReason|blocked(?:\s+due\s+to)?|finishReason)\s*[:=]?\s*["']?(SAFETY|BLOCKLIST|IMAGE_SAFETY|OTHER|SPII)\b/i);
  return match ? match[1].toUpperCase() : null;
}
export function isProviderBlocked(error) { return !!blockReasonOf(error); }
export function describeFailure(error, stage) {
  const reason = blockReasonOf(error);
  return reason ? { code:'provider-blocked', blockReason:reason, stage } : { code:'request-failed', stage };
}
