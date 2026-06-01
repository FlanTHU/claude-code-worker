import * as fs from 'fs';
import * as path from 'path';
import type {
  FeedbackEvent,
  FeedbackSignal,
  FeedbackStoreData,
  AdaptiveThresholds,
  LastRouteInfo,
} from './types.js';

const MAX_EVENTS = 200;
const ADAPT_INTERVAL = 20;

const DEFAULT_THRESHOLDS: AdaptiveThresholds = {
  confidenceThreshold: 0.6,
  saturationMessageCount: 3,
  saturationIdleMinutes: 5,
  hintThresholdLow: 0.5,
  hintThresholdHigh: 0.75,
  lastAdjustedAt: 0,
};

export class FeedbackStore {
  private filePath: string;
  private data: FeedbackStoreData;
  private lastRouteInfo: LastRouteInfo | null = null;
  private eventsSinceAdapt = 0;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'feedback-data.json');
    this.data = this.load();
  }

  private load(): FeedbackStoreData {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {
        events: [],
        thresholds: { ...DEFAULT_THRESHOLDS },
        stats: { totalRoutes: 0, correctRoutes: 0, corrections: 0, missedNewTopics: 0 },
      };
    }
  }

  private save(): void {
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  getThresholds(): AdaptiveThresholds {
    return this.data.thresholds;
  }

  getStats(): FeedbackStoreData['stats'] {
    return this.data.stats;
  }

  setLastRoute(info: LastRouteInfo): void {
    this.lastRouteInfo = info;
  }

  getLastRoute(): LastRouteInfo | null {
    return this.lastRouteInfo;
  }

  record(signal: FeedbackSignal, metadata: Omit<FeedbackEvent, 'timestamp' | 'signal'>): void {
    const event: FeedbackEvent = { timestamp: Date.now(), signal, ...metadata };

    this.data.events.push(event);
    if (this.data.events.length > MAX_EVENTS) {
      this.data.events = this.data.events.slice(-MAX_EVENTS);
    }

    switch (signal) {
      case 'manual_switch_after_auto':
      case 'immediate_switch_back':
        this.data.stats.corrections++;
        break;
      case 'manual_new_after_continue':
        this.data.stats.missedNewTopics++;
        break;
      case 'continued_in_routed_topic':
        this.data.stats.correctRoutes++;
        break;
    }
    this.data.stats.totalRoutes++;

    this.eventsSinceAdapt++;
    if (this.eventsSinceAdapt >= ADAPT_INTERVAL) {
      this.adaptThresholds();
      this.eventsSinceAdapt = 0;
    }

    this.save();
  }

  adaptThresholds(): void {
    const recent = this.data.events.slice(-50);
    if (recent.length < 10) return;

    const misroutes = recent.filter(
      e => e.signal === 'manual_switch_after_auto' || e.signal === 'immediate_switch_back'
    ).length;
    const missedNew = recent.filter(e => e.signal === 'manual_new_after_continue').length;
    const total = recent.length;
    const errorRate = (misroutes + missedNew) / total;

    const t = this.data.thresholds;

    if (errorRate > 0.3) {
      t.confidenceThreshold = Math.min(t.confidenceThreshold + 0.03, 0.85);
      t.hintThresholdHigh = Math.min(t.hintThresholdHigh + 0.03, 0.9);
    } else if (errorRate < 0.1) {
      t.confidenceThreshold = Math.max(t.confidenceThreshold - 0.02, 0.4);
      t.hintThresholdHigh = Math.max(t.hintThresholdHigh - 0.02, 0.6);
    }

    if (missedNew > 5) {
      t.saturationMessageCount = Math.max(t.saturationMessageCount - 1, 2);
    } else if (missedNew === 0 && total >= 20) {
      t.saturationMessageCount = Math.min(t.saturationMessageCount + 1, 8);
    }

    t.lastAdjustedAt = Date.now();
    this.save();
  }
}
