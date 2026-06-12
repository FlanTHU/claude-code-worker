/**
 * Commands — handles /topics, /switch, /new, /end commands.
 *
 * These commands are intercepted before the before_dispatch hook
 * and provide the user interface for topic management.
 */
import type { TopicRouterConfig, HookResult } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
import type { FeedbackStore } from './feedback-store.js';
import type { ContextBridge } from './context-bridge.js';
/**
 * Try to handle a slash command. Returns undefined if the message is not a command.
 */
export declare function tryHandleCommand(content: string, registry: TopicRegistry, config: TopicRouterConfig, log: (...args: unknown[]) => void, feedbackStore?: FeedbackStore, contextBridge?: ContextBridge, sessionKey?: string): Promise<HookResult | undefined>;
