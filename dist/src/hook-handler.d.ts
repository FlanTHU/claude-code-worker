import type { TopicRouterConfig, HookResult } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
import type { LLMConfig } from './llm-client.js';
export declare function handleBeforeDispatch(params: {
    event: any;
    ctx: any;
    registry: TopicRegistry;
    config: TopicRouterConfig;
    stateDir: string;
    classifierLlmConfig: LLMConfig;
    log: (...args: unknown[]) => void;
}): Promise<HookResult | undefined>;
