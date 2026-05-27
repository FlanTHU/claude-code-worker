import type { ChatMessage } from './conversation-store.js';
export interface LLMConfig {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    systemPrompt?: string;
}
export declare function callLLM(messages: ChatMessage[], config: LLMConfig, log: (...args: unknown[]) => void): Promise<string>;
