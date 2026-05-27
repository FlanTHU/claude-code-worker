import fs from 'node:fs';
import path from 'node:path';
const MAX_MESSAGES_PER_TOPIC = 40;
export class ConversationStore {
    dir;
    constructor(stateDir) {
        this.dir = path.join(stateDir, 'conversations');
        if (!fs.existsSync(this.dir)) {
            fs.mkdirSync(this.dir, { recursive: true });
        }
    }
    getMessages(label) {
        const data = this.load(label);
        return data?.messages ?? [];
    }
    appendMessage(label, msg) {
        const data = this.load(label) ?? { label, messages: [] };
        data.messages.push(msg);
        if (data.messages.length > MAX_MESSAGES_PER_TOPIC) {
            data.messages = data.messages.slice(-MAX_MESSAGES_PER_TOPIC);
        }
        this.save(label, data);
    }
    clear(label) {
        const filePath = this.filePath(label);
        try {
            fs.unlinkSync(filePath);
        }
        catch { }
    }
    filePath(label) {
        const safe = label.replace(/[^a-z0-9_-]/g, '_');
        return path.join(this.dir, `${safe}.json`);
    }
    load(label) {
        try {
            const raw = fs.readFileSync(this.filePath(label), 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    save(label, data) {
        const tmp = this.filePath(label) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, this.filePath(label));
    }
}
