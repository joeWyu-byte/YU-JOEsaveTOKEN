// Derived directly from Narrative Agent 0.2.1. RPG branches removed; boundary fixes listed in CHANGE-MAP.md.
import { SummaryStore } from './state.js';
import { ContextRouter } from './context-router.js';
import { runPlanningAgent } from './agent-planning.js';
import { runWritingAgent, runMergedWritingAgent } from './agent-writing.js';
import { runMergedAnalysisAgent } from './agent-analysis.js';
import { DEFAULT_CONFIG } from './constants.js';
import { blockReasonOf } from './errors.js';
import { isRetryable } from './llm.js';
export class Orchestrator {
  constructor(deps) {
    this.summaryStore = deps.summaryStore;
    this.fileManager = deps.fileManager;
    this.characterReader = deps.characterReader;
    this.contentSource = deps.contentSource;
    this.userPersonaReader = deps.userPersonaReader;
    this.config = deps.config || DEFAULT_CONFIG;
    this.turnCounter = 0;
    this._isRunning = false;
    this._shouldCancel = false;
    this.presetContext = null;
    this._turnHistory = [];
    this._progressCb = null;
    this.contextRouter = new ContextRouter(deps);
    this.warnings = [];
    this.continuation = "";
  }

  setPresetContext(ctx) {
    this.presetContext = ctx;
  }

  applyChatExtractedContext(turns) {
    this._turnHistory = turns || [];
    this.turnCounter = turns.filter(t => t.turnNum > 0).length;
    const turn0 = turns.find(t => t.turnNum === 0);
    console.log(`[NA:applyContext] 接收 turns 数量: ${turns.length}, turnCounter=${this.turnCounter}, turn0存在=${!!turn0}, turn0.narrativeText长度=${turn0 ? turn0.narrativeText.length : "N/A"}`);
  }

  _getOpeningNarrative() {
    const entry = this._turnHistory.find(t => t.turnNum === 0);
    const result = entry ? entry.narrativeText : "";
    console.log(`[NA:getOpening] _turnHistory长度=${this._turnHistory.length}, turn0存在=${!!entry}, 返回值长度=${result.length}${result ? ", 预览: " + result.substring(0, 80) : ""}`);
    return result;
  }

  _cancelCheck() {
    this.session?.check();
    if (this._shouldCancel) {
      this._shouldCancel = false;
      throw new Error("Pipeline cancelled");
    }
  }

  async _analyzeTurn0() {
    const turn0 = this._turnHistory.find(t => t.turnNum === 0);
    if (!turn0 || !turn0.narrativeText) return;

    console.log("[NarrativeAgent] 检测到首轮前叙事上下文(turn0)，执行合并分析...");
    this._reportProgress("正在分析背景叙事...");

    const turnId = "turn_000";
    const ctx = this.contextRouter.buildMergedAnalysisContext(
      turn0.narrativeText, "", turnId, ""
    );

    try {
      const merged = await runMergedAnalysisAgent(ctx);
      this._cancelCheck();

      if (merged.summary_entries.length > 0) {
        this.summaryStore.appendEntries(merged.summary_entries);
      }

      this._saveCheckpoint(turnId);
      console.log("[NarrativeAgent] turn0合并分析完成, events:", 0, "summary_entries:", merged.summary_entries.length);
    } catch (e) {
      this._cancelCheck();
      if (e.code === "cancelled" || e.message === "Pipeline cancelled") throw e;
      this.openingAnalysisState = blockReasonOf(e) ? "blocked" : "failed";
      this.warnings.push("开场摘要未完成，原文保留：" + (blockReasonOf(e) || e.message));
      console.error("[NarrativeAgent] turn0合并分析失败:", e.message);
    }
  }

  onProgress(cb) {
    this._progressCb = cb;
  }

  _reportProgress(status) {
    if (typeof this._progressCb === "function") {
      try { this._progressCb(status); } catch (e) { /* ignore */ }
    }
  }

