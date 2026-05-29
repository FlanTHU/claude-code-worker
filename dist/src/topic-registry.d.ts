/**
 * Topic Registry — manages topic lifecycle and persistence.
 *
 * Stores topic entries in a JSON file under the OpenClaw state directory.
 * Each topic maps to an isolated session key (agent:main:topic:{label}).
 */
import type { TopicEntry } from './types.js';
export declare class TopicRegistry {
    private data;
    private filePath;
    constructor(stateDir: string);
    private reload;
    getActive(): TopicEntry | null;
    get(label: string): TopicEntry | undefined;
    getAll(): TopicEntry[];
    getActiveTopics(): TopicEntry[];
    getInactiveTopics(): TopicEntry[];
    getOrCreate(label: string, displayName?: string): TopicEntry;
    setActive(label: string): void;
    markInactive(label: string): void;
    markEnded(label: string): void;
    setKeywords(label: string, keywords: string[]): void;
    learnKeywords(label: string, content: string): void;
    updateSummary(label: string, summary: string): void;
    /** Remove topics older than maxAgeMs. Returns count of pruned topics. */
    prune(maxAgeMs?: number): number;
    private splitOnBreakChars;
    private normalizeLabel;
    private load;
    private save;
}
