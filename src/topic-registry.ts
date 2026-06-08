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

export const STOPWORDS = new Set([
  // Chinese high-frequency function words that cause false matches
  '怎么', '什么', '这个', '那个', '为什么', '怎么样', '是什么',
  '这是', '那是', '可以', '不能', '已经', '还是', '或者',
  '如何', '哪个', '哪些', '这些', '那些', '一下', '一些',
  '但是', '因为', '所以', '如果', '虽然', '不过',
  // High-frequency place/time words: these recur across unrelated topics
  // (a weather, a sports, a travel question all mention 北京/晚上/本周), so using
  // them as topic keywords causes false cross-topic substring matches. They must
  // NOT decide topic membership. (Note: specific terms like 端午节 stay valid.)
  '北京', '上海', '广州', '深圳', '今天', '明天', '后天', '昨天',
  '本周', '这周', '上周', '下周', '周一', '周二', '周三', '周四',
  '周五', '周六', '周日', '周末', '早上', '上午', '中午', '下午',
  '晚上', '今晚', '现在', '目前', '最近', '适合',
  // English common words
  'this', 'that', 'what', 'which', 'have', 'been', 'with',
  'from', 'they', 'will', 'would', 'could', 'should',
  'about', 'there', 'their', 'some', 'other', 'than',
]);

/** Chinese characters that are common conjunctions/particles and should break segments.
 * Excludes chars that commonly appear in compound words (能→智能/功能, 不→不同). */
