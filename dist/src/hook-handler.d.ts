import type { TopicRouterConfig, HookResult } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
import type { LLMConfig } from './llm-client.js';
import type { FeedbackStore } from './feedback-store.js';
import type { ContextBridge } from './context-bridge.js';
/**
 * Session routing approach:
 * - Classify message → determine topic
 * - Mutate ctx.sessionKey to route to topic-isolated session
 * - Return undefined (not handled) → gateway processes with full tools/skills
 * - Footer added via separate output hook
 */
export declare function handleBeforeDispatch(params: {
    event: any;
    ctx: any;
    registry: TopicRegistry;
    config: TopicRouterConfig;
    stateDir: string;
    classifierLlmConfig: LLMConfig;
    log: (...args: unknown[]) => void;
    feedbackStore?: FeedbackStore;
    contextBridge?: ContextBridge;
}): Promise<HookResult | undefined>;
