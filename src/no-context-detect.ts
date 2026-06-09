/**
 * Detect when an agent reply explicitly declares it lacks prior context.
 *
 * Used by the output hook for auto-switch-back: when a message was mis-routed to a
 * freshly auto-created (empty) topic, the agent answers "this is a new session, I
 * have no prior context". Detecting that lets us switch the active topic back to the
 * parent so the user's next message lands in the right place — instead of forcing
 * them to type `/switch <label>` manually.
 *
 * The matcher MUST be narrow: it fires ONLY on an explicit "I have no context"
 * declaration, never on a generic clarifying question. A legitimate new topic also
 * asks clarifying questions; treating those as mis-routes would merge real new topics
 * back into the old one — exactly the topic-collapse failure the runaway valve fixed.
 */

/** Phrases where the agent explicitly states it lacks prior/conversation context. */
const NO_CONTEXT_PATTERNS: RegExp[] = [
  // Chinese — explicit "no previous context / new session / don't know what you refer to"
  /没有(之前|先前|此前|过往|过去)的?(上下文|对话|聊天|对话记录|消息记录|交流)/,
  /没有(你|您)(之前|先前|刚才)(说|提到|讲)/,
  /(这是|这是一个|当前是|目前是)(一个)?(新的?会话|新的?对话|全新的?会话)/,
  /(缺少|缺乏|没有|不具备)(相关|足够的?|必要的?)?(上下文|背景信息|对话历史|历史记录)/,
  /(我|这边)(没有|无法获取|看不到|拿不到)(之前|先前|你之前|你刚才)/,
  /不(知道|清楚|了解)(你|您)(指的?是|说的?是|提到的?是|之前)/,
  /(无法|没办法)(回溯|查看|获取)(之前|先前|历史)的?(对话|消息|记录)/,
  /没有(保留|保存)(之前|先前)的?(对话|上下文|记录)/,
  // English
  /\b(no|don't have|do not have|lack(ing)?)\s+(any\s+)?(prior|previous|earlier)\s+context\b/i,
  /\bthis is a (new|fresh) (session|conversation)\b/i,
  /\bI don'?t have (access to )?(the |any )?(prior|previous|earlier) (conversation|context|messages)\b/i,
  /\bno (access to )?(prior|previous) (conversation|context|history)\b/i,
];

/** True if the text explicitly declares a lack of prior context. */
export function looksLikeNoContext(text: string): boolean {
  if (!text) return false;
  // Cap scan length: the declaration, if present, is at the start of the reply.
  const head = text.slice(0, 600);
  return NO_CONTEXT_PATTERNS.some(re => re.test(head));
}

/**
 * Pull the assistant's reply text out of the various output-hook event shapes
 * (llm_output / agent_end / reply). Returns '' if none found.
 */
export function extractAssistantText(event: any): string {
  if (!event || typeof event !== 'object') return '';

  if (typeof event.lastAssistant === 'string' && event.lastAssistant) {
    return event.lastAssistant;
  }

  if (Array.isArray(event.assistantTexts)) {
    const joined = event.assistantTexts.filter((t: any) => typeof t === 'string').join('\n');
    if (joined) return joined;
  }

  if (Array.isArray(event.messages)) {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const msg = event.messages[i];
      if (msg?.role !== 'assistant') continue;
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        const textPart = msg.content.find((p: any) => p?.type === 'text' && typeof p.text === 'string');
        if (textPart) return textPart.text;
      }
    }
  }

  if (typeof event.text === 'string' && event.text) return event.text;
  if (typeof event.content === 'string' && event.content) return event.content;

  return '';
}
