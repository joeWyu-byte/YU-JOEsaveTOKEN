import { bounded } from './lifecycle.js';
import { contentKey, getConversationId, getSTContext } from './utils.js';

const PREFIX = 'save-na:unsaved:';
const clone = value => JSON.parse(JSON.stringify(value));

// Native saveChat has no public AbortSignal. Keep native writes ordered after a timeout,
// while releasing the generation UI and retaining a recoverable local snapshot.
export class ChatPersistence {
  constructor() { this.tails = new Map(); this.recovery = new Map(); }
  capture(ctx, key) {
    const snapshot = { schema:1, conversation:key, createdAt:new Date().toISOString(),
      header:{ user_name:'unused', character_name:'unused', chat_metadata:clone(ctx.chatMetadata || {}) },
      chat:clone(ctx.chat || []) };
    snapshot.hash = contentKey(JSON.stringify(snapshot.chat));
    this.recovery.set(key, snapshot);
    snapshot.recoveryStorage = 'memory';
    try {
      if (typeof localStorage !== 'undefined') {
        snapshot.recoveryStorage = 'local';
        localStorage.setItem(PREFIX + key, JSON.stringify(snapshot));
      }
    } catch { snapshot.recoveryStorage = 'memory'; /* Keep the complete snapshot. */ }
    return snapshot;
  }
  get(key = getConversationId()) {
    if (this.recovery.has(key)) return this.recovery.get(key);
    try { return JSON.parse(localStorage.getItem(PREFIX + key) || 'null'); } catch { return null; }
  }
  async save(ctx, key, { timeoutMs = 10000, signal, stage = 'chat-save', records = [], onUpdate = () => {} } = {}) {
    const snapshot = this.capture(ctx, key);
    const record = { stage, status:'pending', startedAt:Date.now(), recoveryStorage:snapshot.recoveryStorage };
    records.push(record); onUpdate();
    const previous = this.tails.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      if (getConversationId() !== key || getSTContext()?.chat !== ctx.chat) {
        throw Object.assign(new Error('聊天已切换，保留未保存备份'), {code:'save-deferred'});
      }
      // Capture the latest version at dispatch, not an older queued message.
      const sent = this.capture(ctx, key);
      if (typeof ctx.saveChat!=='function')throw new Error('酒馆缺少聊天保存接口');
      record.method='native-save-and-verify';
      // Keep ST's own save mutex; direct parallel writes can race a streaming Relay save.
      const ack=await ctx.saveChat();
      record.confirmed=ack===true || ack?.ok===true;
      const character=ctx.characters?.[ctx.characterId];
      if(!record.confirmed && typeof fetch==='function' && typeof ctx.getRequestHeaders==='function' && character?.avatar && ctx.chatId) {
        // saveChatConditional may swallow an error or time out waiting for its mutex.
        const response=await fetch('/api/chats/get',{method:'POST',cache:'no-cache',headers:ctx.getRequestHeaders(),
          body:JSON.stringify({ch_name:character.name,file_name:ctx.chatId,avatar_url:character.avatar})});
        const saved=await response.json();
        record.confirmed=response.ok && Array.isArray(saved) && contentKey(JSON.stringify(saved.slice(1)))===sent.hash;
      }
      if(!record.confirmed){record.status='unconfirmed';record.durationMs=Date.now()-record.startedAt;onUpdate();return;}
      const latest = this.recovery.get(key);
      if (latest?.hash === sent.hash && contentKey(JSON.stringify(ctx.chat || [])) === sent.hash) {
        this.recovery.delete(key);
        try { localStorage.removeItem(PREFIX + key); } catch { /* Optional local storage. */ }
      }
      record.status = record.status === 'pending' ? 'saved' : 'saved-late';
      record.finishedAt = Date.now(); record.durationMs = record.finishedAt - record.startedAt;
      onUpdate();
    });
    operation.catch(error=>{if(record.status!=='pending'){record.status='failed-late';record.code=error.code||'save-failed';onUpdate();}});
    const tail = operation.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    try { await bounded(() => operation, {stage, timeoutMs, signal}); }
    catch (error) {
      record.status = error.code === 'stage-timeout' ? 'timed-out' : error.code === 'cancelled' ? 'cancelled' : 'failed';
      record.code = error.code || 'save-failed'; record.durationMs = Date.now() - record.startedAt;
      onUpdate();
    }
    return record;
  }
  exportText(key = getConversationId()) {
    const snapshot = this.get(key);
    return snapshot ? [snapshot.header, ...snapshot.chat].map(item => JSON.stringify(item)).join('\n') + '\n' : null;
  }
}
