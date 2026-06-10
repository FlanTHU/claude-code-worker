import type { ChatMessage } from './conversation-store.js';

// Single source of truth for classifier LLM defaults. Every other file must take its
// model/baseUrl from the LLMConfig passed in — do NOT re-hardcode 'xiaomi/...' fallbacks
// elsewhere, or a config/VIP switch in index.ts gets silently overridden downstream.
export const DEFAULT_BASE_URL = 'http://model.mify.ai.srv/v1';
export const DEFAULT_MODEL = 'xiaomi/mimo-v2.5-mit';
const REQUEST_TIMEOUT_MS = 60000;

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
export function resolveClassifierLlmConfig(
  env: Record<string, string | undefined>,
  baseApiKey: string
): { config: LLMConfig; cluster: string } {
  const cluster = (env.TOPIC_ROUTER_CLUSTER || 'normal').toLowerCase();
  const isVip = cluster === 'vip';

  const model = isVip
    ? (env.TOPIC_ROUTER_VIP_MODEL || env.TOPIC_ROUTER_MODEL || DEFAULT_MODEL)
    : (env.TOPIC_ROUTER_MODEL || DEFAULT_MODEL);

  const baseUrl = isVip
    ? (env.TOPIC_ROUTER_VIP_BASE_URL || env.TOPIC_ROUTER_BASE_URL || DEFAULT_BASE_URL)
    : (env.TOPIC_ROUTER_BASE_URL || DEFAULT_BASE_URL);

  const apiKey = isVip
    ? (env.TOPIC_ROUTER_VIP_API_KEY || baseApiKey)
    : baseApiKey;

  return { config: { baseUrl, model, apiKey }, cluster };
}

export async function callLLM(
  messages: ChatMessage[],
  config: LLMConfig,
  log: (...args: unknown[]) => void
): Promise<string> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const model = config.model ?? DEFAULT_MODEL;
  const url = `${baseUrl}/chat/completions`;

  const apiMessages: Array<{ role: string; content: string }> = [];

  if (config.systemPrompt) {
    apiMessages.push({ role: 'system', content: config.systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    apiMessages.push({ role: msg.role, content: msg.content });
  }

  const body = {
    model,
    messages: apiMessages,
    max_tokens: 2048,
    temperature: 0.7,
  };

  log(`[llm] POST ${url} model=${model} messages=${apiMessages.length}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LLM API ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json() as any;
    const msg = data?.choices?.[0]?.message;
    const content = msg?.content || msg?.reasoning_content || '';

    if (!content) {
      log('[llm] WARNING: empty response from LLM');
      return '(无回复)';
    }

    log(`[llm] Response: ${content.length} chars`);
    return content;
  } finally {
    clearTimeout(timer);
  }
}