const CJK_BREAK_CHARS = new Set([
  '的', '了', '和', '与', '或', '在', '是', '有', '被', '把',
  '给', '让', '用', '对', '从', '到', '也', '都', '就', '才',
  '又', '再', '很', '太', '更', '最', '没', '要', '会',
  '得', '着', '过', '吗', '呢', '吧', '啊', '呀', '哦',
]);

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

  private reload(): void {
    this.data = this.load();
  }

  getActive(): TopicEntry | null {
    this.reload();
    if (!this.data.activeSessionKey) return null;
    return Object.values(this.data.topics).find(
      t => t.sessionKey === this.data.activeSessionKey && t.status === 'active'
    ) ?? null;
  }

  get(label: string): TopicEntry | undefined {
    this.reload();
    return this.data.topics[label];
  }

  findByDisplayName(query: string): TopicEntry | undefined {
    this.reload();
    const q = query.toLowerCase();
    const topics = Object.values(this.data.topics).filter(t => t.status !== 'ended');
    return topics.find(t => t.displayName.toLowerCase() === q)
      ?? topics.find(t => t.displayName.toLowerCase().includes(q));
  }

  getAll(): TopicEntry[] {
    this.reload();
    return Object.values(this.data.topics).filter(t => t.status !== 'ended');
  }

  getActiveTopics(): TopicEntry[] {
    this.reload();
    return Object.values(this.data.topics).filter(t => t.status === 'active');
  }

  getInactiveTopics(): TopicEntry[] {
    this.reload();
    return Object.values(this.data.topics).filter(t => t.status === 'inactive');
  }

  // ---------------------------------------------------------------------------
  // Mutate
  // ---------------------------------------------------------------------------

  /** Find an unused label derived from base (base, base-2, base-3, …). */
  private freshLabel(base: string): string {
    if (!this.data.topics[base]) return base;
    for (let i = 2; i < 10000; i++) {
      const candidate = `${base}-${i}`;
      if (!this.data.topics[candidate]) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  /**
   * Resolve a label to an entry that is safe to activate.
   * - No existing entry, or a non-ended entry → return it (create if absent).
   * - An *ended* entry → do NOT revive in place; create a fresh sibling
   *   (new label → new sessionKey) so the old gateway context stays detached.
   */
  private resolveActivatable(label: string, displayName?: string): TopicEntry {
    const normalized = this.normalizeLabel(label);
    const existing = this.data.topics[normalized];
    if (existing && existing.status !== 'ended') {
      if (displayName) existing.displayName = displayName;
      return existing;
    }
    const freshLabel = existing ? this.freshLabel(normalized) : normalized;
    const entry: TopicEntry = {
      label: freshLabel,
      displayName: displayName ?? existing?.displayName ?? freshLabel,
      sessionKey: `agent:main:topic:${freshLabel}`,
      status: 'active',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      messageCount: 0,
      keywords: [],
    };
    this.data.topics[freshLabel] = entry;
    return entry;
  }

  getOrCreate(label: string, displayName?: string): TopicEntry {
    const entry = this.resolveActivatable(label, displayName);
    entry.status = 'active';
    entry.lastActiveAt = Date.now();
    entry.messageCount++;
    this.data.activeSessionKey = entry.sessionKey;
    this.save();
    return entry;
  }

  /**
   * Activate an existing topic. Returns the activated entry, or undefined if
   * the label is unknown. If the target is ended, a fresh sibling is created
   * instead of reviving it (see resolveActivatable).
   */
  setActive(label: string): TopicEntry | undefined {
    const normalized = this.normalizeLabel(label);
    this.reload();
    const existing = this.data.topics[normalized];
    if (!existing) return undefined;

    const entry = existing.status === 'ended'
      ? this.resolveActivatable(normalized)
      : existing;

    // Mark ALL other active topics as inactive
    for (const topic of Object.values(this.data.topics)) {
      if (topic.label !== entry.label && topic.status === 'active') {
        topic.status = 'inactive';
      }
    }

    entry.status = 'active';
    entry.lastActiveAt = Date.now();
    this.data.activeSessionKey = entry.sessionKey;
    this.save();
    return entry;
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

  setKeywords(label: string, keywords: string[]): void {
    const normalized = this.normalizeLabel(label);
    this.reload();
    const entry = this.data.topics[normalized];
    if (!entry) return;

    const newKw = keywords.filter(k => !entry.keywords.includes(k));
    entry.keywords.push(...newKw);
    if (entry.keywords.length > 30) {
      entry.keywords = entry.keywords.slice(-30);
    }
    this.save();
  }

  learnKeywords(label: string, content: string): void {
    const normalized = this.normalizeLabel(label);
    const entry = this.data.topics[normalized];
    if (!entry) return;

    const words: string[] = [];

    // Extract English words (>= 4 chars, skip common words)
    const engMatches = content.match(/[a-zA-Z]{4,}/g);
    if (engMatches) {
      words.push(...engMatches.map(w => w.toLowerCase()));
    }

    // Extract Chinese segments by splitting on common particles/conjunctions first,
    // then taking segments of 2-4 chars (meaningful word-level units).
    const chnRaw = content.replace(/[^一-鿿]/g, ' ');
    const chnSegments = chnRaw.split(/\s+/).filter(Boolean);
    for (const raw of chnSegments) {
      // Split on break characters (particles, conjunctions)
      const parts = this.splitOnBreakChars(raw);
      for (const seg of parts) {
        // Only keep clean 2-4 char word-level units. Previously long segments
        // were sliced into overlapping bigrams ("本周四北","四北京晚"…), which are
        // meaningless fragments that (a) pollute the topic and (b) match unrelated
        // messages via substring `includes`. Dropping them: rely on the LLM keyword
        // extractor (extractKeywords) for long/complex content instead.
        if (seg.length >= 2 && seg.length <= 4) {
          words.push(seg);
        }
      }
    }

    const filtered = words.filter(w => {
      if (entry.keywords.includes(w)) return false;
      if (STOPWORDS.has(w)) return false;
      // Filter keywords that start or end with a stopword (indicates bad segmentation)
      for (const sw of STOPWORDS) {
        if (w.startsWith(sw) || w.endsWith(sw)) return false;
      }
      return true;
    });
    entry.keywords.push(...filtered.slice(0, 6));

    if (entry.keywords.length > 30) {
      entry.keywords = entry.keywords.slice(-30);
    }
    this.save();
  }

  updateDisplayName(label: string, displayName: string): void {
    const normalized = this.normalizeLabel(label);
    this.reload();
    const entry = this.data.topics[normalized];
    if (!entry) return;
    entry.displayName = displayName;
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

  private splitOnBreakChars(str: string): string[] {
    const parts: string[] = [];
    let current = '';
    for (const ch of str) {
      if (CJK_BREAK_CHARS.has(ch)) {
        if (current.length >= 2) parts.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.length >= 2) parts.push(current);
    return parts;
  }

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
