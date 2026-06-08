import { classify, generateTopicLabel, determineUIStrategy } from './classifier.js';
import { isTargetSession } from './utils.js';
import { tryHandleCommand } from './commands.js';
const RECENT_MESSAGE_WINDOW = 5;
const MAX_TRACKED_SESSIONS = 50;
const recentMessagesBySession = new Map();
const recentAutoNewBySession = new Map();
export function getRecentAutoNew(sessionKey) {
    const entry = recentAutoNewBySession.get(sessionKey);
    if (!entry)
        return null;
    if (Date.now() - entry.createdAt > 5 * 60 * 1000) {
        recentAutoNewBySession.delete(sessionKey);
        return null;
    }
    return entry;
}
export function clearRecentAutoNew(sessionKey) {
    recentAutoNewBySession.delete(sessionKey);
}
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
    // mimo is a reasoning model: naming/keyword calls routinely take ~10s, so an
    // 8s timeout aborted every request → silent fallback. Async fire-and-forget,
    // doesn't block the user reply, so a generous 20s is safe.
    const timer = setTimeout(() => controller.abort(), 20000);
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
    const maxLen = 8;
    if (trimmed.length <= maxLen)
        return trimmed;
    return trimmed.slice(0, maxLen) + '…';
}
async function deriveDisplayName(content, llmConfig, log) {
    const fallback = deriveDisplayNameFallback(content);
    if (!llmConfig?.baseUrl && !llmConfig?.apiKey)
        return fallback;
    const baseUrl = llmConfig.baseUrl ?? 'http://model.mify.ai.srv/v1';
    const model = llmConfig.model ?? 'xiaomi/mimo-v2.5-mit';
    const url = `${baseUrl}/chat/completions`;
    const body = {
        model,
        messages: [
            {
                // mimo 是推理模型，若把用户内容直接当 user 消息会被当成"提问"去作答而非起名。
                // 必须明确"命名器"角色，并把内容包成"为以下文本起标题"，强约束只输出标题。
                role: 'system',
                content: '你是话题命名器。任务：为用户提供的文本起一个2-6个汉字的简短标题。只输出标题本身，禁止回答文本内容、禁止解释、禁止标点符号。',
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
        if (!contentText && !reasoningText)
            return fallback;
        const clean = (s) => s.trim().replace(/^["“”「」『』\s]+|["“”「」『』\s]+$/g, '');
        // content 优先：新 prompt 下 content 就是干净标题（可能含首尾引号/书名号）。
        // 仅当 content 为空（mimo 偶发把答案放进 reasoning）才回退到 reasoning 末行。
        let answer = clean(contentText);
        let from = 'content';
        if (!answer) {
            const lines = reasoningText.split('\n').filter((l) => l.trim());
            answer = clean(lines[lines.length - 1] ?? '');
            from = 'reasoning';
        }
        if (answer && answer.length <= 12 && answer.length >= 2) {
            log(`[hook-handler] Generated display name: "${answer}" (from ${from})`);
            return answer;
        }
        log(`[hook-handler] Display name rejected (len ${answer.length}), using fallback "${fallback}"`);
        return fallback;
    }
    catch (err) {
        // Surface why naming fell back (e.g. AbortError on timeout) instead of silently截断.
        log(`[hook-handler] deriveDisplayName failed (${err?.name ?? err}), using fallback "${fallback}"`);
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
        || event.replyText || event.quoteText
        || event.reply?.content || event.reply?.text || event.reply?.body
        || '';
    if (!quotedContent) {
        const allKeys = Object.keys(event);
        const replyLike = allKeys.filter(k => /quote|reply|parent|ref|thread|origin/i.test(k));
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
    // Note: /new is NOT intercepted here — it's reserved for gateway's native "new session" command
    // /topic-router is handled by registerCommand, skip routing for it
    if (/^\/topic-router\b/i.test(trimmed)) {
        return undefined;
    }
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
        const activeTopic = registry.getActive();
        const isSwitching = activeTopic && activeTopic.label !== quotedTopicLabel;
        result = {
            action: (isSwitching ? 'switch' : 'continue'),
            targetLabel: quotedTopicLabel,
            confidence: 0.95,
            reason: `Quoted message belongs to topic "${quotedTopicLabel}"`,
        };
        log(`[hook-handler] Routed via quoted message to topic "${quotedTopicLabel}" (action=${result.action})`);
    }
    else {
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
            // Use the entry's real label: a target that was ended is not revived in
            // place — getOrCreate spawns a fresh sibling with a new label/sessionKey.
            const entry = registry.getOrCreate(result.targetLabel);
            topicLabel = entry.label;
            break;
        }
        case 'switch': {
            if (!result.targetLabel)
                return undefined;
            const found = registry.get(result.targetLabel) ?? registry.findByDisplayName(result.targetLabel);
            if (!found) {
                log(`Switch target "${result.targetLabel}" not found, passthrough`);
                return undefined;
            }
            const activated = registry.setActive(found.label);
            if (!activated)
                return undefined;
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
                }
                catch (err) {
                    log(`[v4-soft-fork] Failed to create fork:`, err);
                }
            }
            // Track for "switch back" hint in output footer
            if (activeTopic) {
                recentAutoNewBySession.set(created.sessionKey, {
                    newLabel: created.label,
                    previousLabel: activeTopic.label,
                    previousDisplayName: activeTopic.displayName,
                    createdAt: Date.now(),
                });
            }
            deriveDisplayName(content, classifierLlmConfig, log).then(name => {
                if (name !== fallbackName) {
                    registry.updateDisplayName(created.label, name);
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
                registry.setKeywords(topicLabel, keywords);
            }
        }).catch(() => { });
    }
    else {
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
