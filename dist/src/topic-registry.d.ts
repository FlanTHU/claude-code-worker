/**
 * Topic Registry — manages topic lifecycle and persistence.
 *
 * Stores topic entries in a JSON file under the OpenClaw state directory.
 * Each topic maps to an isolated session key (agent:main:topic:{label}).
 */
import type { TopicEntry } from './types.js';
export declare const STOPWORDS: Set<string>;
export declare class TopicRegistry {
    private data;
    private filePath;
    constructor(stateDir: string);
    private reload;
    getActive(): TopicEntry | null;
    get(label: string): TopicEntry | undefined;
    findByDisplayName(query: string): TopicEntry | undefined;
    getAll(): TopicEntry[];
    getActiveTopics(): TopicEntry[];
    getInactiveTopics(): TopicEntry[];
    /** Find an unused label derived from base (base, base-2, base-3, …). */
    private freshLabel;
    /**
     * Resolve a label to an entry that is safe to activate.
     * - No existing entry, or a non-ended entry → return it (create if absent).
     * - An *ended* entry → do NOT revive in place; create a fresh sibling
     *   (new label → new sessionKey) so the old gateway context stays detached.
     */
    private resolveActivatable;
    getOrCreate(label: string, displayName?: string): TopicEntry;
    /**
     * Activate an existing topic. Returns the activated entry, or undefined if
     * the label is unknown. If the target is ended, a fresh sibling is created
     * instead of reviving it (see resolveActivatable).
     */
    setActive(label: string): TopicEntry | undefined;
    markInactive(label: string): void;
    markEnded(label: string): void;
    setKeywords(label: string, keywords: string[]): void;
    learnKeywords(label: string, content: string): void;
    updateDisplayName(label: string, displayName: string): void;
    updateSummary(label: string, summary: string): void;
    /** Remove topics older than maxAgeMs. Returns count of pruned topics. */
    prune(maxAgeMs?: number): number;
    private splitOnBreakChars;
    private normalizeLabel;
    private load;
    private save;
}
