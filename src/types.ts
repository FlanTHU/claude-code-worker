/**
 * Type definitions for the Topic Router plugin.
 */

export type TopicStatus = 'active' | 'inactive' | 'ended';
export type ClassifyAction = 'continue' | 'switch' | 'new' | 'passthrough';

export interface TopicEntry {
  label: string;
  displayName: string;
  sessionKey: string;
  status: TopicStatus;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  keywords: string[];
  summary?: string;
  parentFork?: string;
  forkExpiresAt?: number;
}

export interface TopicRegistryData {
  activeSessionKey: string | null;
  topics: Record<string, TopicEntry>;
}

export interface ClassifyResult {
  action: ClassifyAction;
  targetLabel: string | null;
  displayName?: string;
  confidence: number;
  reason: string;
  uiStrategy?: UIStrategy;
  layer?: string;
}

export interface TopicRouterConfig {
  enabled: boolean;
  classifier: {
    mode: 'rules' | 'llm' | 'hybrid';
    confidenceThreshold: number;
  };
  maxTopics: number;
  pruneAfterHours: number;
  /** Inactive topics idle longer than this are auto-ended (removed from the
   *  classifier candidate pool). Defaults to 24h when unset. `prune` still
   *  physically removes them later per pruneAfterHours. */
  inactiveExpireHours?: number;
  replyFooter: boolean;
  targetSessionKey: string;
  v4?: V4Config;
  /**
   * Runtime-injected adaptive thresholds from the feedback-store (set by
   * hook-handler before each classify() call). Not persisted config — lets the
   * classifier use feedback-driven values instead of hardcoded defaults.
   */
  _adaptiveThresholds?: AdaptiveThresholds;
}

export interface HookEvent {
  content: string;
  body: string;
  channel: string;
  sessionKey: string;
  senderId: string;
  isGroup: boolean;
  timestamp: number;
}

export interface HookContext {
  channelId: string;
  accountId: string;
  conversationId: string;
  sessionKey: string;
  senderId: string;
}

export interface HookResult {
  handled: boolean;
  text?: string;
  sessionKey?: string;
}

// ── V4: Feedback & Self-Learning ──

export type FeedbackSignal =
  | 'manual_switch_after_auto'
  | 'manual_new_after_continue'
  | 'continued_in_routed_topic'
  | 'immediate_switch_back';

export interface FeedbackEvent {
  timestamp: number;
  signal: FeedbackSignal;
  fromTopic: string | null;
  toTopic: string | null;
  classifierLayer: string;
  confidence: number;
  messageSnippet: string;
}

export interface AdaptiveThresholds {
  confidenceThreshold: number;
  saturationMessageCount: number;
  saturationIdleMinutes: number;
  hintThresholdLow: number;
  hintThresholdHigh: number;
  lastAdjustedAt: number;
}

export interface FeedbackStoreData {
  events: FeedbackEvent[];
  thresholds: AdaptiveThresholds;
  stats: {
    totalRoutes: number;
    correctRoutes: number;
    corrections: number;
    missedNewTopics: number;
  };
  /** Persisted event-count at the last adapt, so the adapt cadence survives
   *  process restarts (eventsSinceAdapt used to be in-memory and reset to 0 on
   *  every restart, starving the adapt trigger under a frequently-restarted bridge). */
  lastAdaptedEventCount?: number;
}

// ── V4: Soft Fork ──

export interface ForkContext {
  parentTopicLabel: string;
  childTopicLabel: string;
  forkedAt: number;
  contextSummary: string;
  mergeWindowExpiresAt: number;
  merged: boolean;
}

export interface ContextBridgeData {
  activeForks: ForkContext[];
}

// ── V4: Route Tracking ──

export interface LastRouteInfo {
  timestamp: number;
  topic: string;
  action: ClassifyAction;
  confidence: number;
  layer: string;
}

export type UIStrategy = 'silent' | 'hint' | 'confirm';

// ── V4: Config Extension ──

export interface V4Config {
  softFork: { enabled: boolean; mergeWindowMinutes: number };
  feedback: { enabled: boolean; adaptInterval: number };
  hints: { enabled: boolean; lowThreshold: number; highThreshold: number };
}
