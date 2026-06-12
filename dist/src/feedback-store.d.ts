import type { FeedbackEvent, FeedbackSignal, FeedbackStoreData, AdaptiveThresholds, LastRouteInfo } from './types.js';
/** Single source of truth for default thresholds. Exported so the classifier can
 *  use the SAME defaults when no adaptive value is injected — otherwise toggling
 *  self-learning on/off would step the saturation thresholds (classifier used to
 *  fall back to 10min/5 while this default is 5min/3). */
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
