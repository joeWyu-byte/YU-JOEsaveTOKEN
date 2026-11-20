import { getSTContext, extractPresetContext, getLatestUserInput, getConversationId } from './utils.js';
import { PLACEHOLDER } from './constants.js';
import { applySummaryDisplay, noteRelayRequest } from './save-custom.js';
import { takeNativePromptSnapshot } from './native-chat.js';
import { startGenerationSession, endGenerationSession } from './generation-session.js';
import { replaceWriterMetadata } from './response-adapter.js';

const copy = value => JSON.parse(JSON.stringify(value));
const envelope = body => `<context>\n${body}\n</context>`;

export class SillyTavernBridge {
  constructor(orchestrator) {
    this.orchestrator = orchestrator;
    this.enabled = true;
    this.wasIntercepted = false;
    this.isPipelineRunning = false;
    this._aborted = false;
    this._pipelineCompleteCbs = [];
    this._listeners = [];
    this._pending = null;
    this._run = null;
    this._settled = Promise.resolve();
  }

  onPipelineComplete(cb) { this._pipelineCompleteCbs.push(cb); }
  install() {
    const ctx = getSTContext();
    const on = (key, handler) => {
      if (!ctx.eventTypes[key]) return;
      const bound = handler.bind(this);
      ctx.eventSource.on(ctx.eventTypes[key], bound);
      this._listeners.push([ctx.eventTypes[key], bound]);
    };
    on('GENERATION_STARTED', this._onGenerationStarted);
    on('CHAT_COMPLETION_PROMPT_READY', this._onPromptReady);
    on('GENERATION_ENDED', this._onGenerationEnded);
    on('GENERATION_STOPPED', function () {
      if (!this.enabled && !this.isPipelineRunning && !this.wasIntercepted) return;
      this.cancel('已停止');
      this.status('已停止');
    });
    on('CHAT_CHANGED', function () { this.cancel('已切换聊天'); });
    on('MESSAGE_DELETED', function (length) {
      if (this.isPipelineRunning) { this.cancel('消息已删除'); return; }
      if (this.enabled && length <= 1) this.orchestrator.rollbackToTurn(0);
      else this.orchestrator.invalidatePrefetch();
    });
    on('MESSAGE_EDITED', function (index) {
      if (!this._internalUpdate && this._run?.target === getSTContext()?.chat?.[Number(index)]) this.cancel('回复已被编辑');
    });
  }
  uninstall() {
    this.cancel('插件已关闭');
    const ctx = getSTContext();
    for (const [event, fn] of this._listeners) ctx?.eventSource.removeListener(event, fn);
    this._listeners = [];
  }

  status(text, error = false) {
    const el = typeof document === 'undefined' ? null : document.querySelector('#save_run_status');
    if (el) el.textContent = text;
    this.lastStatus = text;
    if (error && typeof toastr !== 'undefined') toastr.warning(text, 'Save');
  }

  _hideRelay(index) {
    if (typeof document === 'undefined') return;
    let style = document.querySelector('#save_pending_message');
    if (!style) {
      style = document.createElement('style'); style.id = 'save_pending_message';
      document.head.append(style);
    }
    style.textContent = `#chat .mes[mesid="${index}"] { display: none !important; }`;
  }
  _showReply() { document.querySelector?.('#save_pending_message')?.remove(); }

  _lock() {
    getSTContext()?.deactivateSendButtons?.();
    $('#send_but, #option_regenerate, #option_continue, #mes_continue, #mes_impersonate').prop('disabled', true).css('pointer-events', 'none');
    $('#mes_stop').css('display', 'flex');
  }
  _unlock() {
    $('#send_but, #option_regenerate, #option_continue, #mes_continue, #mes_impersonate').prop('disabled', false).css('pointer-events', '');
    getSTContext()?.activateSendButtons?.();
    $('#mes_stop').css('display', 'none');
    delete document.body.dataset.generating;
  }

