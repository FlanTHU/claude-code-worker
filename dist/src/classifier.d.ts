/**
 * Topic Classifier — hybrid rules + LLM approach.
 *
 * Strategy:
 *   L0: Explicit commands (/switch, /new, /end) — always rules
 *   L1: High-confidence rules (keyword 2+, continuation signals, short messages)
 *   L2: LLM fallback for ambiguous cases
 */
import type { ClassifyResult, TopicEntry, TopicRouterConfig } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
import type { LLMConfig } from './llm-client.js';
export interface ClassifyOptions {
    content: string;
    recentMessages: string[];
    registry: TopicRegistry;
    config: TopicRouterConfig;
    llmConfig?: LLMConfig;
    log?: (...args: unknown[]) => void;
}
export declare function parseExplicitCommand(content: string): ClassifyResult | null;
export declare function matchKeywords(content: string, topics: TopicEntry[]): ClassifyResult | null;
export declare function detectContinuation(content: string, _recentMessages: string[], activeTopic: TopicEntry | null): ClassifyResult | null;
export declare function classify(content: string, recentMessages: string[], registry: TopicRegistry, config: TopicRouterConfig, llmConfig?: LLMConfig, log?: (...args: unknown[]) => void): Promise<ClassifyResult>;
export declare function generateTopicLabel(content: string): string;
