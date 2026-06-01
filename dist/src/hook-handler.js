import { classify, generateTopicLabel, determineUIStrategy } from './classifier.js';
import { isTargetSession } from './utils.js';
import { tryHandleCommand } from './commands.js';
const RECENT_MESSAGE_WINDOW = 5;
const MAX_TRACKED_SESSIONS = 50;
const recentMessagesBySession = new Map();
const TOPIC_FOOTER_REGEX = /📌\s*话题[:：]\s*(.+?)(?:\s*$|\n)/;
function resolveTopicFromQuote(quotedContent, registry, log) {
    if (!quotedContent)
        return null;
    const match = quotedContent.match(TOPIC_FOOTER_REGEX);
    if (!match)
        return null;
    const footerValue = match[1].trim();
    log(`[hook-handler] Found topic footer "${footerValue}" in quoted message`);
    if (registry.get(footerValue))
        return footerValue;
    const allTopics = registry.getAll();
    const byDisplayName = allTopics.find(t => t.displayName === footerValue);
    if (byDisplayName)
        return byDisplayName.label;
    const byPrefix = allTopics.find(t => footerValue.endsWith('…') && t.displayName.startsWith(footerValue.slice(0, -1)));
    if (byPrefix)
        return byPrefix.label;
    return null;
}
async function extractKeywords(content, existingKeywords, llmConfig, log) {
    if (!llmConfig?.apiKey)
        return [];
    const baseUrl = llmConfig.baseUrl ?? 'http://model.mify.ai.srv/v1';
    const model = llmConfig.model ?? 'xiaomi/mimo-v2.5-mit';
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
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (llmConfig.apiKey)
            headers['Authorization'] = `Bearer ${llmConfig.apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok)
            return [];
        const data = await response.json();
        const msg = data?.choices?.[0]?.message;
        const contentText = (msg?.content ?? '').trim();
        const reasoningText = (msg?.reasoning_content ?? '').trim();
        // mimo reasoning model: content may be empty, answer buried in reasoning_content's last line
        const raw = contentText || reasoningText;
        if (!raw)
            return [];
        // Try to find comma-separated keywords in the last non-empty line
        const lines = raw.split('\n').filter((l) => l.trim());
        const answer = lines[lines.length - 1]?.trim() ?? '';
        const keywords = answer
            .split(/[,，、\s]+/)
            .map((k) => k.trim().replace(/^["""]+|["""]+$/g, ''))
            .filter((k) => k.length >= 2 && k.length <= 10 && !existingKeywords.includes(k));
        if (keywords.length > 0) {
            log(`[hook-handler] LLM keywords (from ${contentText ? 'content' : 'reasoning'}): ${keywords.join(', ')}`);
            return keywords.slice(0, 5);
        }
        return [];
    }
    catch {
        return [];
    }
    finally {
        clearTimeout(timer);
    }
}
function deriveDisplayNameFallback(content) {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    const maxLen = 15;
    if (trimmed.length <= maxLen)
        return trimmed;
    return trimmed.slice(0, maxLen) + '…';
}
async function deriveDisplayName(content, llmConfig, log) {
    const fallback = deriveDisplayNameFallback(content);
    if (!llmConfig?.apiKey)
        return fallback;
    const baseUrl = llmConfig.baseUrl ?? 'http://model.mify.ai.srv/v1';
    const model = llmConfig.model ?? 'xiaomi/mimo-v2.5-mit';
    const url = `${baseUrl}/chat/completions`;
    const body = {
        model,
        messages: [
            {
                role: 'system',
                content: '用2-4个词命名话题，只返回名称。例：帮我写redis缓存代码→Redis缓存编码，明天北京下雨吗→北京天气',
            },
            { role: 'user', content: content.slice(0, 100) },
        ],
        max_tokens: 2000,
        temperature: 0.1,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (llmConfig.apiKey)
            headers['Authorization'] = `Bearer ${llmConfig.apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok)
            return fallback;
        const data = await response.json();
        const msg = data?.choices?.[0]?.message;
        const contentText = (msg?.content ?? '').trim();
        const reasoningText = (msg?.reasoning_content ?? '').trim();
        const raw = contentText || reasoningText;
        if (!raw)
            return fallback;
        const lines = raw.split('\n').filter((l) => l.trim());
        const answer = lines[lines.length - 1]?.trim().replace(/^["""]+|["""]+$/g, '') ?? '';
        if (answer && answer.length <= 20 && answer.length >= 2) {
            log(`[hook-handler] Generated display name: "${answer}" (from ${contentText ? 'content' : 'reasoning'})`);
            return answer;
        }
        return fallback;
    }
    catch {
        return fallback;
    }
    finally {
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
export async function handleBeforeDispatch(params) {
    const { event, ctx, registry, config, classifierLlmConfig, log, feedbackStore, contextBridge } = params;
    const content = event.cleanedBody || event.content || event.body || '';
    const sessionKey = ctx?.sessionKey || event.sessionKey || '';
    const quotedContent = event.quotedMessage || event.quotedContent
        || event.replyContent || event.quote || event.parentContent
        || event.replyText || event.quoteText || '';
    if (!quotedContent && event._quotedLogged !== true) {
        const keys = Object.keys(event).filter(k => !['body', 'content', 'cleanedBody'].includes(k));
        log(`[hook-handler] Event keys (no quote found): ${keys.join(', ')}`);
        event._quotedLogged = true;
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
    // Note: /new is NOT intercepted here — it's reserved for gateway's native "new session" command
    if (/^\/(topics|switch|newtopic|endall|end)\b/i.test(trimmed)) {
        const cmdResult = await tryHandleCommand(content, registry, config, log, feedbackStore, contextBridge);
        if (cmdResult)
            return cmdResult;
        return undefined;
    }
    const quotedTopicLabel = resolveTopicFromQuote(quotedContent, registry, log);
    const recentMessages = recentMessagesBySession.get(sessionKey) ?? [];
    let result;
    if (quotedTopicLabel) {
        result = {
            action: 'continue',
            targetLabel: quotedTopicLabel,
            confidence: 0.95,
            reason: `Quoted message belongs to topic "${quotedTopicLabel}"`,
        };
        log(`[hook-handler] Routed via quoted message to topic "${quotedTopicLabel}"`);
    }
    else {
        result = await classify(content, recentMessages, registry, config, classifierLlmConfig, log);
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
                text: `🤔 这条消息可能属于${targetDesc}。\n→ /new 创建新话题 | 继续发消息留在当前话题`,
            };
        }
    }
    // ── V4: Track route for feedback detection ──
    if (feedbackStore && config.v4?.feedback?.enabled && result.action !== 'passthrough') {
        const lastRoute = {
            timestamp: Date.now(),
            topic: result.targetLabel ?? '',
            action: result.action,
            confidence: result.confidence,
            layer: result.layer ?? result.reason.split(':')[0] ?? 'unknown',
        };
        feedbackStore.setLastRoute(lastRoute);
        // Positive signal: user continued in previously routed topic
        const prevRoute = feedbackStore.getLastRoute();
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
    }
    const updated = [...recentMessages, content].slice(-RECENT_MESSAGE_WINDOW);
    recentMessagesBySession.set(sessionKey, updated);
    if (recentMessagesBySession.size > MAX_TRACKED_SESSIONS) {
        const oldest = recentMessagesBySession.keys().next().value;
        if (oldest)
            recentMessagesBySession.delete(oldest);
    }
    let topicLabel = null;
    switch (result.action) {
        case 'passthrough':
            return undefined;
        case 'continue': {
            if (!result.targetLabel)
                return undefined;
            topicLabel = result.targetLabel;
            registry.getOrCreate(topicLabel);
            break;
        }
        case 'switch': {
            if (!result.targetLabel)
                return undefined;
            const topic = registry.get(result.targetLabel) ?? registry.findByDisplayName(result.targetLabel);
            if (!topic) {
                log(`Switch target "${result.targetLabel}" not found, passthrough`);
                return undefined;
            }
            topicLabel = topic.label;
            registry.setActive(topicLabel);
            break;
        }
        case 'new': {
            const label = result.targetLabel ?? generateTopicLabel(content);
            const fallbackName = deriveDisplayNameFallback(content);
            topicLabel = label;
            // V4: Soft Fork — carry context from parent topic
            const activeTopic = registry.getActive();
            if (contextBridge && config.v4?.softFork?.enabled && activeTopic) {
                try {
                    const mergeMinutes = config.v4.softFork.mergeWindowMinutes ?? 5;
                    const recentMsgs = recentMessagesBySession.get(sessionKey) ?? [];
                    const summary = recentMsgs.slice(-5).join(' | ').slice(0, 200);
                    contextBridge.createFork(activeTopic.label, label, summary, mergeMinutes);
                    log(`[v4-soft-fork] Created fork: ${activeTopic.label} → ${label} (merge window ${mergeMinutes}min)`);
                }
                catch (err) {
                    log(`[v4-soft-fork] Failed to create fork:`, err);
                }
            }
            registry.getOrCreate(label, fallbackName);
            registry.setActive(label);
            deriveDisplayName(content, classifierLlmConfig, log).then(name => {
                if (name !== fallbackName) {
                    registry.updateDisplayName(label, name);
                }
            }).catch(() => { });
            break;
        }
        default:
            return undefined;
    }
    if (!topicLabel)
        return undefined;
    // ── Learn keywords: rule-based instant + LLM async refinement ──
    registry.learnKeywords(topicLabel, content);
    const existingTopic = registry.get(topicLabel);
    const existingKw = existingTopic?.keywords ?? [];
    extractKeywords(content, existingKw, classifierLlmConfig, log).then(keywords => {
        if (keywords.length > 0) {
            registry.setKeywords(topicLabel, keywords);
        }
    }).catch(() => { });
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
