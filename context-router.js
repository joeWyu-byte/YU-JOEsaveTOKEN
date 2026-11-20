export class ContextRouter {
  constructor(deps) {
    this.summaryStore = deps.summaryStore;
    this.characterReader = deps.characterReader;
    this.userPersonaReader = deps.userPersonaReader;
  }

  async buildPlanningContext(userInput, recentTurns, systemEntries, beforeCharEntries, selectiveEntries, stateSummary, presetContext, planningTools) {
    return {
      systemEntries: systemEntries || [],
      beforeCharEntries: beforeCharEntries || [],
      selectiveEntries: selectiveEntries || [],
      userPersona: this.userPersonaReader.getPersonaInfo(),
      storySummaries: this.summaryStore.getAllSummaries(),
      recentTurns,
      userInput,
      presetContext: presetContext?.planningContext || "",
    };
  }

  async buildWritingContext(writingGuide, userInput, recentNarratives, systemEntries, selectiveEntries, writingSystemPreset, writingUserPreset, toolResultsText, beforeCharEntries, textRecall = null) {
    return {
      userPersona: this.userPersonaReader.getPersonaInfo(),
      writingGuide,
      recentNarratives,
      systemEntries: systemEntries || [],
      selectiveEntries: selectiveEntries || [],
      writingSystemPreset: writingSystemPreset || "",
      writingUserPreset: writingUserPreset || "",
      userInput,
      toolResultsText: toolResultsText || "",
      beforeCharEntries: beforeCharEntries || [],
      textRecall: textRecall || null,
    };
  }

  buildMergedAnalysisContext(narrativeText, userInput, turnId, stateSummary) {
    return {
      turnId: turnId || "",
      userInput,
      narrativeText,
    };
  }
}