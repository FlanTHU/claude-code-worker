/**
 * Check if a session key matches the target pattern.
 * targetSessionKey "agent:main:main" matches any "agent:main:feishu:direct:*"
 * but never matches "agent:main:topic:*" (our own topic sessions).
 */
export declare function isTargetSession(sessionKey: string, targetPattern: string): boolean;
