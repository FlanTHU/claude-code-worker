import { classify, generateTopicLabel } from './classifier.js';
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
    const model = llmConfig.model ?? 'xiaomi/mimo-v2.5-pro-mit';
    const url = `${baseUrl}/chat/completions`;
    const body = {
        model,
        messages: [
            {
                role: 'system',
                content: '你是话题命名器。根据用户消息生成一个简短的话题名称（2-4个词，中文优先）。只返回名称本身，不加引号或标点。例如："帮我写redis缓存代码"→"Redis缓存编码"，"明天北京下雨吗"→"北京天气"，"解释下量子纠缠"→"量子纠缠"',
            },
            { role: 'user', content: content.slice(0, 100) },
        ],
        max_tokens: 200,
        temperature: 0.1,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
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
        const raw = (msg?.content || msg?.reasoning_content || '').trim();
        const lines = raw.split('\n').filter((l) => l.trim());
        const answer = lines[lines.length - 1]?.trim() ?? '';
        if (answer && answer.length <= 20 && answer.length >= 2) {
            log(`[hook-handler] Generated display name: "${answer}"`);
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
    const { event, ctx, registry, config, classifierLlmConfig, log } = params;
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
    if (/^\/(topics|switch|newtopic|new|endall|end)\b/i.test(trimmed)) {
        const cmdResult = await tryHandleCommand(content, registry, config, log);
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
            registry.learnKeywords(topicLabel, content);
            break;
        }
        case 'switch': {
            if (!result.targetLabel)
                return undefined;
            const topic = registry.get(result.targetLabel);
            if (!topic) {
                log(`Switch target "${result.targetLabel}" not found, passthrough`);
                return undefined;
            }
            topicLabel = result.targetLabel;
            registry.setActive(topicLabel);
            registry.learnKeywords(topicLabel, content);
            break;
        }
        case 'new': {
            const label = result.targetLabel ?? generateTopicLabel(content);
            const displayName = await deriveDisplayName(content, classifierLlmConfig, log);
            topicLabel = label;
            registry.getOrCreate(label, displayName);
            registry.setActive(label);
            registry.learnKeywords(label, content);
            break;
        }
        default:
            return undefined;
    }
    if (!topicLabel)
        return undefined;
    // ── Session routing: mutate ctx.sessionKey to topic session ──
    const topic = registry.get(topicLabel);
    if (topic) {
        const newSessionKey = topic.sessionKey;
        log(`[hook-handler] Routing to topic session: ${sessionKey} → ${newSessionKey}`);
        // Strategy 1: Mutate ctx.sessionKey (if gateway reads it before dispatch)
        ctx.sessionKey = newSessionKey;
        // Strategy 2: Also set on event in case gateway reads from there
        event.sessionKey = newSessionKey;
        // Strategy 3: Return routeToSession in result (if gateway supports it)
        return {
            handled: false,
            routeToSession: newSessionKey,
            topicLabel,
        };
    }
    return undefined;
}
