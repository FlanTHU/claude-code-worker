/**
 * Type definitions for the Topic Router plugin.
 */
export type TopicStatus = 'active' | 'inactive' | 'ended';
export type ClassifyAction = 'continue' | 'switch' | 'new' | 'passthrough';
export interface TopicEntry {
    label: string;
    displayName: string;
    sessionKey: string;
    status: TopicStatus;
    createdAt: number;
    lastActiveAt: number;
    messageCount: number;
    keywords: string[];
    summary?: string;
}
export interface TopicRegistryData {
    activeSessionKey: string | null;
    topics: Record<string, TopicEntry>;
}
export interface ClassifyResult {
    action: ClassifyAction;
    targetLabel: string | null;
    displayName?: string;
    confidence: number;
    reason: string;
}
export interface TopicRouterConfig {
    enabled: boolean;
    classifier: {
        mode: 'rules' | 'llm' | 'hybrid';
        confidenceThreshold: number;
    };
    maxTopics: number;
    pruneAfterHours: number;
    replyFooter: boolean;
    targetSessionKey: string;
}
export interface HookEvent {
    content: string;
    body: string;
    channel: string;
    sessionKey: string;
    senderId: string;
    isGroup: boolean;
    timestamp: number;
}
export interface HookContext {
    channelId: string;
    accountId: string;
    conversationId: string;
    sessionKey: string;
    senderId: string;
}
export interface HookResult {
    handled: boolean;
    text?: string;
    sessionKey?: string;
}
