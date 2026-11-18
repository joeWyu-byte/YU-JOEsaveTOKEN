// Original ContextRouter data flow retained, excluding worldbook/tools/RPG state.
export class ContextRouter {
  constructor(deps) { Object.assign(this, deps); }
  async buildPlanningContext(userInput, recentTurns, presetContext, storySummaries) {
    return {
      systemEntries:[await this.characterReader.getChatInfo()], beforeCharEntries:[], selectiveEntries:[],
      userPersona:this.userPersonaReader.getPersonaInfo(), storySummaries, recentTurns, userInput,
      presetContext:presetContext?.planningContext || '',
      presetMessages:presetContext?.messages,
    };
  }
  async buildWritingContext(writingGuide, userInput, recentNarratives, preset, textRecall = null) {
    return {
      userPersona:this.userPersonaReader.getPersonaInfo(), writingGuide, recentNarratives,
      systemEntries:[await this.characterReader.getChatInfo()], beforeCharEntries:[], selectiveEntries:[],
      writingSystemPreset:preset?.writingSystemContext || '', writingUserPreset:preset?.writingUserContext || '',
      presetMessages:preset?.messages,
      userInput, textRecall, toolResultsText:'',
    };
  }
  buildMergedAnalysisContext(narrativeText, userInput, turnId) { return { turnId, userInput, narrativeText }; }
}
