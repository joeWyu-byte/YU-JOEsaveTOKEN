// Preserve only the reasoning the provider actually returns, following native ST settings.
import { getSTContext } from './utils.js';
let helpersPromise;
let scriptPromise;
async function nativeScript(ctx) {
  if(typeof ctx.cleanUpMessage==='function')return ctx;
  if(typeof document==='undefined')return null;
  scriptPromise ??= import(new URL('../../../../script.js',import.meta.url).href).catch(()=>null);
  return await scriptPromise;
}
export async function canReadNativeData(ctx=getSTContext()) {
  return typeof (await nativeScript(ctx))?.cleanUpMessage==='function';
}
async function nativeHelpers(ctx) {
  if (typeof ctx.extractReasoningFromData === 'function') return ctx;
  helpersPromise ??= import(new URL('../../../reasoning.js', import.meta.url).href).catch(() => null);
  return await helpersPromise;
}
export function extractText(data) {
  if (typeof data === 'string') return data;
  const value = data?.choices?.[0]?.message?.content ?? data?.message?.content ?? data?.text ?? data?.output;
  if (Array.isArray(value)) return value.filter(p => p.type === 'text' || !p.type).map(p => p.text || '').join('\n\n');
  if (typeof value === 'string') return value;
  if (Array.isArray(data?.content)) return data.content.filter(p => p.type === 'text').map(p => p.text || '').join('\n\n');
  if (Array.isArray(data?.responseContent?.parts)) return data.responseContent.parts.filter(p => !p.thought).map(p => p.text || '').join('\n\n');
  return '';
}
function fallbackReasoning(data, settings) {
  if (!settings?.show_thoughts) return '';
  if (Array.isArray(data?.responseContent?.parts)) return data.responseContent.parts.filter(p => p.thought).map(p => p.text || '').join('\n\n');
  if (Array.isArray(data?.content)) return data.content.filter(p => p.type === 'thinking').map(p => p.thinking || '').join('\n\n');
  return data?.choices?.[0]?.message?.reasoning_content ?? data?.choices?.[0]?.message?.reasoning ?? '';
}
export async function decodeWritingResponse(data, durationMs, ctx = getSTContext()) {
  const helpers = await nativeHelpers(ctx);
  const source = ctx.chatCompletionSettings?.chat_completion_source;
  const options = { mainApi:ctx.mainApi, chatCompletionSource:source };
  let text = typeof ctx.extractMessageFromData === 'function' ? ctx.extractMessageFromData(data, ctx.mainApi) : extractText(data);
  if(typeof data!=='string') {
    const native=await nativeScript(ctx);
    if(typeof native?.cleanUpMessage==='function')text=native.cleanUpMessage({getMessage:text,isImpersonate:false,isContinue:false,
      displayIncompleteSentences:true,includeUserPromptBias:false,trimNames:true,trimWrongNames:true});
  }
  let reasoning = typeof helpers?.extractReasoningFromData === 'function'
    ? helpers.extractReasoningFromData(data, options) : fallbackReasoning(data, ctx.chatCompletionSettings);
  let signature = helpers?.extractReasoningSignatureFromData?.(data, options) ?? null;
  // ST 1.18's Gemini helper may return null despite a signature in a text part.
  if (!signature && ['makersuite','vertexai'].includes(source)) {
    signature = data?.responseContent?.parts?.find(p => typeof p.text === 'string' && p.thoughtSignature)?.thoughtSignature ?? null;
  }
  let type = 'model';
  if (ctx.powerUserSettings?.reasoning?.auto_parse && typeof ctx.parseReasoningFromString === 'function') {
    const parsed = ctx.parseReasoningFromString(text);
    if (parsed?.reasoning) {
      text = parsed.content;
      if (!reasoning) { reasoning = parsed.reasoning; type = 'parsed'; }
    }
  }
  return {
    text:String(text || ''),
    reasoning:typeof reasoning === 'string' ? reasoning : '',
    reasoningType:type,
    reasoningSignature:signature,
    durationMs,
  };
}
