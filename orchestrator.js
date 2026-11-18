// Pruned fork of narrative-agent 0.2.1 Orchestrator (MIT, Lol1p0p).
// Retains merged/split generation, incremental per-turn analysis and the exact n+m window.
import { SummaryStore } from './state.js';
import { ContextRouter } from './context-router.js';
import { runPlanningAgent } from './agent-planning.js';
import { runWritingAgent, runMergedWritingAgent } from './agent-writing.js';
import { runMergedAnalysisAgent, runHistoryAnalysisAgent } from './agent-analysis.js';
import { DEFAULT_CONFIG, MESSAGE_KEY } from './constants.js';
import { extractTurns, contentKey, updateSwipe, bodyOf } from './utils.js';
import { blockReasonOf } from './errors.js';

export class Orchestrator {
  constructor(deps) {
    Object.assign(this, deps);
    this.config = deps.config || DEFAULT_CONFIG;
    this.summaryStore = deps.summaryStore || new SummaryStore();
    this.contextRouter = new ContextRouter({ ...deps, summaryStore:this.summaryStore });
    this._turnHistory = [];
    this.turnCounter = 0;
    this._isRunning = false;
    this._shouldCancel = false;
    this.warnings = [];
    this.presetContext = null;
  }
  setPresetContext(ctx) { this.presetContext = ctx; }
  applyChatExtractedContext(turns) {
    this._turnHistory = turns || [];
    this.turnCounter = turns.filter(t => t.turnNum > 0).length;
    this.summaryStore.reset();
    for (const turn of turns) this.summaryStore.appendEntries(turn.summaryEntries || []);
  }
  _extractTurnHistoryFromChat(chat) { return { turns:extractTurns(chat) }; }
  onProgress(cb) { this._progressCb = cb; }
  _reportProgress(status) { this._progressCb?.(status); }
  _cancelCheck() {
    this.session?.check();
    if (this._shouldCancel) throw new Error('Pipeline cancelled');
  }
  _summariesWithFallback(recent) {
    const included = new Set(recent.map(t => t.turnNum));
    const missing = this._turnHistory.filter(t => !included.has(t.turnNum) && !t.summaryEntries.length);
    return this.summaryStore.getAllSummaries() + (missing.length ? '\n\n<unsummarized_history>\n'
      + missing.map(t => `[第${t.turnNum}轮] 用户：${t.userInput}\n角色：${t.narrativeText}`).join('\n\n') + '\n</unsummarized_history>' : '');
  }
  async _prepareHistory() {
    const cfg = this.config.pipeline;
    const recent = this._getStableRecentTurns(cfg.recentTurnsForWriting, cfg.writingGrowthMargin);
    const recentNumbers = new Set(recent.map(t => t.turnNum));
    // Upstream analyzed turn 0. Also adopt old untagged ST messages instead of silently losing them.
    const missing = this._turnHistory.filter(t => !t.summaryEntries.length && !['blocked','timed-out'].includes(t.analysisState) && (t.turnNum === 0 || !recentNumbers.has(t.turnNum)));
    const batch = [];
    let chars = 0;
    for (const turn of missing) {
      const length = turn.userInput.length + turn.narrativeText.length;
      if (batch.length >= 6 || chars + length > 10000) break;
      batch.push(turn); chars += length;
    }
    if (!batch.length) return;
    this._reportProgress('正在补齐已有聊天的历史摘要……');
    try {
      const result = batch.length === 1
        ? await runMergedAnalysisAgent(this.contextRouter.buildMergedAnalysisContext(batch[0].narrativeText, batch[0].userInput, `turn_${batch[0].turnNum}`))
        : await runHistoryAnalysisAgent(batch);
      this._cancelCheck();
      for (const turn of batch) {
        const entries = result.summary_entries.filter(s => s.includes(`[第${turn.turnNum}轮]`));
        if (!entries.length) continue;
        turn.summaryEntries = entries;
        const message = this._chat[turn.chatIndex];
        if (!message || bodyOf(message) !== turn.narrativeText) throw new Error('历史消息已变化');
        message.extra ??= {};
        message.extra[MESSAGE_KEY] = { schema:2, sourceKey:turn.sourceKey, summaryEntries:entries, turnNum:turn.turnNum };
        updateSwipe(message);
      }
      this.summaryStore.reset();
      for (const turn of this._turnHistory) this.summaryStore.appendEntries(turn.summaryEntries);
    } catch (e) {
      this._cancelCheck();
      const reason = blockReasonOf(e);
      if (reason) {
        for (const turn of batch) {
          const message = this._chat[turn.chatIndex];
          if (!message || bodyOf(message) !== turn.narrativeText) continue;
          turn.analysisState = 'blocked'; turn.blockReason = reason;
          message.extra ??= {};
          message.extra[MESSAGE_KEY] = { schema:2, sourceKey:turn.sourceKey, turnNum:turn.turnNum, summaryEntries:[], analysisState:'blocked', blockReason:reason };
          updateSwipe(message);
        }
        this.warnings.push('历史摘要被 API 拦截（' + reason + '），同一来源不再自动重试，缺失部分保留原文');
      } else this.warnings.push('历史摘要未补齐，缺失部分仍携带原文');
    }
  }
  async pipeline(userInput, isRegeneration = false, chat = null, options = {}) {
    if (this._isRunning) throw new Error('Pipeline already running');
    this._isRunning = true;
    this._shouldCancel = false;
    this._chat = chat;
    this.warnings = [];
    this.continuation = options.continuation || '';
    const turnId = `turn_${String(this.turnCounter + 1).padStart(3, '0')}`;
    try {
      this._cancelCheck();
      // Bind imported legacy <summary> entries to the current source so later edits invalidate them.
      for (const turn of this._turnHistory) {
        const message = chat[turn.chatIndex];
        if (turn.summaryEntries.length && !message.extra?.[MESSAGE_KEY]) {
          message.extra ??= {};
          message.extra[MESSAGE_KEY] = { schema:2, sourceKey:turn.sourceKey, turnNum:turn.turnNum, summaryEntries:turn.summaryEntries };
          updateSwipe(message);
        }
      }
      await this._prepareHistory();
      this._cancelCheck();
      const result = this.config.pipeline.enableTextRecall
        ? await this._fullPipeline(userInput, turnId) : await this._mergedPipeline(userInput, turnId);
      this._cancelCheck();
      this.turnCounter++;
      try { this.fileManager?.saveCheckpoint(turnId, {}, this.summaryStore.toDict()); }
      catch { this.warnings.push('浏览器检查点保存失败；摘要仍随聊天保存'); }
      return { ...result, turnNum:this.turnCounter, warnings:this.warnings };
    } finally { this._isRunning = false; }
  }
  async _mergedPipeline(userInput, turnId) {
    const cfg = this.config.pipeline;
    const recentTurns = this._getStableRecentTurns(cfg.recentTurnsForWriting, cfg.writingGrowthMargin);
    this._reportProgress('正在生成回复……');
    const narrativeText = await runMergedWritingAgent({
      userInput:this._writingInput(userInput), recentTurns,
      systemEntries:[await this.characterReader.getChatInfo()], beforeCharEntries:[], selectiveEntries:[],
      storySummaries:this._summariesWithFallback(recentTurns),
      userPersona:this.userPersonaReader.getPersonaInfo(),
      presetContext:this.presetContext?.writingSystemContext || '',
      writingUserPreset:this.presetContext?.writingUserContext || '',
      presetMessages:this.presetContext?.messages,
    });
    return this._finishTurn(userInput, narrativeText, turnId);
  }
  async _fullPipeline(userInput, turnId) {
    const cfg = this.config.pipeline;
    const recentTurns = this._getStableRecentTurns(cfg.recentTurnsForPlanning, cfg.planningGrowthMargin);
    this._reportProgress('正在规划回复并选择历史原文……');
    const planningCtx = await this.contextRouter.buildPlanningContext(userInput, recentTurns, this.presetContext, this._summariesWithFallback(recentTurns));
    const guide = await runPlanningAgent(planningCtx);
    this._cancelCheck();
    // Same turn-ID retrieval as upstream, extended to both sides and plain native messages.
    const textRecall = this._extractRawTagContent('context', guide.text_recall || []).map(t => `[第${t.turnNum}轮]\n${t.content}`).join('\n\n');
    this._reportProgress('正在生成回复……');
    const writingCtx = await this.contextRouter.buildWritingContext(guide, this._writingInput(userInput),
      this._getStableRecentTurns(cfg.recentTurnsForWriting, cfg.writingGrowthMargin), this.presetContext, textRecall);
    const narrativeText = await runWritingAgent(writingCtx);
    return this._finishTurn(userInput, narrativeText, turnId);
  }
  _writingInput(input) {
    return this.continuation ? `${input}\n\n<continue_from>\n${this.continuation}\n</continue_from>\n请从已有回复的结尾继续，只输出新增部分。` : input;
  }
  async _finishTurn(userInput, generated, turnId) {
    this._cancelCheck();
    // Upstream assembled <context>/<summary> into mes. Here mes is body only; extras carry summaries.
    const clean = generated.replace(/<summary>[\s\S]*?<\/summary>/gi, '').replace(/^\s*<context>\s*([\s\S]*?)\s*<\/context>\s*$/i, '$1').trim();
    if (!clean) throw new Error('生成正文为空');
    const narrative = this.continuation ? this.continuation + '\n' + clean : clean;
    const previous = this._turnHistory.at(-1)?.sourceKey || '';
    const turnNum = Number(turnId.replace('turn_', ''));
    const sourceKey = contentKey(previous + JSON.stringify([turnNum, userInput, narrative]));
    await this.onDraft?.(narrative, {turnNum,sourceKey});
    this._cancelCheck();
    this._reportProgress('回复已生成，正在保存本轮摘要……');
    let merged = { summary_entries:[] };
    let analysisState = 'complete', blockReason = null;
    try {
      merged = await runMergedAnalysisAgent(this.contextRouter.buildMergedAnalysisContext(narrative, userInput, turnId));
      this._cancelCheck();
      const num = Number(turnId.replace('turn_', ''));
      merged.summary_entries = merged.summary_entries.map(s => s.replace(/^\s*\[第\d+轮\]\s*/, '')).filter(Boolean);
      merged.summary_entries = merged.summary_entries.length ? [`[第${num}轮] ${merged.summary_entries.join('；')}`] : [];
      if (!merged.summary_entries.length) { analysisState = 'empty'; this.warnings.push('本轮摘要为空，后续使用本轮原文'); }
    } catch (e) {
      this._cancelCheck();
      blockReason = blockReasonOf(e);
      analysisState = blockReason ? 'blocked' : e.code === 'stage-timeout' ? 'timed-out' : 'failed';
      this.warnings.push(blockReason
        ? '本轮摘要被 API 拦截（' + blockReason + '），不自动重试；回复、思考内容及原文保留'
        : '本轮摘要失败，回复和思考内容保留，后续使用本轮原文');
    }
    this.summaryStore.appendEntries(merged.summary_entries);
    return { narrative, finalOutput:narrative, summaryEntries:merged.summary_entries, analysisState, blockReason,
      sourceKey };
  }
  _extractRawTagContent(tag, targetTurns) {
    return this._turnHistory.filter(t => targetTurns.slice(0, 5).includes(t.turnNum))
      .map(t => ({ turnNum:t.turnNum, content:`用户：${t.userInput}\n角色：${t.narrativeText}` }));
  }

  _getRecentTurns(count) {
    const history = this._turnHistory.filter(t => t.turnNum >= 0);
    if (history.length === 0) return [];
    const start = Math.max(0, history.length - count);
    return history.slice(start).map(t => ({ user: t.userInput || "", assistant: t.narrativeText, turnNum: t.turnNum }));
  }

  _getStableRecentTurns(n, m) {
    const history = this._turnHistory.filter(t => t.turnNum >= 0);
    if (history.length === 0) return [];
    const window = [];
    for (const turn of history) {
      window.push({ user: turn.userInput || "", assistant: turn.narrativeText, turnNum: turn.turnNum });
      if (window.length > n + m) {
        window.splice(0, m + 1);
      }
    }
    return window;
  }
}
