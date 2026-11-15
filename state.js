// Derived from Narrative Agent 0.2.1 (MIT). RPG StateManager removed.
export class SummaryStore {
  constructor() { this._entries = []; }

  getCurrentSummary() { return this._entries.join("\n"); }
  getAllSummaries() { return this._entries.length > 0 ? this._entries.join("\n") : "\uff08\u5c1a\u65e0\u6545\u4e8b\u6458\u8981\uff09"; }
  getEntryCount() { return this._entries.length; }

  appendEntries(newEntries) {
    for (const entry of newEntries) {
      this._entries.push(entry);
    }
    return { addedCount: newEntries.length };
  }

  reset(state = null) {
    if (state && state._entries) {
      this._entries = [...state._entries];
    } else {
      this._entries = [];
    }
  }

  toDict() { return { entries: this._entries }; }

  static fromDict(data) {
    const store = new SummaryStore();
    if (!data) return store;
    if (Array.isArray(data.entries)) {
      store._entries = data.entries;
    } else if (typeof data.summary === "string" && data.summary.length > 0) {
      store._entries = data.summary.split("\n");
    }
    return store;
  }
}