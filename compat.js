// Explicit native-chat adapters. Agent prompt builders retain upstream system/user structure.
import { CharacterReader } from './readers.js';
import { extractPresetContext, extractTurns, getSTContext, bodyOf, contentKey } from './utils.js';
import { MESSAGE_KEY } from './constants.js';

export class ChatContentSource {
  constructor() { this.reader = new CharacterReader(); }
  async getConstantSystemEntries() { return [await this.reader.getChatInfo()]; }
  async getConstantBeforeCharEntries() { return []; }
  async getConstantAfterCharEntries() { return []; }
  async getSelectiveActivatedEntries() { return []; }
}

export function chatPresetContext() {
  const result = extractPresetContext();
  const ctx = getSTContext(), settings = ctx?.chatCompletionSettings || {};
  const order = settings.prompt_order?.[0]?.order || [];
  const enabled = id => order.find(p => p.identifier === id)?.enabled !== false;
  const fields = ctx?.getCharacterCardFields?.() || {};
  const main = settings.prompts?.find(p => p.identifier === 'main');
  const put=(value,role,previous='',replace=false)=>{
    const keys=['system','developer'].includes(role)?['planningContext','writingSystemContext']:['writingUserContext'];
    for(const key of keys)result[key]=replace&&previous&&result[key].includes(previous)?result[key].replace(previous,value):[value,result[key]].filter(Boolean).join('\n\n');
  };
  // Upstream excludes built-in main. Keeping the user's enabled main/card override is a separate required chat patch.
  const mainText = fields.system || main?.content || '';
  if (mainText.trim() && enabled('main')) {
    const filtered=main?.system_prompt || main?.marker || !main;
    if(filtered)put(mainText.trim(),main?.role || 'system');
    else if(fields.system?.trim() && fields.system.trim()!==main.content?.trim())put(fields.system.trim(),main.role || 'system',main.content?.trim(),true);
  }
  const post = settings.prompts?.find(p => p.identifier === 'jailbreak');
  if (post && enabled('jailbreak') && fields.jailbreak?.trim()) {
    put(fields.jailbreak.trim(),post.role || 'system',post.content?.trim(),true);
  }
  result.source = 'upstream-split-with-required-card-main';
  return result;
}

export function adaptHistory(chat) {
  const grouped = [];
  for (const m of chat || []) {
    if (m.is_system || m.extra?.[MESSAGE_KEY]?.failed) continue;
    if (m.is_user && grouped.at(-1)?.is_user) grouped.at(-1).mes += '\n\n' + (m.mes || '');
    else grouped.push(structuredClone(m));
  }
  const turns = extractTurns(grouped), byIndex = new Map(turns.map(t => [t.chatIndex,t]));
  const view = grouped.map((m,i) => {
    if (m.is_user) return m;
    const t = byIndex.get(i);
    if (!t) return {...m,mes:''};
    return {...m,mes:'<context>\n'+t.narrativeText+'\n</context>'+(t.summaryEntries.length?'\n\n<summary>\n'+t.summaryEntries.join('\n')+'\n</summary>':'')};
  });
  return {view, turns, summaries:turns.flatMap(t=>t.summaryEntries),
    validSummaryTurns:new Set(turns.filter(t=>t.summaryEntries.length).map(t=>t.turnNum)),
    skipOpeningAnalysis:turns[0]?.turnNum===0 && ['blocked','timed-out','failed'].includes(turns[0].analysisState)};
}

export function displayBody(raw) {
  const text = String(raw || '');
  const outer = text.match(/^\s*<context>\s*([\s\S]*?)\s*<\/context>(?:\s*<summary>[\s\S]*?<\/summary>)?\s*$/i);
  return outer ? outer[1] : text;
}
export function applyDisplay(message) {
  if (!message || message.is_user) return;
  const owned = message.extra?.[MESSAGE_KEY] || message.extra?.save_ui;
  const tagged = /^\s*<context>[\s\S]*<\/context>(?:\s*<summary>[\s\S]*<\/summary>)?\s*$/i.test(message.mes || '');
  if (!owned && !tagged) return;
  message.extra ??= {};
  if (message.extra.display_text && !message.extra.save_ui) {
    // A third-party display override is not ours to replace.
    if (!owned) return;
  }
  message.extra.display_text = displayBody(message.mes) || '\u200b';
  message.extra.save_ui = {version:'0.3.0',source:contentKey(message.mes || '')};
}
export function refreshDisplays() {
  const ctx = getSTContext();
  for (let i=0;i<(ctx?.chat?.length || 0);i++) {
    const m=ctx.chat[i];
    if(typeof document!=='undefined' && document.querySelector(`#chat .mes[mesid="${i}"] #curEditTextarea`))continue;
    applyDisplay(m);
    if (!m.is_user && m.extra?.save_ui) {
      ctx.updateMessageBlock?.(i,m);
      if (typeof document!=='undefined') document.querySelector(`#chat .mes[mesid="${i}"]`)?.classList.toggle('save-na-empty',!m.mes);
    }
  }
}

export function installNativeEditorAdapter() {
  if(typeof MutationObserver==='undefined' || typeof document==='undefined')return ()=>{};
  const host=document.getElementById('chat');if(!host)return ()=>{};
  let queued=false;
  const observer=new MutationObserver(records=>{
    let closed=false;
    for(const record of records){
      for(const node of record.addedNodes){
        const editor=node.nodeType===1?(node.id==='curEditTextarea'?node:node.querySelector?.('#curEditTextarea')):null;
        if(!editor)continue;
        const messageElement=editor.closest('.mes'),id=Number(messageElement?.getAttribute('mesid'));
        const message=getSTContext()?.chat?.[id];
        if(message && !message.is_user && (message.extra?.save_ui || message.extra?.[MESSAGE_KEY]))editor.value=displayBody(editor.value);
      }
      for(const node of record.removedNodes)if(node.nodeType===1 && (node.id==='curEditTextarea'||node.querySelector?.('#curEditTextarea')))closed=true;
    }
    if(closed&&!queued){queued=true;queueMicrotask(()=>{queued=false;refreshDisplays();});}
  });
  observer.observe(host,{childList:true,subtree:true});return ()=>observer.disconnect();
}
