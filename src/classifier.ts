/**
 * Topic Classifier — hybrid rules + LLM approach.
 *
 * Strategy:
 *   L0: Explicit commands (/switch, /new, /end) — always rules
 *   L1: High-confidence rules (keyword 2+, continuation signals, short messages)
 *   L2: LLM fallback for ambiguous cases
 */

import type { ClassifyResult, TopicEntry, TopicRouterConfig, AdaptiveThresholds, UIStrategy } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
import { STOPWORDS } from './topic-registry.js';
import type { LLMConfig } from './llm-client.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from './llm-client.js';

/**
 * Does message `msg` (already lowercased) overlap topic keyword `kw`?
 * A keyword counts only if it's NOT a high-frequency stop/place/time word —
 * those (北京/晚上/本周…) recur across unrelated topics and cause false sticking.
 */
function kwHit(kw: string, msg: string): boolean {
  const k = kw.toLowerCase();
  if (STOPWORDS.has(k)) return false;
  return msg.includes(k);
}

export interface ClassifyOptions {
  content: string;
  recentMessages: string[];
  registry: TopicRegistry;
  config: TopicRouterConfig;
  llmConfig?: LLMConfig;
  log?: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// L0: Explicit command detection
// ---------------------------------------------------------------------------

const COMMAND_PATTERNS: Array<{ regex: RegExp; action: ClassifyResult['action'] }> = [
  { regex: /^\/switch\s+(\S+)/i, action: 'switch' },
  { regex: /^\/newtopic(?:\s+(.*))?$/i, action: 'new' },
  { regex: /^\/end(?:\s+(.*))?$/i, action: 'passthrough' },
];

export function parseExplicitCommand(content: string): ClassifyResult | null {
  const trimmed = content.trim();
  for (const { regex, action } of COMMAND_PATTERNS) {
    const match = trimmed.match(regex);
    if (match) {
      const label = match[1]?.trim() || null;
      return {
        action,
        targetLabel: label,
        confidence: 1.0,
        reason: `Explicit command: ${trimmed.split(/\s/)[0]}`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule-based helpers
// ---------------------------------------------------------------------------

const MIN_KEYWORD_MATCHES = 2;

export function matchKeywords(
  content: string,
  topics: TopicEntry[]
): ClassifyResult | null {
  if (topics.length === 0) return null;

  const normalized = content.toLowerCase();
  let best: ClassifyResult | null = null;

  for (const topic of topics) {
    if (topic.keywords.length === 0) continue;

    const matchedCount = topic.keywords.filter(kw =>
      kwHit(kw, normalized)
    ).length;

    if (matchedCount < MIN_KEYWORD_MATCHES) continue;

    const ratio = matchedCount / Math.max(topic.keywords.length, 1);
    const confidence = Math.min(0.4 + ratio * 0.4 + matchedCount * 0.05, 0.9);

    if (!best || confidence > best.confidence) {
      best = {
        action: 'switch',
        targetLabel: topic.label,
        confidence,
        reason: `Keyword match: ${matchedCount} keyword(s) hit "${topic.label}"`,
      };
    }
  }

  return best;
}

/** Words that signal topic continuation (must be sentence starters). */
const CONTINUATION_SIGNALS = [
  '那这', '那这个', '这个怎么', '那怎么', '那个怎么',
  '接着', '继续', '然后呢', '还有呢', '再说说',
  '而且', '并且', '补充一下',
  '是不是', '能不能', '会不会', '有没有', '可不可以',
  '具体', '详细', '举个例', '比如',
  '那如果', '那要是', '那比如', '那能',
  'what about', 'how about', 'and then', 'also',
  'is it', 'does it', 'can it', 'will it',
  'what if', 'could you',
];

/** Words that signal topic switch. */
const SWITCH_SIGNALS = [
  '换个话题', '换一个话题', '另外一个问题', '回到之前的话题',
  '刚才那个话题', '之前那个话题', '上次那个话题',
  'let me ask about', 'switching topics',
  'going back to', 'about that earlier',
];

/**
 * Phrases that explicitly REFER BACK to earlier conversation ("之前说的", "刚才那个",
 * "你提到的"). Unlike CONTINUATION_SIGNALS these may appear anywhere in the sentence,
 * so they're matched with `includes`. A message referring to prior context almost
 * never starts a genuinely new topic — without this, the classifier mis-routes such
 * follow-ups to a fresh (empty) session, and the agent replies "I have no prior
 * context" (the soft-fork gap). Pulling them to `continue` removes that failure.
 *
 * MUST be compound phrases, never bare "之前"/"那个": a bare token false-matches real
 * new topics ("帮我查之前武汉的天气"), which would re-introduce the topic-collapse the
 * runaway valve fixed. Compound phrases only fire on true back-references.
 */
const REFERENCE_SIGNALS = [
  '之前说的', '之前提到', '之前讲的', '之前那个', '之前的那', '之前聊的', '之前说过',
  '刚才说的', '刚才提到', '刚才那个', '刚才讲的', '刚说的', '刚提到', '刚才的那',
  '你刚才', '你刚说', '你说的那', '你提到的', '你提到过', '你刚提',
  '上面说的', '上面提到', '上面那个', '前面说的', '前面提到', '前面那个',
  '我们刚才', '我们之前', '咱们刚才', '咱们之前',
  '接着上面', '接着刚才', '顺着刚才', '顺着上面',
  '上文', '前文',
  'you mentioned', 'you said', 'as you said', 'like you said',
  'the one you', 'that you mentioned', 'continuing from', 'following up on',
  'earlier you',
];

export function detectContinuation(
  content: string,
  _recentMessages: string[],
  activeTopic: TopicEntry | null
): ClassifyResult | null {
  if (!activeTopic) return null;

  const normalized = content.toLowerCase().trim();

  const hasSwitchSignal = SWITCH_SIGNALS.some(s => normalized.includes(s.toLowerCase()));
  if (hasSwitchSignal) return null;

  const hasContinuationSignal = CONTINUATION_SIGNALS.some(s =>
    normalized.startsWith(s.toLowerCase())
  );

  if (hasContinuationSignal) {
    return {
      action: 'continue',
      targetLabel: activeTopic.label,
      confidence: 0.85,
      reason: `Continuation signal detected, staying on "${activeTopic.label}"`,
    };
  }

  // Back-reference phrases anywhere in the message → continuation. Confidence kept
  // at the same 0.85 as a leading continuation signal (a back-reference is an equally
  // strong continuity cue) so it stays ≥ the adaptive threshold ceiling (0.85) and
  // the classifier returns here (L1), never reaching the auto-new rules in L1.5.
  const hasReferenceSignal = REFERENCE_SIGNALS.some(s => normalized.includes(s.toLowerCase()));
  if (hasReferenceSignal) {
    return {
      action: 'continue',
      targetLabel: activeTopic.label,
      confidence: 0.85,
      reason: `Back-reference to prior context, staying on "${activeTopic.label}"`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// LLM-based classification (with circuit breaker)
// ---------------------------------------------------------------------------

let llmFailCount = 0;
let llmCircuitOpenUntil = 0;
const LLM_CIRCUIT_THRESHOLD = 3;
const LLM_CIRCUIT_COOLDOWN = 60_000;

export function isLLMCircuitOpen(): boolean {
  if (Date.now() < llmCircuitOpenUntil) return true;
  if (llmCircuitOpenUntil > 0 && Date.now() >= llmCircuitOpenUntil) {
    llmFailCount = 0;
    llmCircuitOpenUntil = 0;
  }
  return false;
}

function recordLLMFailure(): void {
  llmFailCount++;
  if (llmFailCount >= LLM_CIRCUIT_THRESHOLD) {
    llmCircuitOpenUntil = Date.now() + LLM_CIRCUIT_COOLDOWN;
  }
}

function recordLLMSuccess(): void {
  llmFailCount = 0;
  llmCircuitOpenUntil = 0;
}

const CLASSIFY_SYSTEM_PROMPT = `话题分类器。判断消息归属。continue=属于当前话题，switch=属于另一个已有话题，new=与所有已有话题都无关。
注意：一条消息即便字面上是独立的祈使句（如"搜一下张三""读今天日程"），也可能是当前话题这个多步任务链里的中间步骤（如"搜张三"是为后面写日报而查人）。判断时结合最近消息看它是不是在为当前话题服务，是则 continue，不要因为它单独看像个新请求就判 new。
不确定选continue。只返回JSON：{"action":"continue|switch|new","label":"话题label或null","reason":"原因"}`;

async function classifyWithLLM(
  content: string,
  activeTopic: TopicEntry | null,
  allTopics: TopicEntry[],
  recentMessages: string[],
  llmConfig: LLMConfig,
  log: (...args: unknown[]) => void
): Promise<ClassifyResult | null> {
  const baseUrl = llmConfig.baseUrl ?? DEFAULT_BASE_URL;
  const model = llmConfig.model ?? DEFAULT_MODEL;
  const url = `${baseUrl}/chat/completions`;

  const topicSummary = allTopics.map(t => {
    const isActive = t.label === activeTopic?.label ? ' [当前活跃]' : '';
    const kws = t.keywords.slice(0, 8).join(', ');
    return `- ${t.label} (${t.displayName})${isActive}: 关键词=[${kws}], ${t.messageCount}条消息`;
  }).join('\n');

  // Feed the full recent-message window (hook-handler tracks 5) with a wider per-line
  // cap. The old slice(-3)/60-char truncation starved the LLM of the task-chain context
  // needed to recognize an isolated-looking step ("搜张三") as part of the active topic,
  // causing multi-step task chains to be over-split (run_027 regression).
  const recentCtx = recentMessages.length > 0
    ? `\n最近消息（当前话题 "${activeTopic?.label ?? '无'}"，时间从旧到新）:\n${recentMessages.map(m => `  - ${m.slice(0, 120)}`).join('\n')}`
    : '';

  const userPrompt = `已有话题：
${topicSummary || '（暂无话题）'}
${recentCtx}

新消息：${content}

请判断这条新消息的分类。`;

  const body = {
    model,
    messages: [
      { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 2000,
    temperature: 0.1,
  };

  log(`[classifier-llm] Calling LLM for classification...`);

  const controller = new AbortController();
  // mimo is a reasoning model: classification calls routinely take ~10s. An 8s
  // timeout aborted every request, tripping the circuit breaker (3 fails → 60s
  // cooldown) and dropping the whole session to pure-rule routing. Aligned with
  // the 20s used for naming/keyword extraction (commit 0e9f45a missed this one).
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (llmConfig.apiKey) {
      headers['Authorization'] = `Bearer ${llmConfig.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      log(`[classifier-llm] HTTP ${response.status}, falling back to rules`);
      recordLLMFailure();
      return null;
    }

    const data = await response.json() as any;
    const raw = data?.choices?.[0]?.message?.content ?? '';

    log(`[classifier-llm] Raw response: ${raw.slice(0, 200)}`);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { recordLLMFailure(); return null; }

    const parsed = JSON.parse(jsonMatch[0]);
    const action = parsed.action as ClassifyResult['action'];
    if (!['continue', 'switch', 'new'].includes(action)) { recordLLMFailure(); return null; }

    let targetLabel: string | null = parsed.label || null;

    if (action === 'new') {
      return {
        action: 'new',
        targetLabel: null,
        confidence: 0.75,
        reason: `LLM: ${parsed.reason ?? 'unrelated to all topics'}`,
      };
    }

    // Validate switch target exists
    if (action === 'switch' && targetLabel) {
      const exists = allTopics.some(t => t.label === targetLabel);
      if (!exists) {
        targetLabel = activeTopic?.label ?? null;
        return {
          action: targetLabel ? 'continue' : 'passthrough',
          targetLabel,
          confidence: 0.7,
          reason: `LLM suggested switch to unknown topic, defaulting (${parsed.reason})`,
        };
      }
    }

    if (action === 'continue') {
      targetLabel = activeTopic?.label ?? null;
    }

    recordLLMSuccess();
    return {
      action,
      targetLabel,
      confidence: 0.8,
      reason: `LLM: ${parsed.reason ?? action}`,
    };
  } catch (err: any) {
    log(`[classifier-llm] Error: ${err?.message}, falling back to rules`);
    recordLLMFailure();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main classifier (hybrid: rules → LLM fallback)
// ---------------------------------------------------------------------------

export async function classify(
  content: string,
  recentMessages: string[],
  registry: TopicRegistry,
  config: TopicRouterConfig,
  llmConfig?: LLMConfig,
  log?: (...args: unknown[]) => void
): Promise<ClassifyResult> {
  const noop = () => {};
  const _log = log ?? noop;
  const allTopics = registry.getAll();
  const activeTopic = registry.getActive();

  // L0: Explicit commands (highest priority)
  const cmd = parseExplicitCommand(content);
  if (cmd) return cmd;

  // V4: Override confidenceThreshold with feedback-store adaptive value if present.
  const effectiveConfig = config._adaptiveThresholds?.confidenceThreshold
    ? { ...config, classifier: { ...config.classifier, confidenceThreshold: config._adaptiveThresholds.confidenceThreshold } }
    : config;

  // No topics exist → auto-create first topic for substantial messages
  if (allTopics.length === 0) {
    const trimmedContent = content.trim();
    const isSubstantial = trimmedContent.length > 6;
    if (isSubstantial) {
      return {
        action: 'new',
        targetLabel: null,
        confidence: 0.8,
        reason: 'No existing topics, auto-creating first topic',
      };
    }
    return {
      action: 'passthrough',
      targetLabel: null,
      confidence: 0.9,
      reason: 'No existing topics + short message, passthrough',
    };
  }

  // Continuity window shared by the L1 keyword guard and the L1.5 auto-new rules:
  // the active topic was touched < 3min ago, i.e. this is an ongoing conversation.
  const idleMs = activeTopic ? Date.now() - activeTopic.lastActiveAt : Infinity;
  const RECENT_ACTIVE_WINDOW = 3 * 60 * 1000; // 3 minutes
  const recentlyActive = !!activeTopic && activeTopic.messageCount > 0 && idleMs < RECENT_ACTIVE_WINDOW;

  // L1: High-confidence rules (skip LLM if confident)

  // Strong keyword match (2+ keywords hit)
  const keywordResult = matchKeywords(content, allTopics);
  // Continuity-over-keyword guard: while the active topic is being actively talked to,
  // a 2-keyword hit on ANOTHER topic must NOT pre-empt the session at L1 — an
  // isolated-looking step in a multi-step chain ("搜张三") frequently hits a sibling
  // topic's keywords (run_027: connected task chains got split this way). Defer such
  // cross-topic switches to L2 (the LLM now sees the full recent context) / L3. This
  // only suppresses cross-topic SWITCH; same-topic results, auto-new (L1.5) and the
  // runaway valve (L3) are untouched, so it cannot revive the collapse fix — and if the
  // LLM is unavailable the very same keywordResult is reapplied at L3.
  const keywordIsCrossTopicSwitch = !!keywordResult && keywordResult.action === 'switch' &&
    keywordResult.targetLabel !== activeTopic?.label;
  if (keywordResult && keywordResult.confidence >= effectiveConfig.classifier.confidenceThreshold &&
      !(recentlyActive && keywordIsCrossTopicSwitch)) {
    return keywordResult;
  }

  // Continuation signals / short messages
  const continuationResult = detectContinuation(content, recentMessages, activeTopic);
  if (continuationResult && continuationResult.confidence >= effectiveConfig.classifier.confidenceThreshold) {
    return continuationResult;
  }

  // L1.5: Auto-new checks (before LLM fallback)
  if (activeTopic && activeTopic.messageCount > 0) {
    const msgLower = content.toLowerCase();
    const hasKeywordOverlap = activeTopic.keywords.length > 0 &&
      activeTopic.keywords.some(kw => kwHit(kw, msgLower));
    const trimmedForCheck = content.trim();
    const isSubstantial = (trimmedForCheck.length > 6 && /[？?。！!]/.test(trimmedForCheck)) || trimmedForCheck.length > 15;

    // Recently-active guard: if the active topic was touched very recently (e.g. the
    // user just `/switch`ed back into it, or is mid-conversation), the next message is
    // a continuation — DON'T auto-new even on zero keyword overlap. Without this, a
    // manual /switch followed by an unrelated-looking follow-up gets bounced into a new
    // topic again, and switching back loops forever. User intent (recent activity /
    // explicit switch) outranks keyword-overlap guessing. Saturation (Rule A) is
    // unaffected — it requires idle ≥10min, mutually exclusive with "recent".
    // (idleMs / recentlyActive are computed once above, before L1.)

    // Rule A: Saturation — topic has many messages + idle for a while + unrelated.
    // V4: thresholds come from feedback-store adaptive values when present, else defaults.
    const adaptive = config._adaptiveThresholds;
    const IDLE_THRESHOLD = (adaptive?.saturationIdleMinutes ?? 10) * 60 * 1000;
    const MSG_THRESHOLD = adaptive?.saturationMessageCount ?? 5;
    if (activeTopic.messageCount >= MSG_THRESHOLD && idleMs >= IDLE_THRESHOLD && !hasKeywordOverlap && isSubstantial) {
      _log(`[classifier] Auto-new (saturation): msgs=${activeTopic.messageCount}, idle=${Math.round(idleMs / 60000)}min`);
      return {
        action: 'new',
        targetLabel: null,
        confidence: 0.65,
        reason: `Topic "${activeTopic.label}" saturated (${activeTopic.messageCount} msgs) + ${Math.round(idleMs / 60000)}min idle + unrelated`,
      };
    }

    // Rule B: Zero overlap — topic has enough keywords to judge relevance, message is clearly unrelated.
    // Only consider ACTIVE topics for overlap: an ended topic's keywords (e.g. a closed
    // "天气" topic) must NOT block creating a new topic for an unrelated message.
    const activeTopics = allTopics.filter(t => t.status !== 'ended');
    const KEYWORD_MATURITY = 5;
    if (activeTopic.keywords.length >= KEYWORD_MATURITY && !hasKeywordOverlap && isSubstantial && !recentlyActive) {
      const anyActiveOverlap = activeTopics.some(t =>
        t.label !== activeTopic!.label &&
        t.keywords.length > 0 &&
        t.keywords.some(kw => kwHit(kw, msgLower))
      );
      if (!anyActiveOverlap) {
        _log(`[classifier] Auto-new (zero-overlap): active="${activeTopic.label}" ${activeTopic.keywords.length} keywords, 0 hits with any active topic`);
        return {
          action: 'new',
          targetLabel: null,
          confidence: 0.7,
          reason: `No keyword overlap with any active topic (active has ${activeTopic.keywords.length} keywords) + substantial message`,
        };
      }
    }

    // Rule B-short: unrelated message (≥8 chars) with zero overlap against any active
    // topic → likely a new topic. Catches the gap Rule B misses (low-maturity active
    // topic with <5 keywords, e.g. a fresh topic). Threshold raised from the original
    // draft's 4 to 8 to avoid trivial fillers ("好的"/"继续") spawning topics.
    if (activeTopic.keywords.length > 0 && !hasKeywordOverlap && content.trim().length >= 8 && !recentlyActive) {
      const anyActiveOverlap = activeTopics.some(t =>
        t.label !== activeTopic!.label &&
        t.keywords.length > 0 &&
        t.keywords.some(kw => kwHit(kw, msgLower))
      );
      if (!anyActiveOverlap) {
        _log(`[classifier] Auto-new (short zero-overlap): msg="${content.slice(0, 30)}" vs active="${activeTopic.label}"`);
        return {
          action: 'new',
          targetLabel: null,
          confidence: 0.65,
          reason: `Short message with zero keyword overlap on active topic "${activeTopic.label}"`,
        };
      }
    }
  }

  // L2: LLM fallback for ambiguous cases (with circuit breaker)
  const useHybrid = config.classifier.mode === 'hybrid' || config.classifier.mode === 'llm';

  if (useHybrid && llmConfig?.apiKey) {
    if (isLLMCircuitOpen()) {
      _log(`[classifier-llm] Circuit open, skipping LLM (cooldown 60s)`);
    } else {
      const llmResult = await classifyWithLLM(
        content, activeTopic, allTopics, recentMessages, llmConfig, _log
      );
      if (llmResult) return llmResult;
    }
  }

  // L3: Fallback rules (if LLM unavailable or failed)
  if (activeTopic && activeTopic.messageCount > 0) {
    if (keywordResult && keywordResult.targetLabel !== activeTopic.label) {
      return keywordResult;
    }

    const msgLower = content.toLowerCase();
    const overlapCount = activeTopic.keywords.length > 0
      ? activeTopic.keywords.filter(kw => kwHit(kw, msgLower)).length
      : 0;

    if (overlapCount >= 1) {
      return {
        action: 'continue',
        targetLabel: activeTopic.label,
        confidence: 0.7,
        reason: `Keyword overlap (${overlapCount}) with active topic "${activeTopic.label}"`,
      };
    }

    // Check keyword match to other topics (require 2+ hits to avoid false switches)
    let bestOtherHits = 0;
    let bestOtherTopic: TopicEntry | null = null;
    for (const topic of allTopics) {
      if (topic.label === activeTopic.label) continue;
      if (topic.keywords.length === 0) continue;
      const hits = topic.keywords.filter(kw => kwHit(kw, msgLower)).length;
      if (hits >= 2 && hits > bestOtherHits) {
        bestOtherHits = hits;
        bestOtherTopic = topic;
      }
    }
    if (bestOtherTopic) {
      return {
        action: 'switch',
        targetLabel: bestOtherTopic.label,
        confidence: 0.65,
        reason: `Keyword match (${bestOtherHits}) to "${bestOtherTopic.label}", switching from "${activeTopic.label}"`,
      };
    }

    // Count-only saturation safety valve (LLM-down path only).
    //
    // Every idle-based auto-new (Rule A/B/B-short in L1.5) needs a time gap between
    // messages. When the LLM classifier is unavailable (circuit open / no key / rule
    // mode) AND messages arrive back-to-back (idle never accrues — e.g. an automated
    // eval harness firing 29 tasks with no pause), those rules never fire and EVERY
    // message falls through to the sticky-continue below. One topic then absorbs the
    // entire session unbounded (observed: a "读取多维表格" topic swallowed 69 msgs
    // across completely unrelated tasks).
    //
    // This valve breaks the runaway WITHOUT reintroducing the manual-/switch death
    // loop fixed in 1281f53: that loop is a handful of exchanges on a freshly switched
    // topic and lives in the LLM-healthy path (L2). We gate on a HIGH message count
    // (well above any real on-topic chat or that loop) so only a genuinely ballooning
    // topic forks, and still require zero overlap with EVERY active topic + substantial.
    const adaptive = config._adaptiveThresholds;
    const saturationCount = adaptive?.saturationMessageCount ?? 5;
    const RUNAWAY_MSG_THRESHOLD = Math.max(saturationCount * 3, 15);
    const trimmedL3 = content.trim();
    const isSubstantialL3 = (trimmedL3.length > 6 && /[？?。！!]/.test(trimmedL3)) || trimmedL3.length > 15;
    if (activeTopic.messageCount >= RUNAWAY_MSG_THRESHOLD && isSubstantialL3) {
      const anyActiveOverlap = allTopics
        .filter(t => t.status !== 'ended')
        .some(t => t.keywords.length > 0 && t.keywords.some(kw => kwHit(kw, msgLower)));
      if (!anyActiveOverlap) {
        _log(`[classifier] Auto-new (runaway saturation, LLM down): active="${activeTopic.label}" has ${activeTopic.messageCount} msgs, 0 overlap with any active topic`);
        return {
          action: 'new',
          targetLabel: null,
          confidence: 0.6,
          reason: `Active topic "${activeTopic.label}" ballooned to ${activeTopic.messageCount} msgs with zero overlap (LLM unavailable) — forking new topic`,
        };
      }
    }

    // Sticky session — saturation+idle auto-new is handled in L1.5 above
    return {
      action: 'continue',
      targetLabel: activeTopic.label,
      confidence: 0.6,
      reason: `Sticky: continuing active topic "${activeTopic.label}"`,
    };
  }

  if (keywordResult) return keywordResult;

  // No active topic — check if message is substantial enough to create new topic
  const trimmedFinal = content.trim();
  const isFinalSubstantial = trimmedFinal.length > 6;
  if (isFinalSubstantial) {
    return {
      action: 'new',
      targetLabel: null,
      confidence: 0.7,
      reason: 'No active topic + substantial message → auto-create new topic',
    };
  }

  // No active topic, short message → passthrough
  return {
    action: 'passthrough',
    targetLabel: null,
    confidence: 0.7,
    reason: 'No active topic + short message → passthrough',
  };
}

// ---------------------------------------------------------------------------
// Topic label generation
// ---------------------------------------------------------------------------

export function generateTopicLabel(content: string): string {
  const normalized = content.trim();

  // Defense-in-depth against slash-command pollution: a message starting with "/" is a
  // command, not topic content. If one slips past the hook-handler intercept (e.g. an
  // unforeseen gateway command), do NOT hash its text into a per-command junk label
  // (every distinct command would spawn its own topic). Collapse them all to one stable
  // bucket so they never fragment /topics. The hook-handler passthrough is the primary
  // guard; this is the backstop.
  if (normalized.startsWith('/')) {
    return 'misc';
  }

  const patterns: Array<{ regex: RegExp; label: string }> = [
    { regex: /天气|下雨|温度|气温|forecast|weather/i, label: 'weather' },
    { regex: /代码|编程|bug|debug|脚本|code|python|java|rust|golang|redis|mysql|mongodb|docker|k8s|kubernetes|nginx|api|http|tcp|数据库|缓存|memcached/i, label: 'coding' },
    { regex: /周报|日报|汇报|总结|复盘/i, label: 'report' },
    { regex: /新闻|资讯|热点/i, label: 'news' },
    { regex: /股价|股票|基金|投资|A股|美股|理财/i, label: 'finance' },
    { regex: /翻译|translate/i, label: 'translate' },
    { regex: /搜索|查询|search|查找/i, label: 'search' },
    { regex: /文档|doc|写作|draft|文章/i, label: 'writing' },
    { regex: /sed|awk|grep|bash|shell|终端|命令行|linux|chmod|curl|wget/i, label: 'terminal' },
    { regex: /旅游|旅行|签证|机票|酒店|景点|travel/i, label: 'travel' },
    { regex: /美食|做菜|食谱|餐厅|外卖/i, label: 'food' },
    { regex: /健身|跑步|运动|减肥|锻炼/i, label: 'fitness' },
  ];

  for (const { regex, label } of patterns) {
    if (regex.test(normalized)) return label;
  }

  const hash = simpleHash(normalized.slice(0, 20));
  return hash;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 6);
}

// ---------------------------------------------------------------------------
// V4: Confidence-based UI strategy
// ---------------------------------------------------------------------------

export function determineUIStrategy(
  result: ClassifyResult,
  thresholds: AdaptiveThresholds
): UIStrategy {
  if (result.action === 'continue' || result.action === 'passthrough') return 'silent';
  if (result.confidence >= thresholds.hintThresholdHigh) return 'silent';
  if (result.confidence >= thresholds.hintThresholdLow) return 'hint';
  return 'confirm';
}
