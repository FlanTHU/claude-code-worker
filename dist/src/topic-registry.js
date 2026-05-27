/**
 * Topic Registry — manages topic lifecycle and persistence.
 *
 * Stores topic entries in a JSON file under the OpenClaw state directory.
 * Each topic maps to an isolated session key (agent:main:topic:{label}).
 */
import fs from 'node:fs';
import path from 'node:path';
const REGISTRY_FILE = 'topic-sessions.json';
const STOPWORDS = new Set([
    // Chinese high-frequency function words that cause false matches
    '怎么', '什么', '这个', '那个', '为什么', '怎么样', '是什么',
    '这是', '那是', '可以', '不能', '已经', '还是', '或者',
    '如何', '哪个', '哪些', '这些', '那些', '一下', '一些',
    '但是', '因为', '所以', '如果', '虽然', '不过',
    // English common words
    'this', 'that', 'what', 'which', 'have', 'been', 'with',
    'from', 'they', 'will', 'would', 'could', 'should',
    'about', 'there', 'their', 'some', 'other', 'than',
]);
export class TopicRegistry {
    data;
    filePath;
    constructor(stateDir) {
        this.filePath = path.join(stateDir, REGISTRY_FILE);
        this.data = this.load();
    }
    // ---------------------------------------------------------------------------
    // Query
    // ---------------------------------------------------------------------------
    getActive() {
        if (!this.data.activeSessionKey)
            return null;
        return Object.values(this.data.topics).find(t => t.sessionKey === this.data.activeSessionKey && t.status === 'active') ?? null;
    }
    get(label) {
        return this.data.topics[label];
    }
    getAll() {
        return Object.values(this.data.topics).filter(t => t.status !== 'ended');
    }
    getActiveTopics() {
        return Object.values(this.data.topics).filter(t => t.status === 'active');
    }
    getInactiveTopics() {
        return Object.values(this.data.topics).filter(t => t.status === 'inactive');
    }
    // ---------------------------------------------------------------------------
    // Mutate
    // ---------------------------------------------------------------------------
    getOrCreate(label, displayName) {
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
        }
        else if (displayName && entry.displayName === entry.label) {
            entry.displayName = displayName;
        }
        entry.lastActiveAt = Date.now();
        entry.messageCount++;
        this.data.activeSessionKey = entry.sessionKey;
        this.save();
        return entry;
    }
    setActive(label) {
        const normalized = this.normalizeLabel(label);
        const entry = this.data.topics[normalized];
        if (!entry)
            return;
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
    markInactive(label) {
        const normalized = this.normalizeLabel(label);
        const entry = this.data.topics[normalized];
        if (!entry)
            return;
        entry.status = 'inactive';
        if (this.data.activeSessionKey === entry.sessionKey) {
            this.data.activeSessionKey = null;
        }
        this.save();
    }
    markEnded(label) {
        const normalized = this.normalizeLabel(label);
        const entry = this.data.topics[normalized];
        if (!entry)
            return;
        entry.status = 'ended';
        if (this.data.activeSessionKey === entry.sessionKey) {
            this.data.activeSessionKey = null;
        }
        this.save();
    }
    learnKeywords(label, content) {
        const normalized = this.normalizeLabel(label);
        const entry = this.data.topics[normalized];
        if (!entry)
            return;
        const words = [];
        // Extract English words (>= 4 chars, skip common words)
        const engMatches = content.match(/[a-zA-Z]{4,}/g);
        if (engMatches) {
            words.push(...engMatches.map(w => w.toLowerCase()));
        }
        // Extract Chinese segments (>= 3 chars to avoid stopword-level bigrams)
        const chnMatches = content.match(/[一-鿿]{3,}/g);
        if (chnMatches) {
            for (const seg of chnMatches) {
                if (seg.length <= 4) {
                    words.push(seg);
                }
                else {
                    // Chunk into 3-char trigrams for better specificity
                    for (let i = 0; i <= seg.length - 3; i += 3) {
                        words.push(seg.slice(i, i + 3));
                    }
                }
            }
        }
        const filtered = words.filter(w => !STOPWORDS.has(w) && !entry.keywords.includes(w));
        entry.keywords.push(...filtered.slice(0, 6));
        if (entry.keywords.length > 30) {
            entry.keywords = entry.keywords.slice(-30);
        }
        this.save();
    }
    updateSummary(label, summary) {
        const normalized = this.normalizeLabel(label);
        const entry = this.data.topics[normalized];
        if (!entry)
            return;
        entry.summary = summary.slice(0, 200);
        this.save();
    }
    /** Remove topics older than maxAgeMs. Returns count of pruned topics. */
    prune(maxAgeMs) {
        const cutoff = Date.now() - (maxAgeMs ?? 7 * 24 * 3600 * 1000);
        let pruned = 0;
        for (const [label, entry] of Object.entries(this.data.topics)) {
            if (entry.status !== 'active' && entry.lastActiveAt < cutoff) {
                delete this.data.topics[label];
                pruned++;
            }
        }
        if (pruned > 0)
            this.save();
        return pruned;
    }
    // ---------------------------------------------------------------------------
    // Serialization
    // ---------------------------------------------------------------------------
    normalizeLabel(label) {
        return label
            .toLowerCase()
            .replace(/[^a-z0-9\u4e00-\u9fff_-]/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 64) || 'general';
    }
    load() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && parsed.topics) {
                return parsed;
            }
        }
        catch {
            // File doesn't exist or is invalid — start fresh
        }
        return { activeSessionKey: null, topics: {} };
    }
    save() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const tmpPath = this.filePath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf-8');
            fs.renameSync(tmpPath, this.filePath);
        }
        catch (err) {
            console.error('[topic-router] Failed to save registry:', err);
        }
    }
}
