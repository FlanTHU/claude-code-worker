/**
 * Check if a session key matches the target pattern.
 * targetSessionKey "agent:main:main" matches any "agent:main:feishu:direct:*"
 * (and the bare "agent:main:main" / "agent:main:main:*" inbound keys), but never
 * matches "agent:main:topic:*" (our own topic sessions), nor group/channel sessions
 * "agent:main:feishu:group:*" / ":channel:*" — topic-router is direct-only.
 */
export function isTargetSession(sessionKey: string, targetPattern: string): boolean {
  if (!sessionKey) return false;

  // Never intercept our own topic sessions
  if (sessionKey.includes(':topic:')) return false;

  // Group/channel sessions never participate in topic routing: topic-router is
  // private-message (direct) only. Without this, a group-chat interaction would
  // create topics and switch the global active pointer, polluting the user's
  // direct-message topics (observed 2026-06-26: a group reply switched active to
  // an unrelated topic, then a follow-up in DMs was routed there).
  if (sessionKey.includes(':group:') || sessionKey.includes(':channel:')) return false;

  if (targetPattern === 'agent:main:main') {
    return sessionKey.startsWith('agent:main:');
  }

  return sessionKey === targetPattern;
}
