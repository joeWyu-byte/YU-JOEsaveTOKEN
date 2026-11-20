import { callLLM } from "./llm.js";
import { WRITING_SYSTEM_SUFFIX, MERGED_WRITING_SYSTEM_SUFFIX } from "./constants.js";

export async function runWritingAgent(ctx) {
  const guide = ctx.writingGuide;

  let systemContent = "";

  if (ctx.writingSystemPreset) {
    systemContent += ctx.writingSystemPreset;
  }

  if (ctx.systemEntries && ctx.systemEntries.length > 0) {
    if (systemContent) systemContent += "\n\n";
    systemContent += "<worldinfo1>\n" + ctx.systemEntries.join("\n\n") + "\n</worldinfo1>";
  }

  if (systemContent) systemContent += "\n\n";
  systemContent += WRITING_SYSTEM_SUFFIX;

  const formatTurn = (t) => {
    if (!t.user) {
      return `[\u8f6e${t.turnNum}] AI: ${t.assistant}`;
    }
    return `[\u8f6e${t.turnNum}] \u7528\u6237: ${t.user}\n[\u8f6e${t.turnNum}] AI: ${t.assistant}`;
  };
  const recentText = ctx.recentNarratives.map(formatTurn).join("\n\n");

  let userContent = "";

  if (ctx.writingUserPreset) {
    userContent += "<user_preset>\n" + ctx.writingUserPreset + "\n</user_preset>";
  }

  if (ctx.beforeCharEntries && ctx.beforeCharEntries.length > 0) {
    if (userContent) userContent += "\n\n";
    userContent += "<worldinfo2>\n" + ctx.beforeCharEntries.join("\n\n") + "\n</worldinfo2>";
  }

  if (ctx.userPersona) {
    if (userContent) userContent += "\n\n";
    userContent += `<user_persona>\n${ctx.userPersona}\n</user_persona>`;
  }

  if (userContent) userContent += "\n\n";
  userContent += `<recent_turns>\n${recentText}\n</recent_turns>`;

    if (ctx.selectiveEntries && ctx.selectiveEntries.length > 0) {
    userContent += "\n\n<worldinfo3>\n" + ctx.selectiveEntries.join("\n\n") + "\n</worldinfo3>";
  }

  if (ctx.textRecall) {
    userContent += "\n\n<text_recall>\n" + ctx.textRecall + "\n</text_recall>";
  }

  let guideBlock = "<writing_guide>\n\u53d9\u4e8b\u65b9\u5411\uff1a" + (guide.narrative_direction || "\uff08\u65e0\u7279\u5b9a\u65b9\u5411\uff0c\u5ef6\u7eed\u5f53\u524d\u53d9\u4e8b\uff09");
  if (guide.scene_setting) {
    guideBlock += "\n\u573a\u666f\u8bbe\u7f6e\uff1a" + guide.scene_setting;
  }
  guideBlock += "\n\u8981\u70b9\uff1a" + (guide.key_points.length > 0 ? guide.key_points.join("\uff1b") : "\u65e0\u7279\u5b9a\u8981\u70b9");
  guideBlock += "\n\u57fa\u8c03\uff1a" + guide.tone + "\uff0c\u8282\u594f\uff1a" + guide.pacing;
  guideBlock += "\n\u5ef6\u7eed\u7ec6\u8282\uff1a" + (guide.continuity_notes.length > 0 ? guide.continuity_notes.join("\uff1b") : "\u65e0");
  guideBlock += "\n</writing_guide>";
  userContent += "\n\n" + guideBlock;

  userContent += `\n\n<user_input>\n${ctx.userInput}\n</user_input>`;

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  const raw = await callLLM(messages, { label: "writing" });
  return raw.trim();
}

export async function runMergedWritingAgent(ctx) {
  let systemContent = "";

  if (ctx.presetContext) {
    systemContent += ctx.presetContext;
  }

  if (ctx.systemEntries && ctx.systemEntries.length > 0) {
    if (systemContent) systemContent += "\n\n";
    systemContent += "<worldinfo1>\n" + ctx.systemEntries.join("\n\n") + "\n</worldinfo1>";
  }

  if (systemContent) systemContent += "\n\n";
  systemContent += MERGED_WRITING_SYSTEM_SUFFIX;

  const formatTurn = (t) => {
    if (!t.user) {
      return `[\u8f6e${t.turnNum}] AI: ${t.assistant}`;
    }
    return `[\u8f6e${t.turnNum}] \u7528\u6237: ${t.user}\n[\u8f6e${t.turnNum}] AI: ${t.assistant}`;
  };
  const recentText = ctx.recentTurns.map(formatTurn).join("\n\n");

  let userContent = "";

  if (ctx.writingUserPreset) {
    userContent += "<user_preset>\n" + ctx.writingUserPreset + "\n</user_preset>";
  }

  if (ctx.beforeCharEntries && ctx.beforeCharEntries.length > 0) {
    if (userContent) userContent += "\n\n";
    userContent += "<worldinfo2>\n" + ctx.beforeCharEntries.join("\n\n") + "\n</worldinfo2>";
  }

  if (ctx.userPersona) {
    if (userContent) userContent += "\n\n";
    userContent += `<user_persona>\n${ctx.userPersona}\n</user_persona>`;
  }

  if (userContent) userContent += "\n\n";
  userContent += `<story_summary>\n${ctx.storySummaries}\n</story_summary>`;

  userContent += `\n\n<recent_turns>\n${recentText}\n</recent_turns>`;

  if (ctx.selectiveEntries && ctx.selectiveEntries.length > 0) {
    userContent += "\n\n<worldinfo3>\n" + ctx.selectiveEntries.join("\n\n") + "\n</worldinfo3>";
  }

  if (ctx.textRecall) {
    userContent += "\n\n<text_recall>\n" + ctx.textRecall + "\n</text_recall>";
  }


  userContent += `\n\n<user_input>\n${ctx.userInput}\n</user_input>`;

  const messages = [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];

  const raw = await callLLM(messages, { label: "merged-writing" });
  return raw.trim();
}