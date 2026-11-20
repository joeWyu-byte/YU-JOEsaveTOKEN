// Use the same request and cleanup as generateRaw, retaining actual writer metadata.
import { getSTContext } from './utils.js';

let nativePromise;
async function nativeHelpers() {
  if (!nativePromise) nativePromise = Promise.all([
    import(new URL('../../../../script.js', import.meta.url).href),
    import(new URL('../../../reasoning.js', import.meta.url).href),
    import(new URL('../../regex/engine.js', import.meta.url).href),
  ]).then(([script, reasoning, regex]) => ({ ...script, ...reasoning, ...regex }));
  return await nativePromise;
}

export async function getWriterResponse(messages, helpers = null) {
  const ctx = getSTContext();
  const started = Date.now();
  if (typeof ctx?.generateRawData !== 'function') {
    // Older ST: keep the supported raw path. Never reuse relay reasoning.
    return { text: await ctx.generateRaw({ prompt: messages }), reasoning: '', signature: null, usage: null, started, finished: Date.now() };
  }
  const native = helpers ?? await nativeHelpers();
  const data = await ctx.generateRawData({ prompt: messages });
  let text = native.cleanUpMessage({
    getMessage: native.extractMessageFromData(data),
    isImpersonate: false, isContinue: false, displayIncompleteSentences: true,
    includeUserPromptBias: false, trimNames: true, trimWrongNames: true,
  });
  let reasoning = native.extractReasoningFromData(data);
  if (ctx.powerUserSettings?.reasoning?.auto_parse) {
    const parsed = (ctx.parseReasoningFromString ?? native.parseReasoningFromString)(text);
    if (parsed?.reasoning) {
      text = parsed.content;
      reasoning = [reasoning, parsed.reasoning].filter(Boolean).join('\n\n');
    }
  }
  if (reasoning && native.getRegexedString && native.regex_placement) {
    reasoning = native.getRegexedString(reasoning, native.regex_placement.REASONING);
  }
  if (ctx.powerUserSettings?.trim_spaces) reasoning = reasoning.trim();
  return {
    text, reasoning: reasoning || '',
    signature: native.extractReasoningSignatureFromData?.(data) ?? null,
    usage: data?.usage ?? data?.usageMetadata ?? null,
    started, finished: Date.now(),
  };
}

export function replaceWriterMetadata(message, response, ctx = getSTContext()) {
  message.extra ??= {};
  for (const key of ['reasoning', 'reasoning_display_text', 'reasoning_duration', 'reasoning_signature', 'token_count', 'time_to_first_token']) delete message.extra[key];
  message.extra.reasoning = response.reasoning || '';
  if (response.signature) message.extra.reasoning_signature = response.signature;
  message.extra.save_writer_usage = response.usage ?? null;
  message.gen_started = new Date(response.started).toISOString();
  message.gen_finished = new Date(response.finished).toISOString();
  // The raw endpoint returns no separate reasoning clock. Do not invent one.
  if (ctx?.getTokenCount && typeof response.text === 'string') {
    // Native token count remains unknown until calculated for the actual body.
    message.extra.save_response_received = true;
  }
}