  async pipeline(userInput, isRegeneration = false, chat = null) {
    if (this._isRunning) throw new Error("Pipeline already running");
    this._isRunning = true;
    this._chat = chat;
    this.warnings = [];
    this._shouldCancel = false;
    this.draftExists = false;

    let turnId;
    if (isRegeneration) {
      turnId = `turn_${String(this.turnCounter).padStart(3, "0")}`;
      await this._rollbackToCheckpoint(turnId);
    } else {
      turnId = `turn_${String(this.turnCounter + 1).padStart(3, "0")}`;
    }

    try {
      if (!isRegeneration && this.turnCounter === 0 && this._turnHistory.length > 0 && this._turnHistory[0].turnNum === 0 && !this.summaryStore.getAllSummaries().includes("[第0轮]") && !this.skipOpeningAnalysis) {
        await this._analyzeTurn0();
      }
      const result = await this._fullPipeline(userInput, turnId);
      if (!isRegeneration) this.turnCounter++;
      return {...result, turnNum:this.turnCounter, warnings:this.warnings};
    } catch (error) {
      this._cancelCheck();
      if (blockReasonOf(error) || error.code === 'stage-timeout' || error.code === 'cancelled' || this.draftExists || !isRetryable(error)) throw error;
      this.warnings.push('技术故障后使用原版备用生成流程');
      const result = await this._fallbackPipeline(userInput, turnId);
      if (!isRegeneration) this.turnCounter++;
      return {...result, turnNum:this.turnCounter, warnings:this.warnings};
    } finally {
      this._isRunning = false;
    }
  }

