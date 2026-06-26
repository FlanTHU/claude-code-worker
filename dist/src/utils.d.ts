/**
 * Check if a session key matches the target pattern.
 * targetSessionKey "agent:main:main" matches any "agent:main:feishu:direct:*"
 * (and the bare "agent:main:main" / "agent:main:main:*" inbound keys), but never
 * matches "agent:main:topic:*" (our own topic sessions), nor group/channel sessions
 * "agent:main:feishu:group:*" / ":channel:*" — topic-router is direct-only.
 */
export declare function isTargetSession(sessionKey: string, targetPattern: string): boolean;
