import type { ChatMessage } from './conversation-store.js';

const DEFAULT_BASE_URL = 'http://model.mify.ai.srv/v1';
const DEFAULT_MODEL = 'xiaomi/mimo-v2.5-pro-mit';
const REQUEST_TIMEOUT_MS = 60000;

export interface LLMConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
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
