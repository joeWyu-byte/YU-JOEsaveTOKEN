// Fork of SillyTavernBridge from narrative-agent 0.2.1 (MIT, Lol1p0p).
// The original CHAT_COMPLETION_PROMPT_READY -> relay -> GENERATION_ENDED -> pipeline path remains.
import { PLACEHOLDER, MESSAGE_KEY } from './constants.js';
import { getSTContext, getConversationId, getLatestUserInput, extractPresetContext, extractTurns, contentKey, updateSwipe } from './utils.js';
import { setCallSession } from './llm.js';
import { blockReasonOf } from './errors.js';

const supported = new Set(['normal', 'regenerate', 'swipe', 'continue']);
const clone = value => JSON.parse(JSON.stringify(value));
export class SillyTavernBridge {
  constructor(orchestrator, report = () => {}) {
    this.orchestrator = orchestrator;
    this.report = report;
    this.enabled = true;
    this.isPipelineRunning = false;
    this._pending = null;
    this.lastRun = null;
    this.handlers = [];
  }
  install() {
    const ctx = getSTContext();
    const bind = (name, fn) => {
      if (!ctx.eventTypes[name]) throw new Error(`酒馆缺少 ${name} 事件`);
      const bound = fn.bind(this);
      ctx.eventSource.on(ctx.eventTypes[name], bound); this.handlers.push([ctx.eventTypes[name], bound]);
    };
    bind('GENERATION_STARTED', this._onGenerationStarted);
    bind('CHAT_COMPLETION_PROMPT_READY', this._onPromptReady);
    bind('GENERATION_ENDED', this._onGenerationEnded);
    bind('GENERATION_STOPPED', this.cancel);
    bind('CHAT_CHANGED', this.cancel);
  }
  uninstall() {
    this.cancel();
    const ctx = getSTContext();
    for (const [name, fn] of this.handlers) ctx.eventSource.removeListener(name, fn);
    this.handlers = [];
  }
  cancel() {
    if (this._pending) this._pending.cancelled = true;
    if (this.session) this.session.cancelled = true;
    this.orchestrator._shouldCancel = true;
  }
  _onGenerationStarted(type = 'normal', params, dryRun) {
    if (dryRun || this.isPipelineRunning) return;
    this._pending = null;
    if (!this.enabled || !supported.has(type)) return;
    const ctx = getSTContext();
    if (ctx.groupId != null) { this.report('此版处理一对一聊天；群聊使用原生生成。'); return; }
    if (ctx.mainApi && ctx.mainApi !== 'openai') { this.report('请使用酒馆的 Chat Completion 连接方式。'); return; }
    const conflict = ctx.extensionSettings?.['narrative-agent']?.enabled;
    if (conflict) { this.report('请关闭原 Narrative Agent，再启用 Save，避免重复接管。'); return; }
    if (typeof ctx.generateRaw !== 'function') { this.report('酒馆缺少 generateRaw 接口。'); return; }
    this._pending = { type, conversation:getConversationId(), chat:ctx.chat, before:clone(ctx.chat), intercepted:false, cancelled:false };
    this.report('已收到生成事件，等待接管请求……');
  }
  _onPromptReady(data) {
    const p = this._pending;
    if (!this.enabled || this.isPipelineRunning || data.dryRun || !p || p.intercepted || p.cancelled || p.conversation !== getConversationId()) return;
    if (!Array.isArray(data.chat) || !data.chat.length) return;
    const ctx = getSTContext();
    const history = ctx.chat.slice();
    const last = history.at(-1);
    if (['swipe','continue'].includes(p.type) && last && !last.is_user) history.pop();
    if (history.some(m => m.extra?.media?.length || m.extra?.image || m.extra?.file || m.extra?.tool_invocations?.length)) {
      this.report('这段聊天含图片、附件或工具结果，暂时交回原生生成。'); this._pending = null; return;
    }
    p.history = clone(history);
    p.continuation = p.type === 'continue' ? p.before.at(-1)?.mes || '' : '';
    p.userInput = getLatestUserInput(history);
    p.preset = extractPresetContext();
    p.source = contentKey(JSON.stringify(history.map(m => [m.is_user, m.mes])));
    p.prefixLength = history.length;
    p.started = Date.now();
    // Original relay request retained exactly.
    data.chat.splice(0, data.chat.length);
    data.chat.push({ role:'system', content:'You are a relay. You must output exactly the following text and nothing else: ' + PLACEHOLDER });
    data.chat.push({ role:'user', content:'Relay the designated text now.' });
    p.intercepted = true;
    p.requests = [{ stage:'relay', status:'pending', inputChars:JSON.stringify(data.chat).length }];
    this.report('已接管：正在发送原版 Relay 请求……');
  }
  async _onGenerationEnded() {
    const p = this._pending;
    if (!p?.intercepted || this.isPipelineRunning) return;
    this._pending = null;
    const ctx = getSTContext();
    if (p.conversation !== getConversationId() || ctx.chat !== p.chat) return;
    const index = ctx.chat.length - 1;
    const target = ctx.chat[index];
    if (!target || target.is_user) { this.report('Relay 没有生成消息；后台流程未执行。'); return; }
    if (!target.mes?.includes(PLACEHOLDER) || p.cancelled || !this.enabled) {
      p.requests[0].status = 'failed';
      // Restore a previous answer on swipe/continue, otherwise keep native error text.
      if (['swipe','continue','regenerate'].includes(p.type)) {
        const previous = p.before.at(-1);
        if (previous && !previous.is_user) { Object.assign(target, clone(previous)); ctx.updateMessageBlock?.(index, target); }
      } else {
        target.mes = '⚠️ 接管请求未完成，请检查 API 或重试。';
        target.extra ??= {}; target.extra[MESSAGE_KEY] = { failed:true };
        updateSwipe(target); ctx.updateMessageBlock?.(index, target);
      }
      this.lastRun = { requests:p.requests, status:'relay-failed' };
      this.report('Relay 中断或未返回标记，未启动后续 API 请求。');
      await ctx.saveChat?.(); return;
    }
    p.requests[0].status = 'complete'; p.requests[0].outputChars = PLACEHOLDER.length;
    this.isPipelineRunning = true;
    let draft = '';
    const session = {
      requests:p.requests, cancelled:false,
      check:() => {
        const now = getSTContext();
        const samePrefix = contentKey(JSON.stringify(now?.chat?.slice(0, p.prefixLength).map(m => [m.is_user, m.mes]))) === p.source;
        if (session.cancelled || !this.enabled || p.conversation !== getConversationId() || now.chat !== p.chat || now.chat[index] !== target || !samePrefix) throw new Error('Pipeline cancelled');
      },
    };
    this.session = session;
    this.orchestrator.session = session;
    setCallSession(session);
    const unlock = this._lockUI();
    const render = () => ctx.updateMessageBlock?.(index, target);
    const setBody = text => {
      session.check(); target.mes = text; target.extra ??= {};
      delete target.extra.display_text; delete target.extra.token_count;
      updateSwipe(target); render();
    };
    // Clear Relay metadata once; subsequent body renders keep the actual writer response.
    target.extra ??= {};
    const prior = p.type === 'continue' ? p.before.at(-1)?.extra || {} : {};
    target.extra.reasoning = prior.reasoning || '';
    target.extra.reasoning_duration = prior.reasoning_duration || 0;
    target.extra.reasoning_type = prior.reasoning_type || 'model';
    target.extra.reasoning_signature = null;
    session.onWritingResponse = response => {
      session.check();
      target.extra.reasoning = [prior.reasoning, response.reasoning].filter(Boolean).join('\n\n');
      target.extra.reasoning_duration = (prior.reasoning_duration || 0) + (response.reasoning ? response.durationMs : 0);
      target.extra.reasoning_type = response.reasoning ? response.reasoningType : prior.reasoning_type || 'model';
      target.extra.reasoning_signature = response.reasoningSignature;
    };
    try {
      session.check();
      const { turns } = this.orchestrator._extractTurnHistoryFromChat(p.history);
      this.orchestrator.applyChatExtractedContext(turns);
      this.orchestrator.setPresetContext(p.preset);
      this.orchestrator.onProgress(text => { session.check(); this.report(text); });
      this.orchestrator.onDraft = text => { draft = text; setBody(text); };
      // Keep generation progress in the settings panel, never in the chat body.
      setBody(p.continuation || '');
      const result = await this.orchestrator.pipeline(p.userInput, p.type !== 'normal', ctx.chat, { continuation:p.continuation });
      session.check();
      setBody(result.finalOutput);
      target.extra[MESSAGE_KEY] = { schema:2, turnNum:result.turnNum, sourceKey:result.sourceKey, summaryEntries:result.summaryEntries, analysisState:result.analysisState, blockReason:result.blockReason };
      if (p.requests.some(r => r.rawResponseUnavailable)) result.warnings.push('当前酒馆没有 generateRawData 接口，无法读取单独返回的思考字段');
      target.gen_finished = new Date().toISOString();
      updateSwipe(target);
      this.lastRun = { status:'complete', startedAt:p.started, mode:this.orchestrator.config.pipeline.enableTextRecall ? 'split' : 'merged', recentTurns:turns.length, summaries:this.orchestrator.summaryStore.getEntryCount(), requests:p.requests, warnings:result.warnings, durationMs:Date.now()-p.started };
      await ctx.saveChat?.();
      session.check();
      for (const event of ['MESSAGE_EDITED','MESSAGE_UPDATED','CHARACTER_MESSAGE_RENDERED']) if (ctx.eventTypes[event]) await ctx.eventSource.emit(ctx.eventTypes[event], index);
      this.report(`完成：本轮 ${p.requests.length} 次请求，已保存 ${this.lastRun.summaries} 条摘要。${result.warnings.join('；')}`);
    } catch (error) {
      const sameChat = p.conversation === getConversationId() && getSTContext().chat === p.chat && ctx.chat[index] === target;
      if (sameChat) {
        if (draft) {
          target.mes = draft; target.extra ??= {};
          target.extra[MESSAGE_KEY] = { schema:2, summaryEntries:[], sourceKey:extractTurns(ctx.chat).at(-1)?.sourceKey, turnNum:this.orchestrator.turnCounter + 1 };
        } else if (['swipe','continue','regenerate'].includes(p.type) && p.before.at(-1) && !p.before.at(-1).is_user) {
          Object.assign(target, clone(p.before.at(-1)));
        } else {
          target.mes = '⚠️ 本次回复未完成，请重试。'; target.extra ??= {}; target.extra[MESSAGE_KEY] = { failed:true };
        }
        updateSwipe(target); render();
        try { await ctx.saveChat?.(); } catch { /* Report the original error below. */ }
      }
      const blockReason = blockReasonOf(error);
      this.lastRun = { status:session.cancelled ? 'stopped' : blockReason ? 'blocked' : 'failed', blockReason, stage:error.stage, requests:p.requests };
      this.report(`本轮未完整结束：${error.message}。${draft ? '已生成的回复和思考内容保留。' : ''}`);
    } finally {
      setCallSession(null); this.session = null; this.orchestrator.session = null;
      this.orchestrator.onDraft = null;
      unlock(); this.isPipelineRunning = false;
    }
  }
  _lockUI() {
    if (typeof document === 'undefined') return () => {};
    const nodes = [...document.querySelectorAll('#send_but, #option_regenerate, #option_continue, #mes_continue, #mes_impersonate')];
    const saved = nodes.map(node => [node,node.disabled,node.style.pointerEvents]);
    for (const node of nodes) { node.disabled = true; node.style.pointerEvents = 'none'; }
    const stop = document.getElementById('mes_stop');
    if (stop) stop.style.display = 'flex';
    const generating = document.body.dataset.generating;
    document.body.dataset.generating = 'true';
    // ST clears its own generating flag immediately after emitting GENERATION_ENDED.
    // Hold the same native Stop UI until the raw pipeline actually finishes.
    document.body.dataset.saveNaRunning = 'true';
    const keyGuard = event => {
      if (event.target?.id === 'send_textarea' && event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    document.addEventListener('keydown', keyGuard, true);
    return () => {
      document.removeEventListener('keydown', keyGuard, true);
      delete document.body.dataset.saveNaRunning;
      for (const [node, disabled, pointer] of saved) { node.disabled = disabled; node.style.pointerEvents = pointer; }
      if (stop) stop.style.display = 'none';
      if (generating === undefined) delete document.body.dataset.generating; else document.body.dataset.generating = generating;
    };
  }
}
