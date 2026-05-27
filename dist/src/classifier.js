/**
 * Topic Classifier — determines whether a message continues the current topic,
 * switches to an existing topic, starts a new topic, or should passthrough.
 *
 * Classification strategy (priority order):
 *   L0: Explicit user commands (/switch, /new, /end)
 *   L1: Keyword matching against known topics
 *   L2: Continuation detection (short messages without switch signals)
 *   L3: LLM-based semantic classification (fallback)
 */
// ---------------------------------------------------------------------------
// L0: Explicit command detection
// ---------------------------------------------------------------------------
const COMMAND_PATTERNS = [
    { regex: /^\/switch\s+(\S+)/i, action: 'switch' },
    { regex: /^\/new\s*(.*)/i, action: 'new' },
    { regex: /^\/end\s*(.*)/i, action: 'passthrough' },
];
export function parseExplicitCommand(content) {
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
// L1: Keyword matching
// ---------------------------------------------------------------------------
const MIN_KEYWORD_MATCHES = 2;
export function matchKeywords(content, topics) {
    if (topics.length === 0)
        return null;
    const normalized = content.toLowerCase();
    let best = null;
    for (const topic of topics) {
        if (topic.keywords.length === 0)
            continue;
        const matchedCount = topic.keywords.filter(kw => normalized.includes(kw.toLowerCase())).length;
        if (matchedCount < MIN_KEYWORD_MATCHES)
            continue;
        // Confidence: requires 2+ matches to even qualify; scales with ratio
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
// ---------------------------------------------------------------------------
// L2: Continuation detection
// ---------------------------------------------------------------------------
/** Words that signal topic continuation (staying on the same topic). */
const CONTINUATION_SIGNALS = [
    '它', '这', '那', '那这', '那这个', '这个', '接着', '继续', '然后呢', '还有',
    '再说', '另外', '而且', '并且', '对了', '顺便', '补充',
    '怎么', '为什么', '是不是', '能不能', '会不会', '有没有',
    'what about', 'how about', 'and then', 'also', 'moreover',
    'is it', 'does it', 'can it', 'will it',
];
/** Words that signal topic switch (moving to a different topic). */
const SWITCH_SIGNALS = [
    '换个话题', '说到', '另外一个', '另', '对了说到', '回到',
    '刚才那个', '之前那个', '上次那个', '之前说的',
    'let me ask about', 'switching topics', 'by the way',
    'going back to', 'about that earlier',
];
export function detectContinuation(content, recentMessages, activeTopic) {
    if (!activeTopic)
        return null;
    const normalized = content.toLowerCase().trim();
    // Short messages (< 30 chars) without switch signals → likely continuation
    const hasSwitchSignal = SWITCH_SIGNALS.some(s => normalized.includes(s.toLowerCase()));
    if (hasSwitchSignal)
        return null;
    const hasContinuationSignal = CONTINUATION_SIGNALS.some(s => normalized.startsWith(s.toLowerCase()));
    if (hasContinuationSignal && normalized.length < 50) {
        return {
            action: 'continue',
            targetLabel: activeTopic.label,
            confidence: 0.85,
            reason: `Continuation signal detected, staying on "${activeTopic.label}"`,
        };
    }
    // Short/medium messages (< 30 chars) in an active topic → continue
    if (normalized.length < 30) {
        return {
            action: 'continue',
            targetLabel: activeTopic.label,
            confidence: 0.7,
            reason: `Short message in active topic "${activeTopic.label}", continuing`,
        };
    }
    return null;
}
// ---------------------------------------------------------------------------
// L3: Back-reference detection
// ---------------------------------------------------------------------------
const BACK_REFERENCE_PATTERNS = [
    /刚才.{0,5}(那个|说的|提到|聊的|讨论)/,
    /之前.{0,5}(那个|说的|提到|聊的|讨论)/,
    /上次.{0,5}(那个|说的|提到|聊的|讨论)/,
    /回到.{0,10}(话题|问题|事情)/,
    /(?:那个|这个).{0,5}(天气|代码|周报|股价|新闻)/,
];
export function detectBackReference(content, topics) {
    const normalized = content.toLowerCase().trim();
    for (const pattern of BACK_REFERENCE_PATTERNS) {
        if (!pattern.test(normalized))
            continue;
        // Try to extract a topic label hint from the match
        for (const topic of topics) {
            const displayNameLower = topic.displayName.toLowerCase();
            const labelLower = topic.label.toLowerCase();
            if (normalized.includes(displayNameLower) ||
                normalized.includes(labelLower) ||
                topic.keywords.some(kw => normalized.includes(kw.toLowerCase()))) {
                return {
                    action: 'switch',
                    targetLabel: topic.label,
                    confidence: 0.85,
                    reason: `Back-reference detected → "${topic.label}"`,
                };
            }
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Main classifier (orchestrates all levels)
// ---------------------------------------------------------------------------
export async function classify(content, recentMessages, registry, config) {
    const allTopics = registry.getAll();
    const activeTopic = registry.getActive();
    // L0: Explicit commands (highest priority, regardless of mode)
    const cmd = parseExplicitCommand(content);
    if (cmd)
        return cmd;
    // LLM mode is not yet implemented; fall through to rules-based classification
    if (config.classifier.mode === 'llm') {
        // TODO: implement LLM-based classification
        // Falling through to rules-based logic as temporary behavior
    }
    // If no topics exist yet, everything is new or passthrough
    if (allTopics.length === 0) {
        // Heuristic: messages > 10 chars with question/instruction patterns → new topic
        if (content.trim().length > 10) {
            return {
                action: 'new',
                targetLabel: null, // Will be auto-generated
                confidence: 0.5,
                reason: 'No existing topics, treating as new topic',
            };
        }
        return {
            action: 'passthrough',
            targetLabel: null,
            confidence: 0.3,
            reason: 'No existing topics, short message → passthrough',
        };
    }
    // L1: Keyword matching
    const keywordResult = matchKeywords(content, allTopics);
    if (keywordResult && keywordResult.confidence >= config.classifier.confidenceThreshold) {
        return keywordResult;
    }
    // L2: Continuation detection
    const continuationResult = detectContinuation(content, recentMessages, activeTopic);
    if (continuationResult && continuationResult.confidence >= config.classifier.confidenceThreshold) {
        return continuationResult;
    }
    // L3: Back-reference detection
    const backRefResult = detectBackReference(content, allTopics);
    if (backRefResult && backRefResult.confidence >= config.classifier.confidenceThreshold) {
        return backRefResult;
    }
    // L4: If we have an active topic and no strong signal to switch
    if (activeTopic && activeTopic.messageCount > 0) {
        // Check if keyword result suggests a different topic
        if (keywordResult && keywordResult.targetLabel !== activeTopic.label) {
            return keywordResult;
        }
        // Check keyword overlap with active topic (require 2+ matches)
        const msgLower = content.toLowerCase();
        const overlapCount = activeTopic.keywords.length > 0
            ? activeTopic.keywords.filter(kw => msgLower.includes(kw.toLowerCase())).length
            : 0;
        if (overlapCount >= 2) {
            return {
                action: 'continue',
                targetLabel: activeTopic.label,
                confidence: 0.7,
                reason: `Keyword overlap (${overlapCount}) with active topic "${activeTopic.label}"`,
            };
        }
        // Check if there's even a single keyword match to another topic
        // (relaxed threshold: 1 keyword is enough to switch away)
        const msgLowerFull = content.toLowerCase();
        for (const topic of allTopics) {
            if (topic.label === activeTopic.label)
                continue;
            if (topic.keywords.length === 0)
                continue;
            const hits = topic.keywords.filter(kw => msgLowerFull.includes(kw.toLowerCase())).length;
            if (hits >= 1) {
                return {
                    action: 'switch',
                    targetLabel: topic.label,
                    confidence: 0.65,
                    reason: `Keyword match (${hits}) to inactive topic "${topic.label}", switching away from "${activeTopic.label}"`,
                };
            }
        }
        // Time proximity check
        const recencyMs = Date.now() - activeTopic.lastActiveAt;
        const RECENCY_WINDOW = 5 * 60 * 1000;
        // If active topic has accumulated enough keywords but message has ZERO overlap,
        // and message is long enough to be a distinct question, treat as new topic
        if (activeTopic.keywords.length >= 6 && overlapCount === 0 && content.trim().length > 25) {
            return {
                action: 'new',
                targetLabel: null,
                confidence: 0.6,
                reason: `Zero keyword overlap with "${activeTopic.label}" (has ${activeTopic.keywords.length} keywords), new topic`,
            };
        }
        if (recencyMs < RECENCY_WINDOW) {
            return {
                action: 'continue',
                targetLabel: activeTopic.label,
                confidence: 0.6,
                reason: `Within ${Math.round(recencyMs / 1000)}s of active topic "${activeTopic.label}", continuing`,
            };
        }
        // Beyond time window and no keyword overlap → new topic
        return {
            action: 'new',
            targetLabel: null,
            confidence: 0.5,
            reason: `No relation to active topic "${activeTopic.label}" and beyond time window, creating new topic`,
        };
    }
    // No active topic, keyword match below threshold → try keyword match anyway
    if (keywordResult) {
        return keywordResult;
    }
    // Fallback: passthrough to main session
    return {
        action: 'passthrough',
        targetLabel: null,
        confidence: 0.3,
        reason: 'No matching topic, no active topic → passthrough to main session',
    };
}
// ---------------------------------------------------------------------------
// Topic label generation (for new topics)
// ---------------------------------------------------------------------------
export function generateTopicLabel(content) {
    // Try to extract a meaningful label from the content
    const normalized = content.trim();
    // Common topic patterns
    const patterns = [
        { regex: /天气|下雨|温度|气温|forecast/i, label: 'weather' },
        { regex: /代码|编程|bug|debug|脚本|code/i, label: 'coding' },
        { regex: /周报|日报|汇报|总结|复盘/i, label: 'report' },
        { regex: /新闻|资讯|热点/i, label: 'news' },
        { regex: /股价|股票|基金|投资/i, label: 'finance' },
        { regex: /翻译|translate/i, label: 'translate' },
        { regex: /搜索|查询|search|查找/i, label: 'search' },
        { regex: /文档|doc|写|draft/i, label: 'writing' },
    ];
    for (const { regex, label } of patterns) {
        if (regex.test(normalized))
            return label;
    }
    // Fallback: use a hash of the first 20 chars
    const hash = simpleHash(normalized.slice(0, 20));
    return `topic-${hash}`;
}
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return Math.abs(hash).toString(36).slice(0, 6);
}
