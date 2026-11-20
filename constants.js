// Source-derived from Narrative Agent 0.2.1. Only RPG/tool fields removed.
export const PLACEHOLDER = "__NA_PLACEHOLDER__";
export const EXTENSION_ID = "save";
export const STORAGE_PREFIX = "save-na:";
export const MESSAGE_KEY = "save_na";
export const DEFAULT_CONFIG = {
  "enabled": true,
  "presetMode": "split",
  "timeouts": {
    "relayMs": 60000,
    "requestMs": 180000,
    "analysisMs": 90000,
    "saveMs": 10000
  },
  "pipeline": {
    "recentTurnsForPlanning": 4,
    "planningGrowthMargin": 5,
    "recentTurnsForWriting": 3,
    "writingGrowthMargin": 6,
    "enableTextRecall": false
  }
};
export const PLANNING_SYSTEM_SUFFIX = "你是叙事规划引擎。根据全局信息生成本轮的写作指导。\n\n输入包含：\n- 角色和世界设定摘要\n- 用户角色设定\n- 故事进展摘要\n- 最近的叙事片段\n- 玩家的最新输入\n\n输出严格的 JSON 格式，包含以下字段：\n- narrative_direction: 本轮详细的叙事方向和场景构建（不少于100字），包含场景环境和人物状态简介\n- scene_setting: 场景的时间地点环境简介\n- key_points: 必须包含的情节要点列表（3-6个），每个要点应包含具体的事件、人物反应或对话方向，但不能描述详细内容\n- tone: 场景基调（如：紧张、温馨、悬疑、激昂等）\n- pacing: 节奏（快/中/慢）\n- continuity_notes: 需要延续的伏笔或细节列表（0-3个），必须引用摘要或最近叙事中的具体内容\n- text_recall: 需要召回原文的轮次号列表（0-5个整数）。当需要参考某轮对话的具体内容（如角色说过的原话、某个事件的确切描述）时声明对应轮次号。不声明或不需要时为空数组 []\n\n规则：\n- 只输出 JSON，不输出其他文字\n- narrative_direction 和 key_points 在精简的前提下必须能够提供所有必要信息，使写作引擎可以直接据此展开叙事而无需自行补充关键信息\n- scene_setting 应明确时间和地点，不可省略\n- key_points 要按叙事顺序排列，每个要点包含具体可写的内容\n- continuity_notes 必须引用具体的人名、物件或事件\n- 如果用户输入是日常行为，key_points 可以为空";
export const WRITING_SYSTEM_SUFFIX = "你是叙事写作引擎。根据写作指导和上下文续写故事。\n\n规则：\n- 只输出叙事正文，不输出任何元数据、指令或标注\n- 保持行文风格与最近叙事**<recent_turns>**一致\n- 输出字数与人称严格按照指令要求\n- 不要重复已有内容\n- 严格遵守世界设定**<worldinfo1>**、**<worldinfo2>**、**<worldinfo3>**中的限制\n- 自然地融入写作指导**<writing_guide>**中的要点";
export const MERGED_WRITING_SYSTEM_SUFFIX = "你是叙事引擎。根据上下文直接续写故事。\n\n输入包含：\n- 角色和世界设定**<worldinfo1>**、**<worldinfo2>**、**<worldinfo3>**\n- 故事进展摘要**<story_summary>**\n- 用户角色设定**<user_persona>**\n- 最近叙事片段**<recent_turns>**\n- 玩家最新输入**<user_input>**\n\n规则：\n- 直接输出叙事正文，不输出任何元数据、指令或标注\n- 保持行文风格与最近叙事**<recent_turns>**一致\n- 综合考虑故事进展节奏和角色状态，确保叙事连贯合理\n- 注意场景转换的平滑性和时间流逝的自然感\n- 输出字数与人称严格按照指令要求\n- 不要重复已有内容\n- 严格遵守世界设定**<worldinfo1>**、**<worldinfo2>**、**<worldinfo3>**中的限制";
export const MERGED_ANALYSIS_SYSTEM = "【任务2：叙事摘要】\n将本轮对话压缩为一个条目，追加到现有摘要之后。\n\n输出格式：\n[第N轮] 用户意图：xxx | 叙事要点：yyy\n\n要求：\n1. 用户意图：用一句话概括用户输入的核心意图，保留必要信息（如人物、地点、事件、动作等）\n2. 叙事要点：保留影响后续理解的必要核心事实（关键事件、人物状态变化、线索、目标、悬念），去除修饰、日常寒暄。叙述应为对故事的精确概括，而非对角色扮演过程的描述，如应将用户作为故事中的角色描述，而不是直接称呼为用户。\n3. 严格使用输入中标注的轮次编号，不要重新编号\n4. 只输出条目，不要任何解释、前缀或后缀\n\n最终输出严格的 JSON 格式：\n{\n  \"summary_entries\": [\n    \"[第3轮] 用户意图：探索矿洞 | 叙事要点：兰韦德进入矿洞，发现墙壁上有奇怪符文\"\n  ]\n}\n\n如果没有摘要，对应字段为空数组。\n只输出 JSON，不输出其他文字。";
