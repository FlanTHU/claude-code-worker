/**
 * Check if a session key matches the target pattern.
 * targetSessionKey "agent:main:main" matches any "agent:main:feishu:direct:*"
 * but never matches "agent:main:topic:*" (our own topic sessions).
 */
export function isTargetSession(sessionKey: string, targetPattern: string): boolean {
  if (!sessionKey) return false;

  // Never intercept our own topic sessions
  if (sessionKey.includes(':topic:')) return false;

  if (targetPattern === 'agent:main:main') {
    return sessionKey.startsWith('agent:main:');
  }

  return sessionKey === targetPattern;
}