  async _fullPipeline(userInput, turnId) {
    const cfg = this.config.pipeline;

    

    const recentTurns = this._getStableRecentTurns(cfg.recentTurnsForPlanning, cfg.planningGrowthMargin || 3);
    const narrativeMatchText = recentTurns.map(t => t.user + " " + t.assistant).join(" ");
    const planningTools = [];
    if (planningTools.length === 0 && !cfg.enableTextRecall) {
      console.log("[NarrativeAgent] 无 planning 工具，切换为合并输出模式");
      this._cancelCheck();
      return await this._mergedPipeline(userInput, turnId);
    }

    console.log("[NarrativeAgent] Phase 1: Planning");
    this._reportProgress("正在生成写作指导...");

    const systemEntries = await this.contentSource.getConstantSystemEntries();
    const beforeCharEntries = await this.contentSource.getConstantBeforeCharEntries();
    const constantAfterCharEntries = await this.contentSource.getConstantAfterCharEntries();
    const stateSummary = await Promise.resolve("");
    const selectiveEntries = await this.contentSource.getSelectiveActivatedEntries(narrativeMatchText, stateSummary);
    const allWorldInfo3 = [...constantAfterCharEntries, ...selectiveEntries];
    console.log(`[NA:WI:pipeline] 汇总: systemEntries=${systemEntries.length} beforeCharEntries=${beforeCharEntries.length} constantAfterChar=${constantAfterCharEntries.length} selective=${selectiveEntries.length} allWorldInfo3=${allWorldInfo3.length} matchText长度=${narrativeMatchText.length}`);

    if (stateSummary && !stateSummary.startsWith("\uff08\u65e0")) {
      console.log("[NarrativeAgent] state loaded:", stateSummary.substring(0, 80));
    }

    const planningCtx = await this.contextRouter.buildPlanningContext(
      userInput, recentTurns, systemEntries, beforeCharEntries, allWorldInfo3,
      stateSummary, this.presetContext, planningTools
    );
    planningCtx.storySummaries = this._summariesFor(recentTurns);
    const writingGuide = await runPlanningAgent(planningCtx);
    this._cancelCheck();

    let textRecallEntries = null;
    if (writingGuide.text_recall && writingGuide.text_recall.length > 0) {
      const rawResults = this._extractRawTagContent("context", writingGuide.text_recall);
      if (rawResults.length > 0) {
        textRecallEntries = rawResults.map(r => `[\u7b2c${r.turnNum}\u8f6e]\n${r.content}`).join("\n\n");
        console.log(`[NA:text_recall] 提取原文: 请求轮次=[${writingGuide.text_recall.join(",")}] 命中=${rawResults.length} 总字符=${textRecallEntries.length}`);
      } else {
        console.log(`[NA:text_recall] 提取原文: 请求轮次=[${writingGuide.text_recall.join(",")}] 未命中任何内容`);
      }
    }

    this._cancelCheck();

    console.log("[NarrativeAgent] Phase 2: Writing");
    this._reportProgress("正在创作故事...");
    const recentNarratives = this._getStableRecentTurns(cfg.recentTurnsForWriting, cfg.writingGrowthMargin || 4);

    const writingSystemPreset = (typeof this.presetContext === 'object')
      ? (this.presetContext.writingSystemContext || "")
      : "";
    const writingUserPreset = (typeof this.presetContext === 'object')
      ? (this.presetContext.writingUserContext || "")
      : "";

    const writingCtx = await this.contextRouter.buildWritingContext(
      writingGuide, userInput, recentNarratives,
      systemEntries, allWorldInfo3,
      writingSystemPreset, writingUserPreset,
      "",
      beforeCharEntries,
      textRecallEntries
    );
    const generatedText = await runWritingAgent(writingCtx);
    const narrativeText = this.continuation ? this.continuation + "\n" + generatedText : generatedText;
    this.draftExists = true;
    await this.onDraft?.(narrativeText);
    this._cancelCheck();

    console.log("[NarrativeAgent] Phase 3: Merged Analysis");
    this._reportProgress("正在总结整理...");
    const analysisCtx = this.contextRouter.buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary);
    let merged;
    let analysisState = "complete", analysisBlock = null;
    try {
      merged = await runMergedAnalysisAgent(analysisCtx);
    } catch (e) {
      console.error("[NarrativeAgent] Merged Analysis 失败，跳过事件提取与摘要压缩:", e.message);
      this._cancelCheck();
      analysisBlock = blockReasonOf(e);
      analysisState = analysisBlock ? 'blocked' : e.code === 'stage-timeout' ? 'timed-out' : 'failed';
      this.warnings.push('本轮摘要未完成，正文及思考保留：' + (analysisBlock || e.message));
      merged = { summary_entries: [] };
    }


    if (merged.summary_entries.length > 0) {
      this.summaryStore.appendEntries(merged.summary_entries);
    }

    console.log("[NarrativeAgent] Phase 5: Assembly");

    const summaryText = merged.summary_entries.length > 0
      ? merged.summary_entries.join("\n")
      : "";

    const parts = [];
    parts.push(`<context>\n${narrativeText}\n</context>`);
    if (summaryText) {
      parts.push(`<summary>\n${summaryText}\n</summary>`);
    }
    const finalOutput = parts.join("\n\n");

    this._saveCheckpoint(turnId);

