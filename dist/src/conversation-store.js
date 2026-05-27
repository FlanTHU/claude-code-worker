import fs from 'node:fs';
import path from 'node:path';
const MAX_MESSAGES_PER_TOPIC = 40;
const FLUSH_DELAY_MS = 500;
export class ConversationStore {
    dir;
    cache = new Map();
    dirty = new Set();
    flushTimer = null;
    constructor(stateDir) {
        this.dir = path.join(stateDir, 'conversations');
        if (!fs.existsSync(this.dir)) {
            fs.mkdirSync(this.dir, { recursive: true });
        }
    }
    getMessages(label) {
        const data = this.getOrLoad(label);
        return data.messages;
    }
    appendMessage(label, msg) {
        const data = this.getOrLoad(label);
        data.messages.push(msg);
        if (data.messages.length > MAX_MESSAGES_PER_TOPIC) {
            data.messages = data.messages.slice(-MAX_MESSAGES_PER_TOPIC);
        }
        this.dirty.add(label);
        this.scheduleFlush();
    }
    clear(label) {
        this.cache.delete(label);
        this.dirty.delete(label);
        const filePath = this.filePath(label);
        try {
            fs.unlinkSync(filePath);
        }
        catch { }
    }
    flushSync() {
        for (const label of this.dirty) {
            const data = this.cache.get(label);
            if (data)
                this.writeToDisk(label, data);
        }
        this.dirty.clear();
    }
    getOrLoad(label) {
        let data = this.cache.get(label);
        if (!data) {
            data = this.readFromDisk(label) ?? { label, messages: [] };
            this.cache.set(label, data);
        }
        return data;
    }
    scheduleFlush() {
        if (this.flushTimer)
            return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushSync();
        }, FLUSH_DELAY_MS);
    }
    filePath(label) {
        const safe = label.replace(/[^a-z0-9_-]/g, '_');
        return path.join(this.dir, `${safe}.json`);
    }
    readFromDisk(label) {
        try {
            const raw = fs.readFileSync(this.filePath(label), 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    writeToDisk(label, data) {
        try {
            const tmp = this.filePath(label) + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
            fs.renameSync(tmp, this.filePath(label));
        }
        catch { }
    }
}
