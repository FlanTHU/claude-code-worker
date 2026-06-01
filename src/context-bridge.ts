import * as fs from 'fs';
import * as path from 'path';
import type { ForkContext, ContextBridgeData } from './types.js';

const MAX_ACTIVE_FORKS = 5;

export class ContextBridge {
  private filePath: string;
  private data: ContextBridgeData;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'context-bridge.json');
    this.data = this.load();
    this.cleanup();
  }

  private load(): ContextBridgeData {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { activeForks: [] };
    }
  }

  private save(): void {
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  createFork(parentLabel: string, childLabel: string, contextSummary: string, mergeWindowMinutes: number): ForkContext {
    const fork: ForkContext = {
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

  checkMerge(currentTopicLabel: string, switchToLabel: string): ForkContext | null {
    const now = Date.now();
    return this.data.activeForks.find(f =>
      !f.merged &&
      f.childTopicLabel === currentTopicLabel &&
      f.parentTopicLabel === switchToLabel &&
      now < f.mergeWindowExpiresAt
    ) ?? null;
  }

  markMerged(fork: ForkContext): void {
    fork.merged = true;
    this.save();
  }

  getContextForChild(childLabel: string): string | null {
    const fork = this.data.activeForks.find(f =>
      !f.merged && f.childTopicLabel === childLabel
    );
    return fork?.contextSummary ?? null;
  }

  cleanup(): void {
    const now = Date.now();
    const before = this.data.activeForks.length;
    this.data.activeForks = this.data.activeForks.filter(f =>
      !f.merged && now < f.mergeWindowExpiresAt + 3600_000
    );
    if (this.data.activeForks.length !== before) {
      this.save();
    }
  }
}
