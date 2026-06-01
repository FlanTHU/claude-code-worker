/**
 * V4 Feature Tests — Self-learning classifier with feedback loop and soft fork.
 *
 * Run: npx tsx tests/v4.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { FeedbackStore } from '../src/feedback-store.js';
import { ContextBridge } from '../src/context-bridge.js';
import { determineUIStrategy } from '../src/classifier.js';
import type { AdaptiveThresholds, ClassifyResult, FeedbackSignal } from '../src/types.js';

// ── Helpers ──

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-router-test-'));
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 1. FeedbackStore Tests ──

describe('FeedbackStore', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
  });

  it('initializes with default thresholds when no file exists', () => {
    const store = new FeedbackStore(stateDir);
    const t = store.getThresholds();
    assert.equal(t.confidenceThreshold, 0.6);
    assert.equal(t.saturationMessageCount, 3);
    assert.equal(t.saturationIdleMinutes, 5);
    assert.equal(t.hintThresholdLow, 0.5);
    assert.equal(t.hintThresholdHigh, 0.75);
    cleanup(stateDir);
  });

  it('records feedback events and persists to disk', () => {
    const store = new FeedbackStore(stateDir);
    store.record('manual_switch_after_auto', {
      fromTopic: 'coding',
      toTopic: 'weather',
      classifierLayer: 'L1',
      confidence: 0.7,
      messageSnippet: '明天天气怎么样',
    });

    const stats = store.getStats();
    assert.equal(stats.totalRoutes, 1);
    assert.equal(stats.corrections, 1);

    // Verify persistence
    const filePath = path.join(stateDir, 'feedback-data.json');
    assert.ok(fs.existsSync(filePath));
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].signal, 'manual_switch_after_auto');
    cleanup(stateDir);
  });

  it('ring buffer caps at 200 events', () => {
    const store = new FeedbackStore(stateDir);
    for (let i = 0; i < 210; i++) {
      store.record('continued_in_routed_topic', {
        fromTopic: 'a',
        toTopic: 'a',
        classifierLayer: 'L1',
        confidence: 0.8,
        messageSnippet: `msg ${i}`,
      });
    }
    const filePath = path.join(stateDir, 'feedback-data.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(data.events.length, 200);
    cleanup(stateDir);
  });

  it('tracks lastRouteInfo', () => {
    const store = new FeedbackStore(stateDir);
    assert.equal(store.getLastRoute(), null);

    store.setLastRoute({
      timestamp: Date.now(),
      topic: 'coding',
      action: 'continue',
      confidence: 0.8,
      layer: 'L1',
    });

    const info = store.getLastRoute();
    assert.equal(info?.topic, 'coding');
    assert.equal(info?.action, 'continue');
    cleanup(stateDir);
  });

  it('adapts thresholds after 20 correction events (raises confidence)', () => {
    const store = new FeedbackStore(stateDir);
    const initial = store.getThresholds().confidenceThreshold;

    // Simulate 20 misroute events (100% error rate)
    for (let i = 0; i < 20; i++) {
      store.record('manual_switch_after_auto', {
        fromTopic: 'a',
        toTopic: 'b',
        classifierLayer: 'L2',
        confidence: 0.65,
        messageSnippet: `test ${i}`,
      });
    }

    const after = store.getThresholds().confidenceThreshold;
    assert.ok(after > initial, `Expected threshold to increase: ${initial} → ${after}`);
    cleanup(stateDir);
  });

  it('adapts thresholds after 20 correct events (lowers confidence)', () => {
    const store = new FeedbackStore(stateDir);
    const initial = store.getThresholds().confidenceThreshold;

    // Simulate 20 correct route events (0% error rate)
    for (let i = 0; i < 20; i++) {
      store.record('continued_in_routed_topic', {
        fromTopic: 'a',
        toTopic: 'a',
        classifierLayer: 'L1',
        confidence: 0.8,
        messageSnippet: `test ${i}`,
      });
    }

    const after = store.getThresholds().confidenceThreshold;
    assert.ok(after < initial, `Expected threshold to decrease: ${initial} → ${after}`);
    cleanup(stateDir);
  });

  it('lowers saturation threshold when many missed-new events', () => {
    const store = new FeedbackStore(stateDir);
    const initial = store.getThresholds().saturationMessageCount;

    // 6 missed-new + 14 correct (to trigger adapt at 20)
    for (let i = 0; i < 6; i++) {
      store.record('manual_new_after_continue', {
        fromTopic: 'a',
        toTopic: 'b',
        classifierLayer: 'L3',
        confidence: 0.6,
        messageSnippet: `/new topic-${i}`,
      });
    }
    for (let i = 0; i < 14; i++) {
      store.record('continued_in_routed_topic', {
        fromTopic: 'a',
        toTopic: 'a',
        classifierLayer: 'L1',
        confidence: 0.8,
        messageSnippet: `msg ${i}`,
      });
    }

    const after = store.getThresholds().saturationMessageCount;
    assert.ok(after < initial, `Expected saturation to decrease: ${initial} → ${after}`);
    cleanup(stateDir);
  });

  it('respects hard bounds on threshold adjustment', () => {
    const store = new FeedbackStore(stateDir);

    // Push 200 misroute events to max out the threshold
    for (let i = 0; i < 200; i++) {
      store.record('manual_switch_after_auto', {
        fromTopic: 'a',
        toTopic: 'b',
        classifierLayer: 'L2',
        confidence: 0.5,
        messageSnippet: `err ${i}`,
      });
    }

    const t = store.getThresholds();
    assert.ok(t.confidenceThreshold <= 0.85, `Threshold should not exceed 0.85: ${t.confidenceThreshold}`);
    assert.ok(t.hintThresholdHigh <= 0.9, `HintHigh should not exceed 0.9: ${t.hintThresholdHigh}`);
    cleanup(stateDir);
  });
});

// ── 2. ContextBridge Tests ──

describe('ContextBridge', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
  });

  it('creates a fork with correct merge window', () => {
    const bridge = new ContextBridge(stateDir);
    const fork = bridge.createFork('coding', 'weather', '讨论了 Redis 缓存策略', 5);

    assert.equal(fork.parentTopicLabel, 'coding');
    assert.equal(fork.childTopicLabel, 'weather');
    assert.equal(fork.contextSummary, '讨论了 Redis 缓存策略');
    assert.equal(fork.merged, false);
    assert.ok(fork.mergeWindowExpiresAt > Date.now());
    assert.ok(fork.mergeWindowExpiresAt <= Date.now() + 5 * 60 * 1000 + 100);
    cleanup(stateDir);
  });

  it('checkMerge returns fork within merge window', () => {
    const bridge = new ContextBridge(stateDir);
    bridge.createFork('coding', 'weather', 'summary', 5);

    const result = bridge.checkMerge('weather', 'coding');
    assert.ok(result !== null);
    assert.equal(result!.parentTopicLabel, 'coding');
    assert.equal(result!.childTopicLabel, 'weather');
    cleanup(stateDir);
  });

  it('checkMerge returns null for expired fork', () => {
    const bridge = new ContextBridge(stateDir);
    const fork = bridge.createFork('coding', 'weather', 'summary', 0);
    // Merge window is 0 minutes = already expired
    fork.mergeWindowExpiresAt = Date.now() - 1000;

    // Reload from disk won't have the modified in-memory fork, so manipulate file
    const filePath = path.join(stateDir, 'context-bridge.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    data.activeForks[0].mergeWindowExpiresAt = Date.now() - 1000;
    fs.writeFileSync(filePath, JSON.stringify(data));

    const bridge2 = new ContextBridge(stateDir);
    const result = bridge2.checkMerge('weather', 'coding');
    assert.equal(result, null);
    cleanup(stateDir);
  });

  it('checkMerge returns null for wrong direction', () => {
    const bridge = new ContextBridge(stateDir);
    bridge.createFork('coding', 'weather', 'summary', 5);

    // Wrong: trying to merge coding→weather (reversed)
    const result = bridge.checkMerge('coding', 'weather');
    assert.equal(result, null);
    cleanup(stateDir);
  });

  it('markMerged prevents subsequent checkMerge', () => {
    const bridge = new ContextBridge(stateDir);
    bridge.createFork('coding', 'weather', 'summary', 5);

    const fork = bridge.checkMerge('weather', 'coding');
    assert.ok(fork !== null);
    bridge.markMerged(fork!);

    const result = bridge.checkMerge('weather', 'coding');
    assert.equal(result, null);
    cleanup(stateDir);
  });

  it('getContextForChild returns summary for active fork', () => {
    const bridge = new ContextBridge(stateDir);
    bridge.createFork('coding', 'weather', '正在讨论 Redis vs Memcached 性能对比', 5);

    const ctx = bridge.getContextForChild('weather');
    assert.equal(ctx, '正在讨论 Redis vs Memcached 性能对比');
    cleanup(stateDir);
  });

  it('getContextForChild returns null for unknown child', () => {
    const bridge = new ContextBridge(stateDir);
    const ctx = bridge.getContextForChild('nonexistent');
    assert.equal(ctx, null);
    cleanup(stateDir);
  });

  it('caps at 5 active forks', () => {
    const bridge = new ContextBridge(stateDir);
    for (let i = 0; i < 7; i++) {
      bridge.createFork('parent', `child-${i}`, `summary ${i}`, 5);
    }

    const filePath = path.join(stateDir, 'context-bridge.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(data.activeForks.length, 5);
    // Should keep the last 5 (child-2 through child-6)
    assert.equal(data.activeForks[0].childTopicLabel, 'child-2');
    assert.equal(data.activeForks[4].childTopicLabel, 'child-6');
    cleanup(stateDir);
  });

  it('persists to disk and survives reload', () => {
    const bridge1 = new ContextBridge(stateDir);
    bridge1.createFork('coding', 'weather', 'context data', 5);

    const bridge2 = new ContextBridge(stateDir);
    const result = bridge2.checkMerge('weather', 'coding');
    assert.ok(result !== null);
    assert.equal(result!.contextSummary, 'context data');
    cleanup(stateDir);
  });
});

// ── 3. UI Strategy Tests ──

describe('determineUIStrategy', () => {
  const defaultThresholds: AdaptiveThresholds = {
    confidenceThreshold: 0.6,
    saturationMessageCount: 3,
    saturationIdleMinutes: 5,
    hintThresholdLow: 0.5,
    hintThresholdHigh: 0.75,
    lastAdjustedAt: 0,
  };

  it('returns silent for continue action regardless of confidence', () => {
    const result: ClassifyResult = {
      action: 'continue',
      targetLabel: 'coding',
      confidence: 0.3,
      reason: 'test',
    };
    assert.equal(determineUIStrategy(result, defaultThresholds), 'silent');
  });

  it('returns silent for passthrough action', () => {
    const result: ClassifyResult = {
      action: 'passthrough',
      targetLabel: null,
      confidence: 0.4,
      reason: 'test',
    };
    assert.equal(determineUIStrategy(result, defaultThresholds), 'silent');
  });

  it('returns silent for high-confidence switch', () => {
    const result: ClassifyResult = {
      action: 'switch',
      targetLabel: 'weather',
      confidence: 0.85,
      reason: 'test',
    };
    assert.equal(determineUIStrategy(result, defaultThresholds), 'silent');
  });

  it('returns hint for medium-confidence switch', () => {
    const result: ClassifyResult = {
      action: 'switch',
      targetLabel: 'weather',
      confidence: 0.65,
      reason: 'test',
    };
    assert.equal(determineUIStrategy(result, defaultThresholds), 'hint');
  });

  it('returns confirm for low-confidence new', () => {
    const result: ClassifyResult = {
      action: 'new',
      targetLabel: null,
      confidence: 0.45,
      reason: 'test',
    };
    assert.equal(determineUIStrategy(result, defaultThresholds), 'confirm');
  });

  it('respects adjusted thresholds', () => {
    const strict: AdaptiveThresholds = {
      ...defaultThresholds,
      hintThresholdLow: 0.6,
      hintThresholdHigh: 0.85,
    };

    // 0.7 would be "hint" with default thresholds, but "confirm" with strict
    const result: ClassifyResult = {
      action: 'switch',
      targetLabel: 'weather',
      confidence: 0.55,
      reason: 'test',
    };
    assert.equal(determineUIStrategy(result, strict), 'confirm');
  });

  it('boundary: exactly at hintThresholdHigh → silent', () => {
    const result: ClassifyResult = {
      action: 'new',
      targetLabel: null,
      confidence: 0.75,
      reason: 'test',
    };
    assert.equal(determineUIStrategy(result, defaultThresholds), 'silent');
  });

  it('boundary: exactly at hintThresholdLow → hint', () => {
    const result: ClassifyResult = {
      action: 'switch',
      targetLabel: 'x',
      confidence: 0.5,
      reason: 'test',
    };
    assert.equal(determineUIStrategy(result, defaultThresholds), 'hint');
  });
});

// ── 4. Integration Scenarios ──

describe('V4 Integration Scenarios', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
  });

  it('Scenario: user corrects misroute → feedback recorded → threshold adapts', () => {
    const store = new FeedbackStore(stateDir);

    // Simulate: system auto-routes to "coding"
    store.setLastRoute({
      timestamp: Date.now(),
      topic: 'coding',
      action: 'switch',
      confidence: 0.65,
      layer: 'L1',
    });

    // User immediately /switches to "weather" (correction)
    const lastRoute = store.getLastRoute()!;
    store.record('manual_switch_after_auto', {
      fromTopic: lastRoute.topic,
      toTopic: 'weather',
      classifierLayer: lastRoute.layer,
      confidence: lastRoute.confidence,
      messageSnippet: '/switch weather',
    });

    const stats = store.getStats();
    assert.equal(stats.corrections, 1);
    assert.equal(stats.totalRoutes, 1);
    cleanup(stateDir);
  });

  it('Scenario: soft fork → user returns → auto-merge', () => {
    const bridge = new ContextBridge(stateDir);

    // System creates new topic (fork from coding)
    bridge.createFork('coding', 'weather', '讨论Redis持久化方案', 5);

    // User /switches back to coding within 5min
    const fork = bridge.checkMerge('weather', 'coding');
    assert.ok(fork !== null, 'Should find mergeable fork');
    assert.equal(fork!.parentTopicLabel, 'coding');

    // Mark as merged
    bridge.markMerged(fork!);

    // Should not be mergeable again
    const again = bridge.checkMerge('weather', 'coding');
    assert.equal(again, null);
    cleanup(stateDir);
  });

  it('Scenario: multiple corrections lower system aggression', () => {
    const store = new FeedbackStore(stateDir);
    const initial = store.getThresholds().confidenceThreshold;

    // 15 corrections + 5 correct = 75% error rate → should raise threshold
    for (let i = 0; i < 15; i++) {
      store.record('manual_switch_after_auto', {
        fromTopic: 'a', toTopic: 'b', classifierLayer: 'L2',
        confidence: 0.6, messageSnippet: `err ${i}`,
      });
    }
    for (let i = 0; i < 5; i++) {
      store.record('continued_in_routed_topic', {
        fromTopic: 'a', toTopic: 'a', classifierLayer: 'L1',
        confidence: 0.8, messageSnippet: `ok ${i}`,
      });
    }

    const after = store.getThresholds().confidenceThreshold;
    assert.ok(after > initial, `High error rate should raise threshold: ${initial} → ${after}`);
    cleanup(stateDir);
  });

  it('Scenario: long period of correct routing allows lower thresholds', () => {
    const store = new FeedbackStore(stateDir);
    const initial = store.getThresholds().confidenceThreshold;

    // 20 correct events, 0 errors
    for (let i = 0; i < 20; i++) {
      store.record('continued_in_routed_topic', {
        fromTopic: 'coding', toTopic: 'coding', classifierLayer: 'L1',
        confidence: 0.7, messageSnippet: `good ${i}`,
      });
    }

    const after = store.getThresholds().confidenceThreshold;
    assert.ok(after < initial, `Low error rate should lower threshold: ${initial} → ${after}`);
    cleanup(stateDir);
  });

  it('Scenario: feedback store survives restart (persistence)', () => {
    const store1 = new FeedbackStore(stateDir);
    store1.record('manual_switch_after_auto', {
      fromTopic: 'a', toTopic: 'b', classifierLayer: 'L1',
      confidence: 0.7, messageSnippet: 'test',
    });

    // Simulate restart: create new instance
    const store2 = new FeedbackStore(stateDir);
    const stats = store2.getStats();
    assert.equal(stats.corrections, 1);
    assert.equal(stats.totalRoutes, 1);
    cleanup(stateDir);
  });
});
