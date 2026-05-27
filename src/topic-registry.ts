/**
 * Topic Registry — manages topic lifecycle and persistence.
 *
 * Stores topic entries in a JSON file under the OpenClaw state directory.
 * Each topic maps to an isolated session key (agent:main:topic:{label}).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TopicEntry, TopicRegistryData, TopicStatus } from './types.js';

const REGISTRY_FILE = 'topic-sessions.json';

export class TopicRegistry {
  private data: TopicRegistryData;
  private filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, REGISTRY_FILE);
    this.data = this.load();
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  getActive(): TopicEntry | null {
    if (!this.data.activeSessionKey) return null;
    return Object.values(this.data.topics).find(
      t => t.sessionKey === this.data.activeSessionKey && t.status === 'active'
    ) ?? null;
  }

  get(label: string): TopicEntry | undefined {
    return this.data.topics[label];
  }

  getAll(): TopicEntry[] {
    return Object.values(this.data.topics).filter(t => t.status !== 'ended');
  }

  getActiveTopics(): TopicEntry[] {
    return Object.values(this.data.topics).filter(t => t.status === 'active');
  }

  getInactiveTopics(): TopicEntry[] {
    return Object.values(this.data.topics).filter(t => t.status === 'inactive');
  }

  // ---------------------------------------------------------------------------
  // Mutate
  // ---------------------------------------------------------------------------

  getOrCreate(label: string, displayName?: string): TopicEntry {
    const normalized = this.normalizeLabel(label);
    let entry = this.data.topics[normalized];
    if (!entry) {
      entry = {
        label: normalized,
        displayName: displayName ?? normalized,
        sessionKey: `agent:main:topic:${normalized}`,
        status: 'active',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        messageCount: 0,
        keywords: [],
      };
      this.data.topics[normalized] = entry;
    } else if (displayName && entry.displayName === entry.label) {
      entry.displayName = displayName;
    }
    entry.lastActiveAt = Date.now();
    entry.messageCount++;
    this.data.activeSessionKey = entry.sessionKey;
    this.save();
    return entry;
  }

  setActive(label: string): void {
    const normalized = this.normalizeLabel(label);
    const entry = this.data.topics[normalized];
    if (!entry) return;

    // Mark previous active as inactive
    const prev = this.getActive();
    if (prev && prev.label !== normalized) {
      prev.status = 'inactive';
    }

    entry.status = 'active';
    entry.lastActiveAt = Date.now();
    this.data.activeSessionKey = entry.sessionKey;
    this.save();
  }

  markInactive(label: string): void {
    const normalized = this.normalizeLabel(label);
    const entry = this.data.topics[normalized];
    if (!entry) return;
    entry.status = 'inactive';
    if (this.data.activeSessionKey === entry.sessionKey) {
      this.data.activeSessionKey = null;
    }
    this.save();
  }

  markEnded(label: string): void {
    const normalized = this.normalizeLabel(label);
    const entry = this.data.topics[normalized];
    if (!entry) return;
    entry.status = 'ended';
    if (this.data.activeSessionKey === entry.sessionKey) {
      this.data.activeSessionKey = null;
    }
    this.save();
  }

  learnKeywords(label: string, content: string): void {
    const normalized = this.normalizeLabel(label);
    const entry = this.data.topics[normalized];
    if (!entry) return;

    const words: string[] = [];

    // Extract English words (>= 3 chars)
    const engMatches = content.match(/[a-zA-Z]{3,}/g);
    if (engMatches) {
      words.push(...engMatches.map(w => w.toLowerCase()));
    }

    // Extract Chinese segments (2-4 char chunks as pseudo-keywords)
    const chnMatches = content.match(/[一-鿿]{2,}/g);
    if (chnMatches) {
      for (const seg of chnMatches) {
        if (seg.length <= 4) {
          words.push(seg);
        } else {
          // Chunk long Chinese sequences into 2-char bigrams
          for (let i = 0; i < seg.length - 1; i += 2) {
            words.push(seg.slice(i, i + 2));
          }
        }
      }
    }

    const newKeywords = words.filter(w => !entry.keywords.includes(w));
    entry.keywords.push(...newKeywords.slice(0, 8));

    if (entry.keywords.length > 50) {
      entry.keywords = entry.keywords.slice(-50);
    }
    this.save();
  }

  updateSummary(label: string, summary: string): void {
    const normalized = this.normalizeLabel(label);
    const entry = this.data.topics[normalized];
    if (!entry) return;
    entry.summary = summary.slice(0, 200);
    this.save();
  }

  /** Remove topics older than maxAgeMs. Returns count of pruned topics. */
  prune(maxAgeMs?: number): number {
    const cutoff = Date.now() - (maxAgeMs ?? 7 * 24 * 3600 * 1000);
    let pruned = 0;
    for (const [label, entry] of Object.entries(this.data.topics)) {
      if (entry.status !== 'active' && entry.lastActiveAt < cutoff) {
        delete this.data.topics[label];
        pruned++;
      }
    }
    if (pruned > 0) this.save();
    return pruned;
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  private normalizeLabel(label: string): string {
    return label
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff_-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'general';
  }

  private load(): TopicRegistryData {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.topics) {
        return parsed;
      }
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
    return { activeSessionKey: null, topics: {} };
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('[topic-router] Failed to save registry:', err);
    }
  }
}
