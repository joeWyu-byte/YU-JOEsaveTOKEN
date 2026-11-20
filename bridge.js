// Narrative Agent's native relay -> raw generation -> per-turn analysis bridge.
// Each run owns its cancellation, live records and guarded message writes.
import { PLACEHOLDER, MESSAGE_KEY } from './constants.js';
import { getSTContext, getConversationId, getLatestUserInput, extractPresetContext, extractTurns, contentKey, updateSwipe, bodyOf } from './utils.js';
import { setCallSession } from './llm.js';
import { blockReasonOf, PipelineCancelledError, StageTimeoutError } from './errors.js';
import { bounded, deadlineFor } from './lifecycle.js';
import { ChatPersistence } from './persistence.js';
import { adaptHistory, chatPresetContext, applyDisplay, displayBody, refreshDisplays, installNativeEditorAdapter } from './compat.js';

const supported = new Set(['normal','regenerate','swipe','continue']);
const clone = value => JSON.parse(JSON.stringify(value));
export class SillyTavernBridge {
  constructor(orchestrator, report = () => {}) {
    this.orchestrator = orchestrator; this.report = report; this.enabled = true;
    this.isPipelineRunning = false; this._pending = null; this.lastRun = null;
    this.handlers = []; this.persistence = new ChatPersistence(); this._runCounter = 0;
    this._known = null;
  }
  _report(text) { this.status = text; try { this.report(text); } catch (error) { console.warn('[Save] 状态显示失败', error); } }
  install() {
    const ctx = getSTContext();
    const bind = (name, fn, optional = false) => {
      if (!ctx.eventTypes[name]) { if (optional) return; throw new Error(`酒馆缺少 ${name} 事件`); }
      const bound = fn.bind(this); ctx.eventSource.on(ctx.eventTypes[name], bound);
      this.handlers.push([ctx.eventTypes[name],bound]);
    };
    bind('GENERATION_STARTED', this._onGenerationStarted);
    bind('CHAT_COMPLETION_PROMPT_READY', this._onPromptReady);
    bind('GENERATION_ENDED', this._onGenerationEnded);
    bind('GENERATION_STOPPED', this._onStopped);
    bind('CHAT_CHANGED', this._onChatChanged);
    bind('CHAT_COMPLETION_SETTINGS_READY', this._onSettingsReady, true);
    for (const event of ['MESSAGE_EDITED','MESSAGE_UPDATED','CHARACTER_MESSAGE_RENDERED','MESSAGE_SWIPED']) bind(event,this._onMessageUpdated,true);
    this._onMessageUpdated();
    this._removeEditorAdapter=installNativeEditorAdapter();
  }
  uninstall() {
    this._removeEditorAdapter?.();
    this.cancel('uninstall'); const ctx = getSTContext();
    for (const [name,fn] of this.handlers) ctx.eventSource.removeListener(name,fn);
    this.handlers = [];
  }
  _onStopped(data) {
    if (data?.saveInternalRun) return;
    this.cancel('stop');
  }
  _onChatChanged() { this.cancel('chat-changed'); this._known=null; this._onMessageUpdated(); }
  _onMessageUpdated() {
    if(this.isPipelineRunning || this._pending?.intercepted)return;
    const ctx=getSTContext();if(!ctx?.chat)return;
    refreshDisplays();this._known={conversation:getConversationId(),chat:ctx.chat,before:clone(ctx.chat)};
  }
  _abortRaw(session) {
    const ctx = getSTContext();
    try {
      const pending = ctx?.eventSource?.emit(ctx.eventTypes.GENERATION_STOPPED, { saveInternalRun:session.id });
      pending?.catch?.(error => console.warn('[Save] 中止通知失败', error));
    } catch { /* The caller is already bounded and cannot accept late output. */ }
  }
  cancel(reason = 'cancel') {
    const p = this._pending;
    if (p) {
      p.cancelled = true; clearTimeout(p.timer);
      if (p.intercepted) {
        p.run.status = 'stopped'; p.run.stage = 'relay'; p.requests[0].status = 'cancelled';
        this._pending = null;
        try { getSTContext()?.stopGeneration?.(); } catch { /* Native UI may already be stopped. */ }
        this._restorePendingRelay(p);
      }
    }
    const session = this.session;
    if (session && !session.controller.signal.aborted) {
      session.cancelled = true; session.controller.abort(new PipelineCancelledError());
      this._abortRaw(session);
    }
    this.orchestrator._shouldCancel = true;
  }
  _onGenerationStarted(type = 'normal', params, dryRun) {
    if (dryRun || this.isPipelineRunning) return;
    if (this._pending?.timer) clearTimeout(this._pending.timer);
    this._pending = null;
    if (!this.enabled || !supported.has(type)) return;
    const ctx = getSTContext();
    if (ctx.groupId != null) { this._report('此版处理一对一聊天；群聊使用原生生成。'); return; }
    if (ctx.mainApi && ctx.mainApi !== 'openai') { this._report('请使用酒馆的 Chat Completion 连接方式。'); return; }
    if (ctx.extensionSettings?.['narrative-agent']?.enabled) { this._report('请关闭原 Narrative Agent，再启用 Save，避免重复接管。'); return; }
    if (typeof ctx.generateRaw !== 'function') { this._report('酒馆缺少 generateRaw 接口。'); return; }
    const run = { id:`save-${Date.now()}-${++this._runCounter}`, status:'preparing', stage:'native-prompt',
      startedAt:Date.now(), type, requests:[], saves:[], warnings:[] };
    this.lastRun = run;
    let before=clone(ctx.chat);
    if(type==='regenerate' && before.at(-1)?.is_user && this._known?.conversation===getConversationId() && this._known.chat===ctx.chat) {
      const prior=this._known.before;
      if(prior.length===before.length+1 && !prior.at(-1).is_user && JSON.stringify(prior.slice(0,-1).map(m=>[m.is_user,m.mes]))===JSON.stringify(before.map(m=>[m.is_user,m.mes]))) before=clone(prior);
    }
    this._pending = { type, run, conversation:getConversationId(), chat:ctx.chat, before,
      intercepted:false, cancelled:false, requests:run.requests };
    this._report('已收到生成事件，等待接管请求……');
  }
  _onPromptReady(data) {
    const p = this._pending;
    if (!this.enabled || this.isPipelineRunning || data.dryRun || !p || p.intercepted || p.cancelled || p.conversation !== getConversationId()) return;
    if (!Array.isArray(data.chat) || !data.chat.length) return;
    const ctx = getSTContext(), history = ctx.chat.slice();
    if (['swipe','continue'].includes(p.type) && history.at(-1) && !history.at(-1).is_user) history.pop();
    if (history.some(m => m.extra?.media?.length || m.extra?.image || m.extra?.file || m.extra?.tool_invocations?.length)) {
      p.run.status = 'native-fallback'; this._pending = null;
      this._report('这段聊天含图片、附件或工具结果，暂时交回原生生成。'); return;
    }
    p.history = clone(history); p.continuation = p.type === 'continue' ? displayBody(p.before.at(-1)?.mes || '') : '';
    p.adapted=adaptHistory(p.history);
    p.userInput = getLatestUserInput(p.adapted.view); p.preset = chatPresetContext();
    p.run.context = { mode:p.preset.source, presetRoles:['system','user'], historyAdapter:'original-tags-compatible' };
    p.run.nativePrompt = { chars:JSON.stringify(data.chat).length, roles:data.chat.map(m => m.role), fingerprint:contentKey(JSON.stringify(data.chat)) };
    p.source = contentKey(JSON.stringify(history.map(m => [m.is_user,m.mes]))); p.prefixLength = history.length;
    data.chat.splice(0,data.chat.length);
    data.chat.push({ role:'system', content:'You are a relay. You must output exactly the following text and nothing else: ' + PLACEHOLDER });
    data.chat.push({ role:'user', content:'Relay the designated text now.' });
    p.intercepted = true; p.run.status = 'running'; p.run.stage = 'relay';
    p.requests.push({ stage:'relay', status:'pending', startedAt:Date.now(), inputChars:JSON.stringify(data.chat).length });
    const timeoutMs = deadlineFor(this.orchestrator.config,'relay');
    p.timer = setTimeout(() => this._onRelayTimeout(p,timeoutMs), timeoutMs);
    this._report('已接管：正在发送原版 Relay 请求……');
  }
  _onSettingsReady(data) {
    const record = this.session?.activeRequest || (this._pending?.intercepted ? this._pending.requests[0] : null);
    if (!record || !data) return;
    // Record effective parameters, never secrets or private prompt text.
    Object.assign(record, { model:data.model, source:data.chat_completion_source, stream:!!data.stream,
      maxOutputTokens:data.max_tokens, includeReasoning:!!data.include_reasoning });
  }
  _onRelayTimeout(p,timeoutMs) {
    if (this._pending !== p || !p.intercepted) return;
    this._pending = null; p.cancelled = true;
    Object.assign(p.requests[0],{status:'timed-out',code:'stage-timeout',durationMs:Date.now()-p.requests[0].startedAt});
    Object.assign(p.run,{status:'timed-out',stage:'relay',finishedAt:Date.now()});
    try { getSTContext()?.stopGeneration?.(); } catch { /* Timer cleanup must not depend on native UI. */ }
    this._restorePendingRelay(p);
    this._report('Relay 请求超时，已停止本轮；没有启动后台回复或摘要。');
  }
  _restorePendingRelay(p) {
    const ctx=getSTContext();
    if(getConversationId()!==p.conversation || ctx?.chat!==p.chat)return;
    const index=ctx.chat.length-1,target=ctx.chat[index];
    if(!target || target.is_user || !target.mes?.includes(PLACEHOLDER))return;
    const previous=p.before.at(-1);
    if(['swipe','continue','regenerate'].includes(p.type)&&previous&&!previous.is_user)Object.assign(target,clone(previous));
    else {target.mes='';target.extra??={};target.extra[MESSAGE_KEY]={failed:true};applyDisplay(target);}
    try {updateSwipe(target);ctx.updateMessageBlock?.(index,target);}catch{/* Preserve the stopped run. */}
    this._saveAfterRelease(p,ctx);
  }
  _sameChat(p,ctx,target,index) {
    return p.conversation === getConversationId() && getSTContext()?.chat === p.chat && ctx.chat[index] === target;
  }
  _save(p,ctx,session,stage,signal) {
    return this.persistence.save(ctx,p.conversation,{stage,signal,timeoutMs:deadlineFor(this.orchestrator.config,'chat-save'),records:p.run.saves,
      onUpdate:() => {
        p.run.unsaved = !!this.persistence.get(p.conversation);
        if (this.lastRun === p.run && p.conversation === getConversationId()) this._report(this.status || '正在保存聊天……');
      } });
  }
  _saveAfterRelease(p,ctx) {
    if (getConversationId() !== p.conversation || getSTContext()?.chat !== p.chat) return;
    this.saveCompletion = this._save(p,ctx,null,'final-save').then(record => {
      if (!['saved','saved-late'].includes(record.status)) p.run.warnings.push('聊天尚未确认保存，可导出未保存备份；生成操作已恢复。');
      if (this.lastRun === p.run && p.conversation === getConversationId()) {
        this._report(p.run.unsaved ? '本轮已结束；聊天尚未确认保存，请导出未保存备份。' : this.status);
      }
    }).catch(error => {
      p.run.unsaved = true; p.run.warnings.push('聊天保存失败，请导出未保存备份。');
      if (this.lastRun === p.run) this._report('本轮已结束；聊天保存失败，请导出未保存备份。');
      console.warn('[Save] 保存失败',error);
    });
  }
  async _onGenerationEnded() {
    const p = this._pending;
    if (!p?.intercepted || this.isPipelineRunning) return;
    this._pending = null; clearTimeout(p.timer);
    const ctx = getSTContext();
    if (p.conversation !== getConversationId() || ctx.chat !== p.chat) { p.run.status='stopped'; return; }
    const index = ctx.chat.length-1, target = ctx.chat[index];
    const relay = p.requests[0]; relay.durationMs = Date.now()-relay.startedAt;
    if (!target || target.is_user || !target.mes?.includes(PLACEHOLDER) || p.cancelled || !this.enabled) {
      relay.status = p.cancelled ? 'cancelled' : 'failed';
      p.run.status = p.cancelled ? 'stopped' : 'relay-failed'; p.run.stage='relay'; p.run.finishedAt=Date.now();
      if (target && !target.is_user && (target.mes?.includes(PLACEHOLDER) || ctx.chat.length > p.history.length)) {
        const previous = p.before.at(-1);
        if (['swipe','continue','regenerate'].includes(p.type) && previous && !previous.is_user) Object.assign(target,clone(previous));
        else { target.mes=''; target.extra ??= {}; target.extra[MESSAGE_KEY]={failed:true};applyDisplay(target); }
        try { updateSwipe(target); ctx.updateMessageBlock?.(index,target); } catch { /* Record remains available. */ }
      }
      this._report('Relay 没有完成，后台回复和摘要未执行。'); this._saveAfterRelease(p,ctx); return;
    }
    relay.status='complete'; relay.outputChars=PLACEHOLDER.length;
    this.isPipelineRunning = true;
    let draft='', unlock=()=>{}, lastBody=target.mes;
    const session = { id:p.run.id, config:this.orchestrator.config, requests:p.requests,
      cancelled:false, controller:new AbortController(), activeRequest:null,
      check:() => {
        const now=getSTContext();
        const samePrefix=contentKey(JSON.stringify(now?.chat?.slice(0,p.prefixLength).map(m=>[m.is_user,m.mes])))===p.source;
        if (session.cancelled || session.controller.signal.aborted || this.session!==session || !this.enabled || !samePrefix || target.mes!==lastBody || !this._sameChat(p,ctx,target,index)) throw new PipelineCancelledError();
      },
      abortNative:()=>this._abortRaw(session),
      onUpdate:stage=> { p.run.stage=stage; if(this.lastRun===p.run) this._report(this.status || stage); },
    };
    this.session=session; this.orchestrator.session=session; setCallSession(session);
    const render=()=> {ctx.updateMessageBlock?.(index,target);if(typeof document!=='undefined')document.querySelector(`#chat .mes[mesid="${index}"]`)?.classList.toggle('save-na-empty',!target.mes);};
    const setBody=text=> { session.check(); target.mes=text; lastBody=text; target.extra ??= {};target.extra.save_ui={version:'0.3.0'};applyDisplay(target); delete target.extra.token_count; updateSwipe(target); render(); };
    try {
      unlock=this._lockUI();
      target.extra ??= {};
      const prior=p.type==='continue' ? p.before.at(-1)?.extra || {} : {};
      Object.assign(target.extra,{reasoning:prior.reasoning || '',reasoning_duration:prior.reasoning_duration || 0,
        reasoning_type:prior.reasoning_type || 'model',reasoning_signature:null});
      session.onWritingResponse=response=> {
        session.check();
        Object.assign(target.extra,{reasoning:[prior.reasoning,response.reasoning].filter(Boolean).join('\n\n'),
          reasoning_duration:(prior.reasoning_duration||0)+(response.reasoning ? response.durationMs : 0),
          reasoning_type:response.reasoning ? response.reasoningType : prior.reasoning_type || 'model',reasoning_signature:response.reasoningSignature});
      };
      const {turns}=this.orchestrator._extractTurnHistoryFromChat(p.adapted.view);
      this.orchestrator.summaryStore.reset();this.orchestrator.summaryStore.appendEntries(p.adapted.summaries);
      this.orchestrator.validSummaryTurns=p.adapted.validSummaryTurns;
      this.orchestrator.skipOpeningAnalysis=p.adapted.skipOpeningAnalysis;
      this.orchestrator.continuation=p.continuation;
      this.orchestrator.openingAnalysisState=undefined;
      this.orchestrator.applyChatExtractedContext(turns); this.orchestrator.setPresetContext(p.preset);
      this.orchestrator.onProgress(text=> {session.check();this._report(text);});
      this.orchestrator.onDraft=async text=> {
        const n=this.orchestrator.turnCounter+1,previous=p.adapted.turns.at(-1)?.sourceKey || '';
        const metadata={turnNum:n,sourceKey:contentKey(previous+JSON.stringify([n,p.userInput,text]))};
        draft='<context>\n'+text+'\n</context>'; p.draftMeta=metadata;
        target.extra[MESSAGE_KEY]={schema:2,...metadata,summaryEntries:[],analysisState:'pending'};
        setBody(draft);
        const saved=await this._save(p,ctx,session,'reply-save',session.controller.signal);
        if (!['saved','saved-late'].includes(saved.status)) this.orchestrator.warnings.push('回复尚未确认保存，已保留未保存备份。');
        session.check();
      };
      setBody(p.continuation || '');
      const engineInput=p.continuation ? p.userInput+'\n\n<continue_from>\n'+p.continuation+'\n</continue_from>\n请从已有回复结尾继续，只输出新增部分。' : p.userInput;
      const result=await this.orchestrator.pipeline(engineInput,false,p.adapted.view);
      session.check(); setBody(result.finalOutput);
      target.extra[MESSAGE_KEY]={schema:2,turnNum:result.turnNum,sourceKey:p.draftMeta?.sourceKey,summaryEntries:result.summaryEntries,analysisState:result.analysisState,blockReason:result.blockReason};
      const opening=p.adapted.turns.find(t=>t.turnNum===0);
      if(opening && !opening.summaryEntries.length) {
        const entries=this.orchestrator.summaryStore.toDict().entries.filter(s=>/^\[第0轮\]/.test(s));
        const originalOpening=ctx.chat.find(m=>!m.is_user && bodyOf(m)===opening.narrativeText);
        if(originalOpening) {originalOpening.extra??={};originalOpening.extra[MESSAGE_KEY]={schema:2,turnNum:0,sourceKey:opening.sourceKey,summaryEntries:entries,analysisState:this.orchestrator.openingAnalysisState || 'complete'};}
      }
      target.gen_finished=new Date().toISOString(); updateSwipe(target);
      if(p.requests.some(r=>r.rawResponseUnavailable)) result.warnings.push('当前酒馆缺少完整响应接口，无法读取单独返回的思考字段。');
      Object.assign(p.run,{status:'complete',stage:'complete',mode:this.orchestrator.config.pipeline.enableTextRecall?'split':'merged',
        recentTurns:turns.length,summaries:this.orchestrator.summaryStore.getEntryCount(),warnings:result.warnings});
      this._report(`完成：本轮 ${p.requests.length} 次模型请求，已整理 ${p.run.summaries} 条摘要。${result.warnings.join('；')}`);
    } catch(error) {
      const reason=blockReasonOf(error);
      Object.assign(p.run,{status:error.code==='stage-timeout'?'timed-out':error.code==='cancelled'||session.cancelled?'stopped':reason?'blocked':'failed',
        blockReason:reason,stage:error.stage || session.activeRequest?.stage || p.run.stage,code:error.code});
      if(target.mes===lastBody && this._sameChat(p,ctx,target,index)) {
        if(draft) {target.mes=draft;target.extra ??= {};target.extra[MESSAGE_KEY]={schema:2,...p.draftMeta,summaryEntries:[],analysisState:'pending'};}
        else if(['swipe','continue','regenerate'].includes(p.type) && p.before.at(-1) && !p.before.at(-1).is_user) Object.assign(target,clone(p.before.at(-1)));
        else {target.mes='';target.extra ??= {};target.extra[MESSAGE_KEY]={failed:true};}
        applyDisplay(target);
        try {updateSwipe(target);render();} catch(renderError) {p.run.warnings.push('消息显示未完成，生成操作已恢复。');console.warn('[Save] 显示失败',renderError);}
      }
      const stageName={relay:'Relay',planning:'规划',writing:'正文','merged-writing':'正文','merged-analysis':'摘要'}[p.run.stage] || p.run.stage;
      this._report(reason?`${stageName}请求被接口拦截（${reason}），本轮已结束，操作已恢复。`:`${stageName}步骤未完成：${error.message}。${draft?'已生成正文和思考保留。':''}`);
    } finally {
      p.run.finishedAt=Date.now();p.run.durationMs=p.run.finishedAt-p.run.startedAt;
      setCallSession(null);this.session=null;this.orchestrator.session=null;this.orchestrator.onDraft=null;
      this.isPipelineRunning=false;
      try {unlock();} catch(error) {console.warn('[Save] 界面收尾失败',error);}
      if(this._sameChat(p,ctx,target,index)) {
        const opening=p.adapted.turns.find(t=>t.turnNum===0);
        if(opening && !opening.summaryEntries.length) {
          const entries=this.orchestrator.summaryStore.toDict().entries.filter(s=>/^\[第0轮\]/.test(s));
          const m=ctx.chat.find(m=>!m.is_user && bodyOf(m)===opening.narrativeText);
          if(m && (entries.length || this.orchestrator.openingAnalysisState)) {
            m.extra??={};m.extra[MESSAGE_KEY]={schema:2,turnNum:0,sourceKey:opening.sourceKey,summaryEntries:entries,analysisState:this.orchestrator.openingAnalysisState || 'complete'};
          }
        }
      }
      this._saveAfterRelease(p,ctx);
      if(this._sameChat(p,ctx,target,index))this._known={conversation:p.conversation,chat:ctx.chat,before:clone(ctx.chat)};
      // Extension listeners cannot retain the generation lock either.
      if((draft || p.run.status==='complete') && this._sameChat(p,ctx,target,index)) {
        for(const event of ['MESSAGE_EDITED','MESSAGE_UPDATED','CHARACTER_MESSAGE_RENDERED']) if(ctx.eventTypes[event]) {
          bounded(()=>ctx.eventSource.emit(ctx.eventTypes[event],index),{stage:'notify',timeoutMs:3000}).catch(()=>{});
        }
      }
    }
  }
  _lockUI() {
    if(typeof document==='undefined')return()=>{};
    const nodes=[...document.querySelectorAll('#send_but, #option_regenerate, #option_continue, #mes_continue, #mes_impersonate')];
    const saved=nodes.map(node=>[node,node.disabled,node.style.pointerEvents]);
    for(const node of nodes){node.disabled=true;node.style.pointerEvents='none';}
    const stop=document.getElementById('mes_stop');if(stop)stop.style.display='flex';
    document.body.dataset.generating='true';document.body.dataset.saveNaRunning='true';
    const keyGuard=event=>{if(event.target?.id==='send_textarea'&&event.key==='Enter'&&!event.shiftKey){event.preventDefault();event.stopImmediatePropagation();}};
    document.addEventListener('keydown',keyGuard,true);
    return()=>{
      document.removeEventListener('keydown',keyGuard,true);delete document.body.dataset.saveNaRunning;
      for(const [node,disabled,pointer]of saved){node.disabled=disabled;node.style.pointerEvents=pointer;}
      if(stop)stop.style.display='none';
      // The saved flag belonged to the completed Relay, never to a future generation.
      delete document.body.dataset.generating;
      getSTContext()?.activateSendButtons?.();
    };
  }
}
