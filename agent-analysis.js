import { callLLM } from "./llm.js";
import { parseMergedOutput } from "./parser.js";
import { MERGED_ANALYSIS_SYSTEM } from "./constants.js";

export async function runMergedAnalysisAgent(ctx) {
  let systemContent = MERGED_ANALYSIS_SYSTEM;

  const roundNum = ctx.turnId ? parseInt(String(ctx.turnId).replace(/^turn_/, ""), 10) : null;
  let userContent = roundNum != null ? `【当前轮次：第${roundNum}轮（摘要条目必须使用此编号）】\n\n` : "";
  userContent += `<user_input>\n${ctx.userInput}\n</user_input>\n\n`;
  userContent += `<narrative_output>\n${ctx.narrativeText}\n</narrative_output>\n\n`;
  userContent += "请输出分析结果。";

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  return parseMergedOutput(await callLLM(messages, { label: "merged-analysis" }));
}

