/**
 * Topic Classifier — hybrid rules + LLM approach.
 *
 * Strategy:
 *   L0: Explicit commands (/switch, /new, /end) — always rules
 *   L1: High-confidence rules (keyword 2+, continuation signals, short messages)
 *   L2: LLM fallback for ambiguous cases
 */

import type { ClassifyResult, TopicEntry, TopicRouterConfig } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
import type { LLMConfig } from './llm-client.js';

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
  { regex: /^\/new(?:\s+(.*))?$/i, action: 'new' },
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
      normalized.includes(kw.toLowerCase())
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

  return null;
}

// ---------------------------------------------------------------------------
// LLM-based classification
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM_PROMPT = `你是一个话题分类器。根据用户的新消息和已有话题列表，判断消息应路由到哪个话题。

规则：
1. "continue" — 消息属于当前活跃话题（追问、补充、延续，或无法确定归属时默认选此）
2. "switch" — 消息明确与某个已有（非活跃）话题相关，指定该话题的 label

判断要点：
- 优先 continue：如果消息与当前活跃话题有任何关联性，选 continue
- 只有消息明确属于另一个已存在的话题时才选 switch
- 不确定时选 continue（用户可通过命令手动切换）

只返回 JSON，不要其他文字：
{"action": "continue|switch", "label": "话题label或null", "reason": "简短原因"}`;

async function classifyWithLLM(
  content: string,
  activeTopic: TopicEntry | null,
  allTopics: TopicEntry[],
  recentMessages: string[],
  llmConfig: LLMConfig,
  log: (...args: unknown[]) => void
): Promise<ClassifyResult | null> {
  const baseUrl = llmConfig.baseUrl ?? 'http://model.mify.ai.srv/v1';
  const model = llmConfig.model ?? 'xiaomi/mimo-v2.5-pro-mit';
  const url = `${baseUrl}/chat/completions`;

  const topicSummary = allTopics.map(t => {
    const isActive = t.label === activeTopic?.label ? ' [当前活跃]' : '';
    const kws = t.keywords.slice(0, 8).join(', ');
    return `- ${t.label} (${t.displayName})${isActive}: 关键词=[${kws}], ${t.messageCount}条消息`;
  }).join('\n');

  const recentCtx = recentMessages.length > 0
    ? `\n最近消息（当前话题 "${activeTopic?.label ?? '无'}"）:\n${recentMessages.slice(-3).map(m => `  - ${m.slice(0, 60)}`).join('\n')}`
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
    max_tokens: 150,
    temperature: 0.1,
  };

  log(`[classifier-llm] Calling LLM for classification...`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

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
      return null;
    }

    const data = await response.json() as any;
    const raw = data?.choices?.[0]?.message?.content ?? '';

    log(`[classifier-llm] Raw response: ${raw.slice(0, 200)}`);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const action = parsed.action as ClassifyResult['action'];
    if (!['continue', 'switch'].includes(action)) return null;

    let targetLabel: string | null = parsed.label || null;

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

    return {
      action,
      targetLabel,
      confidence: 0.8,
      reason: `LLM: ${parsed.reason ?? action}`,
    };
  } catch (err: any) {
    log(`[classifier-llm] Error: ${err?.message}, falling back to rules`);
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

  // L1: High-confidence rules (skip LLM if confident)

  // Strong keyword match (2+ keywords hit)
  const keywordResult = matchKeywords(content, allTopics);
  if (keywordResult && keywordResult.confidence >= config.classifier.confidenceThreshold) {
    return keywordResult;
  }

  // Continuation signals / short messages
  const continuationResult = detectContinuation(content, recentMessages, activeTopic);
  if (continuationResult && continuationResult.confidence >= config.classifier.confidenceThreshold) {
    return continuationResult;
  }

  // L1.5: Saturation check — auto-create new topic if active topic is "full" + long idle + unrelated
  if (activeTopic && activeTopic.messageCount > 0) {
    const idleMs = Date.now() - activeTopic.lastActiveAt;
    const IDLE_THRESHOLD = 30 * 60 * 1000; // 30 minutes
    const MSG_THRESHOLD = 8;
    const msgLower = content.toLowerCase();
    const hasKeywordOverlap = activeTopic.keywords.length > 0 &&
      activeTopic.keywords.some(kw => msgLower.includes(kw.toLowerCase()));
    const trimmedForCheck = content.trim();
    const isSubstantial = (trimmedForCheck.length > 6 && /[？?。！!]/.test(trimmedForCheck)) || trimmedForCheck.length > 15;

    if (activeTopic.messageCount >= MSG_THRESHOLD && idleMs >= IDLE_THRESHOLD && !hasKeywordOverlap && isSubstantial) {
      _log(`[classifier] Auto-new: msgs=${activeTopic.messageCount}, idle=${Math.round(idleMs / 60000)}min, len=${trimmedForCheck.length}`);
      return {
        action: 'new',
        targetLabel: null,
        confidence: 0.65,
        reason: `Topic "${activeTopic.label}" saturated (${activeTopic.messageCount} msgs) + ${Math.round(idleMs / 60000)}min idle + unrelated content`,
      };
    }
  }

  // L2: LLM fallback for ambiguous cases
  const useHybrid = config.classifier.mode === 'hybrid' || config.classifier.mode === 'llm';

  if (useHybrid && llmConfig?.apiKey) {
    const llmResult = await classifyWithLLM(
      content, activeTopic, allTopics, recentMessages, llmConfig, _log
    );
    if (llmResult) return llmResult;
  }

  // L3: Fallback rules (if LLM unavailable or failed)
  if (activeTopic && activeTopic.messageCount > 0) {
    if (keywordResult && keywordResult.targetLabel !== activeTopic.label) {
      return keywordResult;
    }

    const msgLower = content.toLowerCase();
    const overlapCount = activeTopic.keywords.length > 0
      ? activeTopic.keywords.filter(kw => msgLower.includes(kw.toLowerCase())).length
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
      const hits = topic.keywords.filter(kw => msgLower.includes(kw.toLowerCase())).length;
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

    // Sticky session — saturation+idle auto-new is handled in L1.5 above
    return {
      action: 'continue',
      targetLabel: activeTopic.label,
      confidence: 0.6,
      reason: `Sticky: continuing active topic "${activeTopic.label}"`,
    };
  }

  if (keywordResult) return keywordResult;

  // No active topic, no keyword match → passthrough to default session
  return {
    action: 'passthrough',
    targetLabel: null,
    confidence: 0.7,
    reason: 'No active topic, no keyword match → passthrough',
  };
}

// ---------------------------------------------------------------------------
// Topic label generation
// ---------------------------------------------------------------------------

export function generateTopicLabel(content: string): string {
  const normalized = content.trim();

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
