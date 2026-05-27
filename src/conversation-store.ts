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

export class ConversationStore {
  private dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'conversations');
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  getMessages(label: string): ChatMessage[] {
    const data = this.load(label);
    return data?.messages ?? [];
  }

  appendMessage(label: string, msg: ChatMessage): void {
    const data = this.load(label) ?? { label, messages: [] };
    data.messages.push(msg);
    if (data.messages.length > MAX_MESSAGES_PER_TOPIC) {
      data.messages = data.messages.slice(-MAX_MESSAGES_PER_TOPIC);
    }
    this.save(label, data);
  }

  clear(label: string): void {
    const filePath = this.filePath(label);
    try { fs.unlinkSync(filePath); } catch {}
  }

  private filePath(label: string): string {
    const safe = label.replace(/[^a-z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  private load(label: string): TopicConversation | null {
    try {
      const raw = fs.readFileSync(this.filePath(label), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private save(label: string, data: TopicConversation): void {
    const tmp = this.filePath(label) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath(label));
  }
}
