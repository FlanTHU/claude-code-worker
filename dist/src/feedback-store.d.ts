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
    setLastRoute(sessionKey: string, info: LastRouteInfo): void;
    getLastRoute(sessionKey: string): LastRouteInfo | null;
    record(signal: FeedbackSignal, metadata: Omit<FeedbackEvent, 'timestamp' | 'signal'>): void;
    adaptThresholds(): void;
}
export {};
