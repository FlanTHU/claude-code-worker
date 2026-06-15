import type { TopicRouterConfig, HookResult, LastRouteInfo } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
import { classify, generateTopicLabel, determineUIStrategy } from './classifier.js';
import { isTargetSession } from './utils.js';
import { tryHandleCommand } from './commands.js';
import type { LLMConfig } from './llm-client.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from './llm-client.js';
import type { FeedbackStore } from './feedback-store.js';
import type { ContextBridge } from './context-bridge.js';

const RECENT_MESSAGE_WINDOW = 5;
const MAX_TRACKED_SESSIONS = 50;

const recentMessagesBySession = new Map<string, string[]>();

// ── Per-session serialization queue (concurrency guard) ──
// TopicRegistry does reload→mutate→save with no lock, and classify() can await an LLM
// call for up to ~20s. When a user fires several messages in quick succession, two
// async handler runs interleave: activeSessionKey races (last-writer-wins), and the
// module-level recentMessages / feedbackStore.lastRoute get clobbered — messages route
// to the wrong topic and self-learning feedback links to the wrong route. The gateway
// serializes per-session AFTER the session is chosen, but topic classification happens
// BEFORE that, outside its lock. We add our own per-session FIFO: each session key holds
// a promise chain; a new message waits for the previous one's classify+route to finish.
// Keyed on the INBOUND sessionKey (the original key, stable per conversation — routing
// rewrites it only in the return value, after we're done). Different sessions don't block
// each other; only same-session back-to-back messages serialize.
const handlerQueueBySession = new Map<string, Promise<unknown>>();

// Track recently auto-created topics for "switch back" hints
export interface RecentAutoNew {
  newLabel: string;
  previousLabel: string;
  previousDisplayName: string;
  // The INBOUND (pre-routing) session key of the message that triggered the auto-new.
  // The output hook keys autoNew on the routed topic session key, but a resend arrives
  // on this inbound key — we need it to arm pendingForceContinue so the resend matches.
  originalSessionKey: string;
  createdAt: number;
}
const recentAutoNewBySession = new Map<string, RecentAutoNew>();

export function getRecentAutoNew(sessionKey: string): RecentAutoNew | null {
  const entry = recentAutoNewBySession.get(sessionKey);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > 5 * 60 * 1000) {
    recentAutoNewBySession.delete(sessionKey);
    return null;
  }
  return entry;
}

export function clearRecentAutoNew(sessionKey: string): void {
  recentAutoNewBySession.delete(sessionKey);
}

// ── Pending force-continue (the "resend lands in the parent topic" promise) ──
// When the output hook auto-switches active back to a parent topic after a no-context
// reply, it tells the user to "just resend". But classify() re-decides from scratch and,
// on the identical resent text, re-judges it `new` — spawning yet another topic, so the
// promise never holds. We bridge that gap: arming a pending entry keyed on the inbound
// session key forces the NEXT message on that key to continue into the parent topic,
// bypassing the classifier entirely. One-shot + short TTL so it only catches the immediate
// resend and never swallows a genuinely different next message.
interface PendingForceContinue {
  label: string;
  armedAt: number;
}
const PENDING_FORCE_CONTINUE_TTL = 2 * 60 * 1000; // 2 minutes
const pendingForceContinueBySession = new Map<string, PendingForceContinue>();

export function setPendingForceContinue(sessionKey: string, label: string): void {
  if (!sessionKey || !label) return;
  pendingForceContinueBySession.set(sessionKey, { label, armedAt: Date.now() });
}

/** Consume the pending force-continue for this session (one-shot). Returns the target
 * label if armed and unexpired, else null. Always clears the entry when present. */
function takePendingForceContinue(sessionKey: string): string | null {
  const entry = pendingForceContinueBySession.get(sessionKey);
  if (!entry) return null;
  pendingForceContinueBySession.delete(sessionKey);
  if (Date.now() - entry.armedAt > PENDING_FORCE_CONTINUE_TTL) return null;
  return entry.label;
}

const TOPIC_FOOTER_REGEX = /📌\s*话题[:：]\s*(.+?)(?:\s*$|\n)/;

