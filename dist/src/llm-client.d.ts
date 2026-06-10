import type { ChatMessage } from './conversation-store.js';
export declare const DEFAULT_BASE_URL = "http://model.mify.ai.srv/v1";
export declare const DEFAULT_MODEL = "xiaomi/mimo-v2.5-mit";
export interface LLMConfig {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    systemPrompt?: string;
}
/**
 * Resolve the classifier LLM config from environment, with a normal/vip cluster tier.
 * VIP gets its own model name (and optionally its own baseUrl/apiKey). All values fall
 * back through: VIP-specific → generic → built-in default, so the default behavior is
 * unchanged when no env vars are set (backward compatible).
 *
 *   TOPIC_ROUTER_CLUSTER       normal (default) | vip
 *   TOPIC_ROUTER_MODEL         model name for the normal cluster
 *   TOPIC_ROUTER_VIP_MODEL     model name for the vip cluster (independent)
 *   TOPIC_ROUTER_BASE_URL      baseUrl for the normal cluster
 *   TOPIC_ROUTER_VIP_BASE_URL  baseUrl for the vip cluster (optional)
 *   TOPIC_ROUTER_VIP_API_KEY   apiKey for the vip cluster (optional; never put keys in config files)
 *
 * apiKey (non-VIP) still comes from the caller (MODEL_API_KEY/LLM_API_KEY/OPENAI_API_KEY).
 */
export declare function resolveClassifierLlmConfig(env: Record<string, string | undefined>, baseApiKey: string): {
    config: LLMConfig;
    cluster: string;
};
export declare function callLLM(messages: ChatMessage[], config: LLMConfig, log: (...args: unknown[]) => void): Promise<string>;
