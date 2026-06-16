import type { FeedbackEvent, FeedbackSignal, FeedbackStoreData, AdaptiveThresholds, LastRouteInfo } from './types.js';
/** Single source of truth for default thresholds. Exported so the classifier can
 *  use the SAME defaults when no adaptive value is injected — otherwise toggling
 *  self-learning on/off would step the saturation thresholds.
 *  saturationMessageCount/IdleMinutes were 3/5 — far too eager: a topic with just 3
 *  messages idle 5min got auto-split, so coming back ~15min later to ask a follow-up
 *  about the same subject spawned a new topic. Raised to 6/15 to match real chat rhythm
 *  (people pause and return). Self-learning still moves saturationMessageCount within
 *  [2,8], so 6 leaves room both ways. */
export declare const DEFAULT_THRESHOLDS: AdaptiveThresholds;
type Logger = (...args: unknown[]) => void;
export declare class FeedbackStore {
    private filePath;
    private data;
    private lastRouteBySession;
    private log;
    constructor(stateDir: string, log?: Logger);
    private load;
    private save;
    getThresholds(): AdaptiveThresholds;
    getStats(): FeedbackStoreData['stats'];
    /** Wipe all learned feedback back to defaults — both in-memory and on disk.
     *  Lets `/topic-router reset` clear bug-era / stale data at runtime without a
     *  restart (deleting the file alone doesn't help: the running process keeps the
     *  old data in memory and rewrites it on the next record()). */
    reset(): void;
    setLastRoute(sessionKey: string, info: LastRouteInfo): void;
    getLastRoute(sessionKey: string): LastRouteInfo | null;
    record(signal: FeedbackSignal, metadata: Omit<FeedbackEvent, 'timestamp' | 'signal'>): void;
    adaptThresholds(): void;
}
export {};