function resolveTopicFromQuote(
  quotedContent: string,
  registry: TopicRegistry,
  log: (...args: unknown[]) => void
): string | null {
  if (!quotedContent) return null;

  const match = quotedContent.match(TOPIC_FOOTER_REGEX);
  if (!match) return null;

  const footerValue = match[1].trim();
  log(`[hook-handler] Found topic footer "${footerValue}" in quoted message`);

  if (registry.get(footerValue)) return footerValue;

  const allTopics = registry.getAll();
  const byDisplayName = allTopics.find(t => t.displayName === footerValue);
  if (byDisplayName) return byDisplayName.label;

  const byPrefix = allTopics.find(t =>
    footerValue.endsWith('…') && t.displayName.startsWith(footerValue.slice(0, -1))
  );
  if (byPrefix) return byPrefix.label;

  return null;
}

async function extractKeywords(
  content: string,
  existingKeywords: string[],
  llmConfig: LLMConfig | undefined,
  log: (...args: unknown[]) => void
): Promise<string[]> {
  if (!llmConfig?.apiKey) return [];

  const baseUrl = llmConfig.baseUrl ?? DEFAULT_BASE_URL;
  const model = llmConfig.model ?? DEFAULT_MODEL;
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model,
    messages: [
      {
        role: 'system',
        content: '提取3-5个关键词，逗号分隔，只返回关键词。要求：名词/术语为主，2-6字，不要"帮我""请问"等虚词。',
      },
      { role: 'user', content: content.slice(0, 200) },
    ],
    max_tokens: 2000,
    temperature: 0.1,
  };

  const controller = new AbortController();
  // mimo is a reasoning model: naming/keyword calls routinely take ~10s, so an
  // 8s timeout aborted every request → silent fallback. Async fire-and-forget,
  // doesn't block the user reply, so a generous 20s is safe.
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (llmConfig.apiKey) headers['Authorization'] = `Bearer ${llmConfig.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) return [];

    const data = await response.json() as any;
    const msg = data?.choices?.[0]?.message;
    const contentText = (msg?.content ?? '').trim();
    const reasoningText = (msg?.reasoning_content ?? '').trim();

    // mimo reasoning model: content may be empty, answer buried in reasoning_content's last line
    const raw = contentText || reasoningText;
    if (!raw) return [];

    // Try to find comma-separated keywords in the last non-empty line
    const lines = raw.split('\n').filter((l: string) => l.trim());
    const answer = lines[lines.length - 1]?.trim() ?? '';

    const keywords = answer
      .split(/[,，、\s]+/)
      .map((k: string) => k.trim().replace(/^["""]+|["""]+$/g, ''))
      .filter((k: string) => k.length >= 2 && k.length <= 10 && !existingKeywords.includes(k));

    if (keywords.length > 0) {
      log(`[hook-handler] LLM keywords (from ${contentText ? 'content' : 'reasoning'}): ${keywords.join(', ')}`);
      return keywords.slice(0, 5);
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Strip leading filler/politeness so the truncated fallback name starts at the
// real subject. Without this, "帮我查一下星巴克的热量" truncates to "帮我查一下星巴…"
// — all filler, no signal. Only a leading run of these prefixes is peeled.
const FALLBACK_FILLER_PREFIXES = [
  '帮我查一下', '帮我查查', '帮我查', '帮我看一下', '帮我看看', '帮我搜一下',
  '帮我搜', '帮我找一下', '帮我找', '帮忙查一下', '帮忙', '帮我', '请帮我',
  '请问一下', '请问', '我想问一下', '我想问', '想问一下', '我想知道', '想知道',
  '我想了解', '想了解', '麻烦', '请', '查一下', '查查', '看一下', '搜一下',
];

// Structural prefixes that aren't real content — eval round markers ("【第2轮】",
// "第2轮"), leading 【…】 brackets. The fallback name shows when the async LLM
// namer hasn't returned yet (or timed out); without stripping these, a fast burst
// of eval messages leaves names like "【第1轮】今…". Applied before filler peeling.
function stripStructuralPrefix(s: string): string {
  let t = s;
  // 【第N轮】 / 第N轮 round markers (Arabic or Chinese numerals).
  t = t.replace(/^【\s*第?\s*[0-9一二三四五六七八九十]+\s*轮?\s*】/, '');
  t = t.replace(/^第\s*[0-9一二三四五六七八九十]+\s*轮[:：，,、\s]*/, '');
  // Any other short leading 【…】 bracket segment.
  t = t.replace(/^【[^】]{0,12}】/, '');
  return t.trim();
}

export function deriveDisplayNameFallback(content: string): string {
  let trimmed = content.trim().replace(/\s+/g, ' ');
  trimmed = stripStructuralPrefix(trimmed);
  // Peel leading filler prefixes (repeatedly, e.g. "请帮我查一下…").
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of FALLBACK_FILLER_PREFIXES) {
      if (trimmed.startsWith(p) && trimmed.length > p.length) {
        trimmed = trimmed.slice(p.length).trim();
        changed = true;
        break;
      }
    }
  }
  // Match the LLM namer's "约2-10字符" target so the fallback reads like a real
  // short title rather than a clipped sentence.
  const maxLen = 10;
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen) + '…';
}

async function deriveDisplayName(
  content: string,
  llmConfig: LLMConfig | undefined,
  log: (...args: unknown[]) => void
): Promise<string> {
  const fallback = deriveDisplayNameFallback(content);

  if (!llmConfig?.baseUrl && !llmConfig?.apiKey) return fallback;

  const baseUrl = llmConfig.baseUrl ?? DEFAULT_BASE_URL;
  const model = llmConfig.model ?? DEFAULT_MODEL;
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model,
    messages: [
      {
        // mimo 是推理模型，若把用户内容直接当 user 消息会被当成"提问"去作答而非起名。
        // 必须明确"命名器"角色，并把内容包成"为以下文本起标题"，强约束只输出标题。
        role: 'system',
        content: '你是话题命名器。为用户文本起一个简短标题（约2-10字符，越简洁越好），概括其真实意图，让人一眼看懂这在聊什么。专有名词——人名、账号、ID、产品名、代号、英文、数字等——按原文照抄，不要音译、翻译或改写成读音相近的汉字。略过与主题无关的措辞（如轮次标记、客套和指令性虚词）。只输出标题本身，不加解释和标点。',
      },
      { role: 'user', content: `为以下文本起标题：「${content.slice(0, 100)}」` },
    ],
    max_tokens: 2000,
    temperature: 0.1,
  };

  const controller = new AbortController();
  // mimo is a reasoning model: naming/keyword calls routinely take ~10s, so an
  // 8s timeout aborted every request → silent fallback. Async fire-and-forget,
  // doesn't block the user reply, so a generous 20s is safe.
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (llmConfig.apiKey) headers['Authorization'] = `Bearer ${llmConfig.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) return fallback;

    const data = await response.json() as any;
    const msg = data?.choices?.[0]?.message;
    const contentText = (msg?.content ?? '').trim();
    const reasoningText = (msg?.reasoning_content ?? '').trim();
    if (!contentText && !reasoningText) return fallback;

    const clean = (s: string): string =>
      s.trim().replace(/^["“”「」『』\s]+|["“”「」『』\s]+$/g, '');

    // content 优先：新 prompt 下 content 就是干净标题（可能含首尾引号/书名号）。
    // 仅当 content 为空（mimo 偶发把答案放进 reasoning）才回退到 reasoning 末行。
    let answer = clean(contentText);
    let from = 'content';
    if (!answer) {
      const lines = reasoningText.split('\n').filter((l: string) => l.trim());
      answer = clean(lines[lines.length - 1] ?? '');
      from = 'reasoning';
    }

    if (answer && answer.length <= 12 && answer.length >= 2) {
      log(`[hook-handler] Generated display name: "${answer}" (from ${from})`);
      return answer;
    }
    log(`[hook-handler] Display name rejected (len ${answer.length}), using fallback "${fallback}"`);
    return fallback;
  } catch (err) {
    // Surface why naming fell back (e.g. AbortError on timeout) instead of silently截断.
    log(`[hook-handler] deriveDisplayName failed (${(err as Error)?.name ?? err}), using fallback "${fallback}"`);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Session routing approach:
 * - Classify message → determine topic
 * - Mutate ctx.sessionKey to route to topic-isolated session
 * - Return undefined (not handled) → gateway processes with full tools/skills
 * - Footer added via separate output hook
 */
interface HandleParams {
  event: any;
  ctx: any;
  registry: TopicRegistry;
  config: TopicRouterConfig;
  stateDir: string;
  classifierLlmConfig: LLMConfig;
  log: (...args: unknown[]) => void;
  feedbackStore?: FeedbackStore;
  contextBridge?: ContextBridge;
}

/**
 * Public entry point. Serializes handling per inbound session key so concurrent
 * messages from the same conversation never interleave their classify→route→state
 * mutations (see handlerQueueBySession comment). Different sessions run in parallel.
 */
export async function handleBeforeDispatch(params: HandleParams): Promise<HookResult | undefined> {
  const queueKey: string = params.ctx?.sessionKey || params.event?.sessionKey || '';

  // No usable key → can't serialize meaningfully; run directly (rare, e.g. malformed event).
  if (!queueKey) {
    return handleBeforeDispatchInner(params);
  }

  const prev = handlerQueueBySession.get(queueKey) ?? Promise.resolve();
  // Chain after the previous run regardless of how it settled, so one message's failure
  // never breaks the chain for the next. `tail` never rejects → safe to chain onto and
  // safe to store as the map value.
  const run = prev.then(
    () => handleBeforeDispatchInner(params),
    () => handleBeforeDispatchInner(params)
  );
  const tail = run.catch(() => undefined);
  handlerQueueBySession.set(queueKey, tail);

  // Bound the map: once this run settles, drop the entry if it's still the latest (no
  // newer message has chained on and overwritten it).
  tail.finally(() => {
    if (handlerQueueBySession.get(queueKey) === tail) {
      handlerQueueBySession.delete(queueKey);
    }
  });

  // Return the real result/rejection to the caller, distinct from the never-rejecting tail.
  return run;
}

async function handleBeforeDispatchInner(params: HandleParams): Promise<HookResult | undefined> {
  const { event, ctx, registry, config, classifierLlmConfig, log, feedbackStore, contextBridge } = params;

  const content: string = event.cleanedBody || event.content || event.body || '';
  const sessionKey: string = ctx?.sessionKey || event.sessionKey || '';

  const quotedContent: string = event.quotedMessage || event.quotedContent
    || event.replyContent || event.quote || event.parentContent
    || event.replyText || event.quoteText
    || event.reply?.content || event.reply?.text || event.reply?.body
    || '';

  if (!quotedContent) {
    const allKeys = Object.keys(event);
    const replyLike = allKeys.filter(k =>
      /quote|reply|parent|ref|thread|origin/i.test(k)
    );
    if (replyLike.length > 0) {
      log(`[hook-handler] Potential quote fields found but empty: ${replyLike.map(k => `${k}=${JSON.stringify(event[k])?.slice(0, 100)}`).join(', ')}`);
    }
  }

  log(`[hook-handler] content="${content.slice(0, 50)}" sessionKey="${sessionKey}" hasQuote=${!!quotedContent}`);

  if (!isTargetSession(sessionKey, config.targetSessionKey)) {
    return undefined;
  }

  if (!content || content.trim().length === 0) {
    return undefined;
  }

  const trimmed = content.trim();

  // Commands are handled directly (they return text, no routing needed)
  // /topic-router is handled by registerCommand, skip routing for it
  if (/^\/topic-router\b/i.test(trimmed)) {
    return undefined;
  }

  // Gateway-native commands (/new, /reset, /clear) must be passed through untouched.
  // They are NOT plugin commands, but if we don't short-circuit here they fall through
  // to the classifier, get judged as a brand-new topic, and the command text itself
  // ("/NEW") is hashed into a junk topic (label like "vnxt", displayName "/NEW") that
  // pollutes /topics — while the gateway separately resets the native session. We must
  // NOT route or create a topic for these: return undefined so the gateway handles them.
  // (newtopic/endall must be matched BEFORE this guard so "new" doesn't swallow them.)
  if (/^\/(new|reset|clear)\b/i.test(trimmed)) {
    log(`[hook-handler] Gateway-native command "${trimmed.split(/\s/)[0]}" — passthrough, not routing/creating a topic`);
    return undefined;
  }

  if (/^\/(topics|switch|newtopic|endall|end)\b/i.test(trimmed)) {
    const cmdResult = await tryHandleCommand(content, registry, config, log, feedbackStore, contextBridge, sessionKey);
    if (cmdResult) return cmdResult;
    return undefined;
  }

  const quotedTopicLabel = resolveTopicFromQuote(quotedContent, registry, log);
  const recentMessages = recentMessagesBySession.get(sessionKey) ?? [];

  // Force-continue: a prior turn switched active back to a parent topic and told the user
  // to resend (after an auto-new misroute, or a manual /switch). The classifier would
  // re-judge the identical resent text `new` again — or L1 keywords would pull it into the
  // mis-created topic that already learned its words — so honor the one-shot pending entry
  // and continue into the parent, bypassing classification. Quoted messages (explicit user
  // intent) still take precedence and are handled first.
  const forcedLabel = quotedTopicLabel ? null : takePendingForceContinue(sessionKey);

  let result;
  if (quotedTopicLabel) {
    const activeTopic = registry.getActive();
    const isSwitching = activeTopic && activeTopic.label !== quotedTopicLabel;
    result = {
      action: (isSwitching ? 'switch' : 'continue') as 'switch' | 'continue',
      targetLabel: quotedTopicLabel,
      confidence: 0.95,
      reason: `Quoted message belongs to topic "${quotedTopicLabel}"`,
    };
    log(`[hook-handler] Routed via quoted message to topic "${quotedTopicLabel}" (action=${result.action})`);
  } else if (forcedLabel && registry.get(forcedLabel)) {
    result = {
      action: 'continue' as const,
      targetLabel: forcedLabel,
      confidence: 0.99,
      reason: `pending-force-continue: resend after switch-back to "${forcedLabel}"`,
    };
    log(`[hook-handler] Force-continue to "${forcedLabel}" (pending resend), bypassing classifier`);
  } else {
    // V4: inject feedback-store adaptive thresholds so the classifier uses
    // feedback-driven values (confidence / saturation) instead of hardcoded defaults.
    const classifyConfig = (feedbackStore && config.v4?.feedback?.enabled)
      ? { ...config, _adaptiveThresholds: feedbackStore.getThresholds() }
      : config;
    result = await classify(content, recentMessages, registry, classifyConfig, classifierLlmConfig, log);
  }

  log(`Classification: action=${result.action} label=${result.targetLabel} confidence=${result.confidence} reason=${result.reason}`);

  // ── V4: UI Strategy ──
  const thresholds = feedbackStore?.getThresholds();
  if (thresholds && config.v4?.hints?.enabled) {
    const uiStrategy = determineUIStrategy(result, thresholds);
    result.uiStrategy = uiStrategy;

    if (uiStrategy === 'confirm' && (result.action === 'new' || result.action === 'switch')) {
      log(`[v4-hints] Low confidence (${result.confidence}), showing confirm hint instead of routing`);
      const targetDesc = result.action === 'new' ? '新话题' : `话题「${result.targetLabel}」`;
      return {
        handled: true,
        text: `🤔 这条消息可能属于${targetDesc}。\n→ /newtopic 创建新话题 | 继续发消息留在当前话题`,
      };
    }
  }

  // ── V4: Track route for feedback detection ──
  if (feedbackStore && config.v4?.feedback?.enabled && result.action !== 'passthrough') {
    // Positive signal: the user is continuing in the topic they were routed to
    // LAST time. Must read the PREVIOUS route (before overwriting it) — reading
    // after setLastRoute would compare the current route against itself and fire
    // on every continue, inflating correctRoutes and starving errorRate.
    const prevRoute = feedbackStore.getLastRoute(sessionKey);
    if (prevRoute && result.action === 'continue' && result.targetLabel === prevRoute.topic) {
      const elapsed = Date.now() - prevRoute.timestamp;
      if (elapsed < 300_000) {
        feedbackStore.record('continued_in_routed_topic', {
          fromTopic: prevRoute.topic,
          toTopic: result.targetLabel,
          classifierLayer: prevRoute.layer,
          confidence: prevRoute.confidence,
          messageSnippet: content.slice(0, 50),
        });
      }
    }

    // Now record THIS route as the new "last route" for next time.
    const lastRoute: LastRouteInfo = {
      timestamp: Date.now(),
      topic: result.targetLabel ?? '',
      action: result.action,
      confidence: result.confidence,
      layer: result.layer ?? result.reason.split(':')[0] ?? 'unknown',
    };
    feedbackStore.setLastRoute(sessionKey, lastRoute);
  }

  const updated = [...recentMessages, content].slice(-RECENT_MESSAGE_WINDOW);
  recentMessagesBySession.set(sessionKey, updated);

  if (recentMessagesBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = recentMessagesBySession.keys().next().value;
    if (oldest) recentMessagesBySession.delete(oldest);
  }

  let topicLabel: string | null = null;

  switch (result.action) {
    case 'passthrough':
      return undefined;

    case 'continue': {
      if (!result.targetLabel) return undefined;
      // Use the entry's real label: a target that was ended is not revived in
      // place — getOrCreate spawns a fresh sibling with a new label/sessionKey.
      const entry = registry.getOrCreate(result.targetLabel);
      topicLabel = entry.label;
      break;
    }

    case 'switch': {
      if (!result.targetLabel) return undefined;
      const found = registry.get(result.targetLabel) ?? registry.findByDisplayName(result.targetLabel);
      if (!found) {
        log(`Switch target "${result.targetLabel}" not found, passthrough`);
        return undefined;
      }
      const activated = registry.setActive(found.label);
      if (!activated) return undefined;
      topicLabel = activated.label;
      break;
    }

    case 'new': {
      const requestedLabel = result.targetLabel ?? generateTopicLabel(content);
      const fallbackName = deriveDisplayNameFallback(content);
      const activeTopic = registry.getActive();

      // Create first so we use the real label (an ended same-name topic is not
      // revived — a fresh sibling label/sessionKey is allocated instead).
      const created = registry.getOrCreate(requestedLabel, fallbackName);
      topicLabel = created.label;
      registry.setActive(created.label);

      // V4: Soft Fork — carry context from parent topic
      if (contextBridge && config.v4?.softFork?.enabled && activeTopic) {
        try {
          const mergeMinutes = config.v4.softFork.mergeWindowMinutes ?? 5;
          const recentMsgs = recentMessagesBySession.get(sessionKey) ?? [];
          const summary = recentMsgs.slice(-5).join(' | ').slice(0, 200);
          contextBridge.createFork(activeTopic.label, created.label, summary, mergeMinutes);
          log(`[v4-soft-fork] Created fork: ${activeTopic.label} → ${created.label} (merge window ${mergeMinutes}min)`);
        } catch (err) {
          log(`[v4-soft-fork] Failed to create fork:`, err);
        }
      }

      // Track for "switch back" hint in output footer
      if (activeTopic) {
        recentAutoNewBySession.set(created.sessionKey, {
          newLabel: created.label,
          previousLabel: activeTopic.label,
          previousDisplayName: activeTopic.displayName,
          originalSessionKey: sessionKey,
          createdAt: Date.now(),
        });
      }

      deriveDisplayName(content, classifierLlmConfig, log).then(name => {
        if (name !== fallbackName) {
          registry.updateDisplayName(created.label, name);
        }
      }).catch(() => {});
      break;
    }

    default:
      return undefined;
  }

  if (!topicLabel) return undefined;

  // ── Learn keywords: rule-based instant + LLM async refinement ──
  // Skip learning on low-confidence sticky "continue": those are weak fallbacks,
  // not real topic matches. Learning from them pollutes the topic with unrelated
  // keywords (e.g. a weather question's "北京/晚上/打球" written into an end-of-day
  // 端午 topic), which then makes every later message falsely stick — a snowball.
  const isWeakStickyContinue = result.action === 'continue'
    && (result.confidence < 0.65 || /sticky/i.test(result.reason));
  if (!isWeakStickyContinue) {
    registry.learnKeywords(topicLabel, content);

    const existingTopic = registry.get(topicLabel);
    const existingKw = existingTopic?.keywords ?? [];
    extractKeywords(content, existingKw, classifierLlmConfig, log).then(keywords => {
      if (keywords.length > 0) {
        registry.setKeywords(topicLabel!, keywords);
      }
    }).catch(() => {});
  } else {
    log(`[hook-handler] Skip keyword learning (weak sticky continue, conf=${result.confidence})`);
  }

  // ── Session routing via before_dispatch sessionKey field ──
  const topic = registry.get(topicLabel);
  if (topic) {
    const newSessionKey = topic.sessionKey;
    log(`[hook-handler] Routing to topic session: ${sessionKey} → ${newSessionKey}`);

    return {
      handled: false,
      sessionKey: newSessionKey,
    };
  }

  return undefined;
}
