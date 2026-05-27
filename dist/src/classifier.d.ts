/**
 * Topic Classifier — determines whether a message continues the current topic,
 * switches to an existing topic, starts a new topic, or should passthrough.
 *
 * Classification strategy (priority order):
 *   L0: Explicit user commands (/switch, /new, /end)
 *   L1: Keyword matching against known topics
 *   L2: Continuation detection (short messages without switch signals)
 *   L3: LLM-based semantic classification (fallback)
 */
import type { ClassifyResult, TopicEntry, TopicRouterConfig } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
export declare function parseExplicitCommand(content: string): ClassifyResult | null;
export declare function matchKeywords(content: string, topics: TopicEntry[]): ClassifyResult | null;
export declare function detectContinuation(content: string, recentMessages: string[], activeTopic: TopicEntry | null): ClassifyResult | null;
export declare function detectBackReference(content: string, topics: TopicEntry[]): ClassifyResult | null;
export declare function classify(content: string, recentMessages: string[], registry: TopicRegistry, config: TopicRouterConfig): Promise<ClassifyResult>;
export declare function generateTopicLabel(content: string): string;
