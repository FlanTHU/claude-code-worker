import * as fs from 'fs';
import * as path from 'path';
const MAX_EVENTS = 200;
const ADAPT_INTERVAL = 20;
/** Single source of truth for default thresholds. Exported so the classifier can
 *  use the SAME defaults when no adaptive value is injected — otherwise toggling
 *  self-learning on/off would step the saturation thresholds (classifier used to
 *  fall back to 10min/5 while this default is 5min/3). */
export const DEFAULT_THRESHOLDS = {
    confidenceThreshold: 0.6,
    saturationMessageCount: 3,
    saturationIdleMinutes: 5,
    hintThresholdLow: 0.5,
    hintThresholdHigh: 0.75,
    lastAdjustedAt: 0,
};
export class FeedbackStore {
    filePath;
    data;
    // Last auto-route keyed by INBOUND sessionKey. A single shared slot let one
    // session's route clobber another's, so a /switch in session A could be
    // attributed to session B's route (wrong fromTopic). Keyed map fixes that.
    lastRouteBySession = new Map();
    log;
    constructor(stateDir, log) {
        this.filePath = path.join(stateDir, 'feedback-data.json');
        this.log = log ?? (() => { });
        this.data = this.load();
    }
    load() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            return {
                events: [],
                thresholds: { ...DEFAULT_THRESHOLDS },
                stats: { totalRoutes: 0, correctRoutes: 0, corrections: 0, missedNewTopics: 0 },
                lastAdaptedEventCount: 0,
            };
        }
    }
    save() {
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.filePath);
    }
    getThresholds() {
        return this.data.thresholds;
    }
    getStats() {
        return this.data.stats;
    }
    setLastRoute(sessionKey, info) {
        this.lastRouteBySession.set(sessionKey, info);
    }
    getLastRoute(sessionKey) {
        return this.lastRouteBySession.get(sessionKey) ?? null;
    }
    record(signal, metadata) {
        const event = { timestamp: Date.now(), signal, ...metadata };
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
        // Adapt cadence uses a persisted counter (lastAdaptedEventCount) compared to
        // the lifetime event count, so restarts don't reset progress toward the next
        // adapt. Lifetime count = events seen; we track it via stats.totalRoutes which
        // is monotonic. Trigger when enough new events accumulated since last adapt.
        const seen = this.data.stats.totalRoutes;
        const since = seen - (this.data.lastAdaptedEventCount ?? 0);
        if (since >= ADAPT_INTERVAL) {
            this.adaptThresholds();
            this.data.lastAdaptedEventCount = seen;
        }
        this.save();
    }
    adaptThresholds() {
        const recent = this.data.events.slice(-50);
        if (recent.length < 10)
            return;
        const misroutes = recent.filter(e => e.signal === 'manual_switch_after_auto' || e.signal === 'immediate_switch_back').length;
        const missedNew = recent.filter(e => e.signal === 'manual_new_after_continue').length;
        const total = recent.length;
        const errorRate = (misroutes + missedNew) / total;
        const t = this.data.thresholds;
        const before = { ...t };
        if (errorRate > 0.3) {
            t.confidenceThreshold = Math.min(t.confidenceThreshold + 0.03, 0.85);
            t.hintThresholdHigh = Math.min(t.hintThresholdHigh + 0.03, 0.9);
        }
        else if (errorRate < 0.1) {
            t.confidenceThreshold = Math.max(t.confidenceThreshold - 0.02, 0.4);
            t.hintThresholdHigh = Math.max(t.hintThresholdHigh - 0.02, 0.6);
        }
        if (missedNew > 5) {
            t.saturationMessageCount = Math.max(t.saturationMessageCount - 1, 2);
        }
        else if (missedNew === 0 && total >= 20) {
            t.saturationMessageCount = Math.min(t.saturationMessageCount + 1, 8);
        }
        t.lastAdjustedAt = Date.now();
        // Surface what self-learning actually did — otherwise thresholds drift
        // silently and there's no way to tell if learning is working / oscillating.
        const changed = before.confidenceThreshold !== t.confidenceThreshold ||
            before.hintThresholdHigh !== t.hintThresholdHigh ||
            before.saturationMessageCount !== t.saturationMessageCount;
        if (changed) {
            this.log(`[v4-adapt] errorRate=${errorRate.toFixed(2)} (misroute=${misroutes} missedNew=${missedNew} /${total}) → ` +
                `conf ${before.confidenceThreshold}→${t.confidenceThreshold}, ` +
                `hintHigh ${before.hintThresholdHigh}→${t.hintThresholdHigh}, ` +
                `satMsg ${before.saturationMessageCount}→${t.saturationMessageCount}`);
        }
        else {
            this.log(`[v4-adapt] errorRate=${errorRate.toFixed(2)} (n=${total}), no threshold change`);
        }
        this.save();
    }
}
