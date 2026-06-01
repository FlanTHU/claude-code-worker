import type { FeedbackEvent, FeedbackSignal, FeedbackStoreData, AdaptiveThresholds, LastRouteInfo } from './types.js';
export declare class FeedbackStore {
    private filePath;
    private data;
    private lastRouteInfo;
    private eventsSinceAdapt;
    constructor(stateDir: string);
    private load;
    private save;
    getThresholds(): AdaptiveThresholds;
    getStats(): FeedbackStoreData['stats'];
    setLastRoute(info: LastRouteInfo): void;
    getLastRoute(): LastRouteInfo | null;
    record(signal: FeedbackSignal, metadata: Omit<FeedbackEvent, 'timestamp' | 'signal'>): void;
    adaptThresholds(): void;
}
