import fs from 'node:fs';
import path from 'node:path';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface TopicConversation {
  label: string;
  messages: ChatMessage[];
}

const MAX_MESSAGES_PER_TOPIC = 40;
const FLUSH_DELAY_MS = 500;

export class ConversationStore {
  private dir: string;
  private cache = new Map<string, TopicConversation>();
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'conversations');
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  getMessages(label: string): ChatMessage[] {
    const data = this.getOrLoad(label);
    return data.messages;
  }

  appendMessage(label: string, msg: ChatMessage): void {
    const data = this.getOrLoad(label);
    data.messages.push(msg);
    if (data.messages.length > MAX_MESSAGES_PER_TOPIC) {
      data.messages = data.messages.slice(-MAX_MESSAGES_PER_TOPIC);
    }
    this.dirty.add(label);
    this.scheduleFlush();
  }

  clear(label: string): void {
    this.cache.delete(label);
    this.dirty.delete(label);
    const filePath = this.filePath(label);
    try { fs.unlinkSync(filePath); } catch {}
  }

  flushSync(): void {
    for (const label of this.dirty) {
      const data = this.cache.get(label);
      if (data) this.writeToDisk(label, data);
    }
    this.dirty.clear();
  }

  private getOrLoad(label: string): TopicConversation {
    let data = this.cache.get(label);
    if (!data) {
      data = this.readFromDisk(label) ?? { label, messages: [] };
      this.cache.set(label, data);
    }
    return data;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, FLUSH_DELAY_MS);
  }

  private filePath(label: string): string {
    const safe = label.replace(/[^a-z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  private readFromDisk(label: string): TopicConversation | null {
    try {
      const raw = fs.readFileSync(this.filePath(label), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private writeToDisk(label: string, data: TopicConversation): void {
    try {
      const tmp = this.filePath(label) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.filePath(label));
    } catch {}
  }
}