  _onGenerationStarted(type, _options, dryRun) {
    type = type || 'normal';
    if (!this.enabled || dryRun || !['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return;
    if (this.isPipelineRunning) throw new Error('Save 上一轮仍在处理，请先停止');
    const ctx = getSTContext();
    const last = ctx.chat.at(-1);
    this._aborted = false;
    this._pending = {
      type, chat: ctx.chat, chatId: getConversationId(),
      prior: type !== 'normal' && last && !last.is_user ? copy(last) : null,
      priorIndex: ctx.chat.length - 1,
    };
  }

  _onPromptReady(data) {
    if (!this.enabled || this.isPipelineRunning || !this._pending || !Array.isArray(data.chat)) return;
    const ctx = getSTContext();
    if (this._pending.chat !== ctx.chat) return;
    const snapshot = takeNativePromptSnapshot(ctx);
    if (!data.dryRun && !snapshot) {
      this.status('原生提示未能读取，本轮使用酒馆原生生成；请检查扩展兼容性', true);
      this._pending = null;
      return;
    }
    if (!data.dryRun) {
      const raw = ctx.chat;
      const { turns } = this.orchestrator._extractTurnHistoryFromChat(raw);
      this.orchestrator.applyChatExtractedContext(turns);
      this.orchestrator.setPresetContext(this.orchestrator.config.presetMode === 'split' ? extractPresetContext() : null);
      const last = raw.at(-1);
      Object.assign(this._pending, {
        snapshot, turns, userInput: getLatestUserInput(raw),
        targetIndex: this._pending.type !== 'normal' && last && !last.is_user ? raw.length - 1 : raw.length,
      });
      this._hideRelay(this._pending.targetIndex);
      this.wasIntercepted = true;
      noteRelayRequest();
      this.status('正在生成回复');
    }
    data.chat.splice(0, data.chat.length,
      { role: 'system', content: 'You are a relay. You must output exactly the following text and nothing else: ' + PLACEHOLDER },
      { role: 'user', content: 'Relay the designated text now.' });
  }

  cancel(reason = '已停止') {
    this._aborted = true;
    this.orchestrator._shouldCancel = true;
    this._run?.cancel(reason);
    if (!this.isPipelineRunning && this._pending) {
      this.wasIntercepted = false;
      this._pending.cancelReason = reason;
    }
  }
  async waitForIdle() { await this._settled; }

  _syncSwipe(message) {
    if (!Array.isArray(message.swipes)) return;
    const index = message.swipe_id ?? 0;
    message.swipes[index] = message.mes;
    if (Array.isArray(message.swipe_info)) message.swipe_info[index] = {
      ...(message.swipe_info[index] || {}), send_date: message.send_date,
      gen_started: message.gen_started, gen_finished: message.gen_finished, extra: copy(message.extra || {}),
    };
  }

  _render(run) {
    run.assertActive();
    const index = run.chat.indexOf(run.target);
    applySummaryDisplay(run.target);
    this._syncSwipe(run.target);
    run.revision = run.target.mes;
    run.context.updateMessageBlock(index, run.target);
    run.context.updateReasoningUI?.(index);
    this._showReply();
  }

  async _save(run) {
    run.assertActive();
    if (typeof run.context.saveChat !== 'function') throw new Error('当前酒馆没有提供保存接口');
    run.saveAttempted = true;
    let timer;
    const originalFetch = globalThis.fetch;
    const outcomes = [];
    // ST catches save errors internally. Observe its actual HTTP result without
    // changing requests, consuming responses, or writing through another API.
    const observedFetch = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
      const isSave = /\/api\/(?:chats\/(?:group\/)?save|groupchats\/save)(?:[?#]|$)/.test(url);
      try {
        const result = await originalFetch.apply(globalThis, args);
        if (isSave) outcomes.push({ ok: result.ok, status: result.status });
        return result;
      } catch (error) {
        if (isSave) outcomes.push({ ok: false, status: 'network' });
        throw error;
      }
    };
    globalThis.fetch = observedFetch;
    try {
      await Promise.race([
        run.context.saveChat(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('保存未确认，请保留页面并重试保存')), run.saveTimeout ?? 15000); }),
      ]);
      const saved = outcomes.at(-1);
      run.saveResult = saved ?? { ok: false, status: 'unconfirmed' };
      if (!saved?.ok) throw new Error(saved ? `保存失败（${saved.status}），请保留页面并重试保存` : '保存结果未确认，请保留页面并重试保存');
    } finally {
      clearTimeout(timer);
      if (globalThis.fetch === observedFetch) globalThis.fetch = originalFetch;
    }
  }

  async _removeTemporary(pending, target) {
    const ctx = getSTContext();
    if (ctx?.chat !== pending.chat || getConversationId() !== pending.chatId || !target || target.is_user) return;
    const index = ctx.chat.indexOf(target);
    if (index < 0) return;
    if (pending.prior) {
      Object.keys(target).forEach(key => delete target[key]);
      Object.assign(target, copy(pending.prior));
      ctx.updateMessageBlock(index, target);
      ctx.updateReasoningUI?.(index);
    } else if (index === ctx.chat.length - 1) {
      if (ctx.deleteLastMessage) await ctx.deleteLastMessage();
      else ctx.chat.pop();
    }
  }

