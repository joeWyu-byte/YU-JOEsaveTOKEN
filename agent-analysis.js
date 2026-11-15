// Derived from runMergedAnalysisAgent in narrative-agent 0.2.1; RPG extraction removed.
import { callLLM } from './llm.js';
import { parseMergedOutput } from './parser.js';
import { MERGED_ANALYSIS_SYSTEM } from './constants.js';
export async function runMergedAnalysisAgent(ctx) {
  const roundNum = Number(String(ctx.turnId).replace(/^turn_/, ''));
  const userContent = `【当前轮次：第${roundNum}轮（摘要条目必须使用此编号）】\n\n`
    + `<user_input>\n${ctx.userInput}\n</user_input>\n\n`
    + `<narrative_output>\n${ctx.narrativeText}\n</narrative_output>\n\n请输出分析结果。`;
  return parseMergedOutput(await callLLM([
    { role:'system', content:MERGED_ANALYSIS_SYSTEM }, { role:'user', content:userContent },
  ], { label:'merged-analysis' }));
}
// Adoption of existing ST chats only; the regular pipeline still summarizes EVERY turn.
export async function runHistoryAnalysisAgent(turns) {
  return parseMergedOutput(await callLLM([
    { role:'system', content:MERGED_ANALYSIS_SYSTEM },
    { role:'user', content:turns.map(t => `【第${t.turnNum}轮】\n<user_input>\n${t.userInput}\n</user_input>\n<narrative_output>\n${t.narrativeText}\n</narrative_output>`).join('\n\n') },
  ], { label:'history-analysis' }));
}
