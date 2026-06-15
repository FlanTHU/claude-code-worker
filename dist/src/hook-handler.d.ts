import type { TopicRouterConfig, HookResult } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
import type { LLMConfig } from './llm-client.js';
import type { FeedbackStore } from './feedback-store.js';
import type { ContextBridge } from './context-bridge.js';
export interface RecentAutoNew {
    newLabel: string;
    previousLabel: string;
    previousDisplayName: string;
    originalSessionKey: string;
    createdAt: number;
}
export declare function getRecentAutoNew(sessionKey: string): RecentAutoNew | null;
export declare function clearRecentAutoNew(sessionKey: string): void;
export declare function setPendingForceContinue(sessionKey: string, label: string): void;
export declare function deriveDisplayNameFallback(content: string): string;
/**
 * Session routing approach:
 * - Classify message → determine topic
 * - Mutate ctx.sessionKey to route to topic-isolated session
 * - Return undefined (not handled) → gateway processes with full tools/skills
 * - Footer added via separate output hook
 */
interface HandleParams {
    event: any;
    ctx: any;
    registry: TopicRegistry;
    config: TopicRouterConfig;
    stateDir: string;
    classifierLlmConfig: LLMConfig;
    log: (...args: unknown[]) => void;
    feedbackStore?: FeedbackStore;
    contextBridge?: ContextBridge;
}
/**
 * Public entry point. Serializes handling per inbound session key so concurrent
 * messages from the same conversation never interleave their classify→route→state
 * mutations (see handlerQueueBySession comment). Different sessions run in parallel.
 */
export declare function handleBeforeDispatch(params: HandleParams): Promise<HookResult | undefined>;
export {};