  async _onGenerationEnded() {
    if (this.isPipelineRunning || !this._pending) return;
    const pending = this._pending;
    this._pending = null;
    const ctx = getSTContext();
    const target = pending.chat[pending.targetIndex];
    if (!this.wasIntercepted || this._aborted || !target?.mes?.includes(PLACEHOLDER) || ctx.chat !== pending.chat) {
      if (this.wasIntercepted || pending.cancelReason) await this._removeTemporary(pending, target);
      this.wasIntercepted = false;
      this._showReply();
      if (pending.cancelReason) this.status(pending.cancelReason);
      return;
    }
    this.wasIntercepted = false;
    this.isPipelineRunning = true;
    this.orchestrator._shouldCancel = false;
    this._lock();
    for (const key of ['reasoning', 'reasoning_display_text', 'reasoning_duration', 'reasoning_signature', 'token_count', 'time_to_first_token']) delete (target.extra || {})[key];
    let resolveIdle;
    this._settled = new Promise(resolve => { resolveIdle = resolve; });
    const run = startGenerationSession({
      context: ctx, chat: pending.chat, chatId: pending.chatId, target,
      snapshot: pending.snapshot, turns: pending.turns, orchestrator: this.orchestrator,
      revision: target.mes,
      isCurrent: () => getSTContext()?.chat === pending.chat && getConversationId() === pending.chatId && pending.chat.includes(target) && (!this._run || target.mes === this._run.revision),
      onStatus: text => this.status(text),
      onWriter: response => {
        run.assertActive();
        let text = response.text.trim();
        if (pending.type === 'continue' && pending.prior) text = (pending.prior.extra?.display_text ?? pending.prior.mes) + text;
        run.body = text;
        target.mes = envelope(text);
        run.revision = target.mes;
        replaceWriterMetadata(target, response, ctx);
        target.extra.save_native_writer = 1;
        this._render(run);
        return text;
      },
    });
    this._run = run;
    this.orchestrator.onProgress(() => {});
    try {
      const result = await this.orchestrator.pipeline(pending.userInput, ['swipe', 'regenerate', 'continue'].includes(pending.type), pending.chat);
      run.assertActive();
      if (!run.writer || !run.body) throw new Error('本轮未收到实际回复');
      target.mes = pending.type === 'continue'
        ? (result.finalOutput || envelope(run.body)).replace(envelope(result.narrative), envelope(run.body))
        : result.finalOutput || envelope(run.body);
      run.revision = target.mes;
      target.extra.state_panel = null;
      target.extra.writing_guide = result.writingGuide;
      target.extra.events = result.events;
      this._render(run);
      for (const cb of this._pipelineCompleteCbs) { run.assertActive(); await cb(result); }
      await this._save(run);
      run.assertActive();
      this._internalUpdate = true;
      try {
        const index = run.chat.indexOf(target);
        for (const key of ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'CHARACTER_MESSAGE_RENDERED']) if (ctx.eventTypes[key]) await ctx.eventSource.emit(ctx.eventTypes[key], index);
      } finally { this._internalUpdate = false; }
      const lastAnalysis = run.requests.findLast(r => r.label.includes('analysis'));
      this.status(lastAnalysis?.status === 'error' ? '回复已保存；本轮记忆整理失败，原文保留' : '本轮已完成并保存', lastAnalysis?.status === 'error');
    } catch (error) {
      const stopped = run.controller.signal.aborted || !run.isCurrent();
      if (!run.writer && run.isCurrent()) await this._removeTemporary(pending, target);
      if (run.writer && run.isCurrent()) {
        this._syncSwipe(target);
        if (!run.saveAttempted) try { await this._save({ ...run, assertActive: () => {} }); } catch { /* status below remains explicit */ }
      }
      this.status(stopped ? `${run.cancelReason || '已停止'}${run.writer ? '；已收到的回复保留' : ''}` : `${error.message}；${run.writer ? '回复已保留' : '请检查接口后重试'}`, !stopped);
      console.error('[Save]', error);
    } finally {
      endGenerationSession(run);
      this.lastRun = { status: this.lastStatus, requests: run.requests, promptAudit: run.promptAudit, saveResult: run.saveResult };
      this._run = null;
      this.orchestrator.onProgress(null);
      this.orchestrator._shouldCancel = false;
      this.orchestrator._isRunning = false;
      this.isPipelineRunning = false;
      this._showReply();
      this._unlock();
      resolveIdle();
    }
  }
}