    return {
      narrative: narrativeText,
      formatted: null,
      writingGuide: writingGuide,
      finalOutput,
      summaryEntries: merged.summary_entries, analysisState, blockReason:analysisBlock,
    };
  }

  async _mergedPipeline(userInput, turnId) {
    const cfg = this.config.pipeline;

    

    const recentTurns = this._getStableRecentTurns(cfg.recentTurnsForWriting, cfg.writingGrowthMargin || 4);
    const narrativeMatchText = recentTurns.map(t => t.user + " " + t.assistant).join(" ");

    console.log("[NarrativeAgent] Phase 1+2: Merged Writing (合并模式)");
    this._reportProgress("正在创作故事...");

    const systemEntries = await this.contentSource.getConstantSystemEntries();
    const beforeCharEntries = await this.contentSource.getConstantBeforeCharEntries();
    const constantAfterCharEntries = await this.contentSource.getConstantAfterCharEntries();
    const stateSummary = await Promise.resolve("");
    const selectiveEntries = await this.contentSource.getSelectiveActivatedEntries(narrativeMatchText, stateSummary);
    const allWorldInfo3 = [...constantAfterCharEntries, ...selectiveEntries];
    console.log(`[NA:WI:pipeline-merged] 汇总: systemEntries=${systemEntries.length} beforeCharEntries=${beforeCharEntries.length} constantAfterChar=${constantAfterCharEntries.length} selective=${selectiveEntries.length} allWorldInfo3=${allWorldInfo3.length} matchText长度=${narrativeMatchText.length}`);

    const generatedText = await runMergedWritingAgent({
      userInput,
      recentTurns,
      systemEntries,
      beforeCharEntries,
      selectiveEntries: allWorldInfo3,
      stateSummary,
      storySummaries: this._summariesFor(recentTurns),
      userPersona: this.userPersonaReader.getPersonaInfo(),
      presetContext: (typeof this.presetContext === "object")
        ? (this.presetContext.planningContext || "")
        : "",
      writingUserPreset: (typeof this.presetContext === "object")
        ? (this.presetContext.writingUserContext || "")
        : "",
    });

    const narrativeText = this.continuation ? this.continuation + "\n" + generatedText : generatedText;
    this.draftExists = true;
    await this.onDraft?.(narrativeText);
    this._cancelCheck();

    const mergedGuide = {
      narrative_direction: "",
      key_points: [],
      tone: "中",
      pacing: "中",
      continuity_notes: [],
      scene_setting: "",
    };

    this._cancelCheck();

    console.log("[NarrativeAgent] Phase 3: Merged Analysis");
    this._reportProgress("正在总结整理...");
    const analysisCtx = this.contextRouter.buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary);
    let merged;
    let analysisState = "complete", analysisBlock = null;
    try {
      merged = await runMergedAnalysisAgent(analysisCtx);
    } catch (e) {
      console.error("[NarrativeAgent] Merged Analysis 失败，跳过事件提取与摘要压缩:", e.message);
      this._cancelCheck();
      analysisBlock = blockReasonOf(e);
      analysisState = analysisBlock ? 'blocked' : e.code === 'stage-timeout' ? 'timed-out' : 'failed';
      this.warnings.push('本轮摘要未完成，正文及思考保留：' + (analysisBlock || e.message));
      merged = { summary_entries: [] };
    }


    if (merged.summary_entries.length > 0) {
      this.summaryStore.appendEntries(merged.summary_entries);
    }

    console.log("[NarrativeAgent] Phase 5: Assembly");

    const summaryText = merged.summary_entries.length > 0
      ? merged.summary_entries.join("\n")
      : "";

    const parts = [];
    parts.push(`<context>\n${narrativeText}\n</context>`);
    if (summaryText) {
      parts.push(`<summary>\n${summaryText}\n</summary>`);
    }
    const finalOutput = parts.join("\n\n");

    this._saveCheckpoint(turnId);

    return {
      narrative: narrativeText,
      formatted: null,
      writingGuide: mergedGuide,
      finalOutput,
      summaryEntries: merged.summary_entries, analysisState, blockReason:analysisBlock,
    };
  }

  async _fallbackPipeline(userInput, turnId) {
    console.log("[NarrativeAgent] Using fallback pipeline");
      const fallbackGuide = { narrative_direction: "", key_points: [], tone: "中", pacing: "中", continuity_notes: [],  };
      const recentNarratives = this._getRecentTurns(3);

      const systemEntries = await this.contentSource.getConstantSystemEntries();
      const beforeCharEntries = await this.contentSource.getConstantBeforeCharEntries();
      const constantAfterCharEntries = await this.contentSource.getConstantAfterCharEntries();
      const stateSummary = await Promise.resolve("");
      const selectiveEntries = await this.contentSource.getSelectiveActivatedEntries("", stateSummary);
      const allWorldInfo3 = [...constantAfterCharEntries, ...selectiveEntries];
      console.log(`[NA:WI:pipeline-fallback] 汇总: systemEntries=${systemEntries.length} beforeCharEntries=${beforeCharEntries.length} constantAfterChar=${constantAfterCharEntries.length} selective=${selectiveEntries.length} allWorldInfo3=${allWorldInfo3.length}`);

      const writingCtx = {
        userPersona: this.userPersonaReader.getPersonaInfo(),
        writingGuide: fallbackGuide,
        recentNarratives,
        systemEntries,
        beforeCharEntries,
        selectiveEntries: allWorldInfo3,
        writingSystemPreset: "",
        writingUserPreset: "",
        userInput,
        toolResultsText: "",
      };
      const generatedText = await runWritingAgent(writingCtx);
      const narrativeText = this.continuation ? this.continuation + "\n" + generatedText : generatedText;
      this.draftExists = true;
      await this.onDraft?.(narrativeText);

    console.log("[NarrativeAgent] Phase 3: Merged Analysis");
    this._reportProgress("正在总结整理...");
    const analysisCtx = this.contextRouter.buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary);
    let merged;
    let analysisState = "complete", analysisBlock = null;
    try {
      merged = await runMergedAnalysisAgent(analysisCtx);
    } catch (e) {
      console.error("[NarrativeAgent] Merged Analysis 失败，跳过事件提取与摘要压缩:", e.message);
      this._cancelCheck();
      analysisBlock = blockReasonOf(e);
      analysisState = analysisBlock ? 'blocked' : e.code === 'stage-timeout' ? 'timed-out' : 'failed';
      this.warnings.push('本轮摘要未完成，正文及思考保留：' + (analysisBlock || e.message));
      merged = { summary_entries: [] };
    }


    if (merged.summary_entries.length > 0) {
      this.summaryStore.appendEntries(merged.summary_entries);
    }

    console.log("[NarrativeAgent] Phase 5: Assembly");

    const summaryText = merged.summary_entries.length > 0
      ? merged.summary_entries.join("\n")
      : "";

    const parts = [];
    parts.push(`<context>\n${narrativeText}\n</context>`);
    if (summaryText) {
      parts.push(`<summary>\n${summaryText}\n</summary>`);
    }
    const finalOutput = parts.join("\n\n");

    this._saveCheckpoint(turnId);

    return {
      narrative: narrativeText,
      formatted: null,
      writingGuide: fallbackGuide,
      finalOutput,
      summaryEntries: merged.summary_entries, analysisState, blockReason:analysisBlock,
    };
  }

  _saveCheckpoint(turnId) {
    try { this.fileManager?.saveCheckpoint(turnId, {}, this.summaryStore.toDict()); }
    catch { this.warnings.push('浏览器检查点未保存；完整记录仍随聊天保存'); }
  }
  _summariesFor(recentTurns) {
    const included = new Set(recentTurns.map(t => t.turnNum));
    const missing = this._turnHistory.filter(t => !included.has(t.turnNum) && !this.validSummaryTurns?.has(t.turnNum));
    return this.summaryStore.getAllSummaries() + (missing.length ? '\n\n<unsummarized_history>\n' + missing.map(t => '[第'+t.turnNum+'轮] 用户：'+(t.userInput || '')+'\n角色：'+t.narrativeText).join('\n\n') + '\n</unsummarized_history>' : '');
  }
  async _rollbackToCheckpoint(turnId) {
    const n = Number(String(turnId).replace('turn_', '')) - 1;
    const checkpoint = this.fileManager?.loadCheckpoint('turn_'+String(n).padStart(3,'0'));
    if (checkpoint?.summary) this.summaryStore.reset(SummaryStore.fromDict(checkpoint.summary));
    this._turnHistory = this._turnHistory.filter(t => t.turnNum <= n);
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

  _cleanContextContent(text) {
    let inner = text;
    inner = inner.replace(/```[\s\S]*?```/g, "");
    inner = inner.replace(/<[\p{L}_\|][^>]*>[\s\S]*?<\/[\p{L}_\|][^>]*>/gu, "");
    inner = inner.replace(/<[\p{L}_\|][^>]*\/>/gu, "");
    inner = inner.replace(/\n{3,}/g, "\n\n").trim();
    return inner;
  }

  _extractTaggedContentFromChat(tag, targetTurns) {
    if (!tag || !Array.isArray(targetTurns) || targetTurns.length === 0) return "";
    if (!this._chat || !Array.isArray(this._chat)) {
      console.log(`[NA:tool_history] _extractTaggedContentFromChat: this._chat 无效, 返回空`);
      return "";
    }

    const turnMap = new Map();
    for (const t of this._turnHistory) {
      if (t.chatIndex != null) {
        turnMap.set(t.turnNum, t.chatIndex);
      }
    }
    console.log(`[NA:tool_history] _extractTaggedContentFromChat: tag="${tag}" targetTurns=[${targetTurns.join(",")}] turnMap大小=${turnMap.size} turnMap entries=[${[...turnMap.entries()].map(([tn, ci]) => tn + "->chat[" + ci + "]").join(", ")}]`);

    const parts = [];
    const sorted = [...targetTurns].sort((a, b) => a - b);

    for (const turnNum of sorted) {
      const idx = turnMap.get(turnNum);
      console.log(`[NA:tool_history] turnNum=${turnNum} chatIndex=${idx} chatLength=${this._chat.length}`);
      if (idx == null || idx >= this._chat.length) {
        console.log(`[NA:tool_history] turnNum=${turnNum} idx无效(idx=${idx})或越界, 跳过`);
        continue;
      }
      const msg = this._chat[idx];
      const text = (msg && (msg.mes || msg.content)) || "";
      if (!text) {
        console.log(`[NA:tool_history] turnNum=${turnNum} chat[${idx}] 无文本内容, 跳过`);
        continue;
      }

      console.log(`[NA:tool_history] turnNum=${turnNum} chat[${idx}] 文本长度=${text.length}, 首100字="${text.substring(0, 100)}"`);
      const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "gi");
      let match;
      let matchCount = 0;
      while ((match = regex.exec(text)) !== null) {
        if (match[1].trim()) {
          parts.push(match[1].trim());
          matchCount++;
        }
      }
      console.log(`[NA:tool_history] turnNum=${turnNum} <${tag}> 匹配数=${matchCount}`);
    }

    console.log(`[NA:tool_history] _extractTaggedContentFromChat: 总匹配数=${parts.length}`);
    if (parts.length === 0) return "";

    if (parts.length === 1) {
      return `<${tag}>\n${parts[0]}\n</${tag}>`;
    }

    const labeled = parts.map((p, i) => {
      const ago = parts.length - i;
      return `--- ${ago} 轮前 ---\n${p}`;
    });
    return `<${tag}>\n${labeled.join("\n\n")}\n</${tag}>`;
  }

  _extractRawTagContent(tag, targetTurns) {
    const results = [];
    if (!tag || !Array.isArray(targetTurns) || targetTurns.length === 0) return results;
    if (!this._chat || !Array.isArray(this._chat)) return results;

    const turnMap = new Map();
    for (const t of this._turnHistory) {
      if (t.chatIndex != null) {
        turnMap.set(t.turnNum, t.chatIndex);
      }
    }

    const sorted = [...targetTurns].sort((a, b) => a - b);

    for (const turnNum of sorted) {
      const idx = turnMap.get(turnNum);
      if (idx == null || idx >= this._chat.length) continue;
      const msg = this._chat[idx];
      const text = (msg && (msg.mes || msg.content)) || "";
      if (!text) continue;

      const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "gi");
      let match;
      while ((match = regex.exec(text)) !== null) {
        if (match[1].trim()) {
          results.push({ turnNum, content: match[1].trim() });
        }
      }
    }

    return results;
  }

  _extractTurnHistoryFromChat(chat) {
    if (!chat || chat.length === 0) {
      console.log("[NA:extract] chat 为空或无元素");
      return { turns: [] };
    }

    console.log("[NA:extract] chat 消息总数:", chat.length);

    const turns = [];
    let foundFirstUser = false;
    let pendingUserInput = null;
    let nextTurn = 1;
    let msgIdx = 0;

    for (const msg of chat) {
      msgIdx++;
      const hasMes = msg && typeof msg.mes === "string" && msg.mes.length > 0;
      const hasContent = msg && typeof msg.content === "string" && msg.content.length > 0;
      const rawRole = msg && msg.role;
      const rawIsUser = msg && msg.is_user;

      console.log(`[NA:extract] [${msgIdx}/${chat.length}] role=${rawRole} is_user=${rawIsUser} hasMes=${hasMes}(len=${msg?.mes?.length ?? 0}) hasContent=${hasContent}(len=${msg?.content?.length ?? 0})`);

      const text = (msg && (msg.mes || msg.content)) || "";
      if (!text) {
        console.log(`[NA:extract] [${msgIdx}] 跳过: 既无 mes 也无 content`);
        continue;
      }
      const isUser = (msg && msg.is_user === true) || (msg && msg.role === "user");

      if (isUser) {
        foundFirstUser = true;
        pendingUserInput = text;
        console.log(`[NA:extract] [${msgIdx}] 识别为用户消息, pendingUserInput 长度: ${text.length}`);
      } else {
        if (!foundFirstUser) {
          const contextMatch = text.match(/<context>([\s\S]*?)<\/context>/);
          if (contextMatch) {
            const cleaned = this._cleanContextContent(contextMatch[1]);
            console.log(`[NA:extract] [${msgIdx}] 首轮前消息中匹配到<context>, 原始长度: ${contextMatch[1].length}, 清理后长度: ${cleaned.length}`);
            if (cleaned) {
              turns.push({ userInput: null, narrativeText: cleaned, turnNum: 0, chatIndex: msgIdx - 1 });
              console.log(`[NA:extract] turn0 已创建, narrativeText 长度: ${cleaned.length}, 预览: ${cleaned.substring(0, 100)}`);
            } else {
              console.log(`[NA:extract] [${msgIdx}] <context> 清理后为空, 跳过`);
            }
          } else {
            console.log(`[NA:extract] [${msgIdx}] 首轮前非用户消息无<context>, 跳过 (role=${rawRole})`);
          }
          continue;
        }

        const contextMatch = text.match(/<context>([\s\S]*?)<\/context>/);
        const narrativeText = contextMatch
          ? this._cleanContextContent(contextMatch[1])
          : text;

        if (narrativeText.trim()) {
          turns.push({
            userInput: pendingUserInput || "",
            narrativeText: narrativeText.trim(),
            chatIndex: msgIdx - 1,
          });
          console.log(`[NA:extract] [${msgIdx}] 创建对话轮次, turnNum=${nextTurn}, userInput长度=${(pendingUserInput || "").length}, narrative长度=${narrativeText.trim().length}`);
        }
        pendingUserInput = null;
      }
    }

    const turn0 = turns.find(t => t.turnNum === 0);
    console.log(`[NA:extract] 提取完成: 总轮次=${turns.length}, turn0存在=${!!turn0}, turn0 narrative长度=${turn0 ? turn0.narrativeText.length : "N/A"}, turn0预览=${turn0 ? turn0.narrativeText.substring(0, 80) : "N/A"}`);

    return {
      turns: turns.map(t => {
        if (t.turnNum !== undefined) return t;
        const num = nextTurn++;
        return { ...t, turnNum: num };
      }),
    };
  }
}
