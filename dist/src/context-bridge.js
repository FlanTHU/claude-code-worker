import * as fs from 'fs';
import * as path from 'path';
const MAX_ACTIVE_FORKS = 5;
export class ContextBridge {
    filePath;
    data;
    constructor(stateDir) {
        this.filePath = path.join(stateDir, 'context-bridge.json');
        this.data = this.load();
        this.cleanup();
    }
    load() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            return { activeForks: [] };
        }
    }
    save() {
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.filePath);
    }
    createFork(parentLabel, childLabel, contextSummary, mergeWindowMinutes) {
        const fork = {
            parentTopicLabel: parentLabel,
            childTopicLabel: childLabel,
            forkedAt: Date.now(),
            contextSummary,
            mergeWindowExpiresAt: Date.now() + mergeWindowMinutes * 60 * 1000,
            merged: false,
        };
        this.data.activeForks.push(fork);
        if (this.data.activeForks.length > MAX_ACTIVE_FORKS) {
            this.data.activeForks = this.data.activeForks.slice(-MAX_ACTIVE_FORKS);
        }
        this.save();
        return fork;
    }
    checkMerge(currentTopicLabel, switchToLabel) {
        const now = Date.now();
        return this.data.activeForks.find(f => !f.merged &&
            f.childTopicLabel === currentTopicLabel &&
            f.parentTopicLabel === switchToLabel &&
            now < f.mergeWindowExpiresAt) ?? null;
    }
    markMerged(fork) {
        fork.merged = true;
        this.save();
    }
    getContextForChild(childLabel) {
        const fork = this.data.activeForks.find(f => !f.merged && f.childTopicLabel === childLabel);
        return fork?.contextSummary ?? null;
    }
    cleanup() {
        const now = Date.now();
        const before = this.data.activeForks.length;
        this.data.activeForks = this.data.activeForks.filter(f => !f.merged && now < f.mergeWindowExpiresAt + 3600_000);
        if (this.data.activeForks.length !== before) {
            this.save();
        }
    }
}
