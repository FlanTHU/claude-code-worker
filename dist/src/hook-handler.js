import { classify, generateTopicLabel } from './classifier.js';
import { isTargetSession } from './utils.js';
import { tryHandleCommand } from './commands.js';
const RECENT_MESSAGE_WINDOW = 5;
const MAX_TRACKED_SESSIONS = 50;
const recentMessagesBySession = new Map();
function deriveDisplayName(content) {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    const maxLen = 15;
    if (trimmed.length <= maxLen)
        return trimmed;
    return trimmed.slice(0, maxLen) + '…';
}
export async function handleBeforeDispatch(params) {
    const { event, ctx, registry, config, llmConfig, log } = params;
    const content = event.cleanedBody ?? event.content ?? event.body ?? '';
    const sessionKey = ctx?.sessionKey ?? event.sessionKey ?? '';
    log(`[hook-handler] content="${content.slice(0, 50)}" sessionKey="${sessionKey}"`);
    if (!isTargetSession(sessionKey, config.targetSessionKey)) {
        return undefined;
    }
    if (!content || content.trim().length === 0) {
        return undefined;
    }
    const trimmed = content.trim();
    // Slash commands are handled by registerCommand, but also intercept here as fallback
    if (/^\/(topics|switch|new|end)\b/i.test(trimmed)) {
        const cmdResult = await tryHandleCommand(content, registry, config, log);
        if (cmdResult)
            return cmdResult;
        return undefined;
    }
    const recentMessages = recentMessagesBySession.get(sessionKey) ?? [];
    const result = await classify(content, recentMessages, registry, config, llmConfig, log);
    log(`Classification: action=${result.action} label=${result.targetLabel} confidence=${result.confidence} reason=${result.reason}`);
    const updated = [...recentMessages, content].slice(-RECENT_MESSAGE_WINDOW);
    recentMessagesBySession.set(sessionKey, updated);
    if (recentMessagesBySession.size > MAX_TRACKED_SESSIONS) {
        const oldest = recentMessagesBySession.keys().next().value;
        if (oldest)
            recentMessagesBySession.delete(oldest);
    }
    // Determine topic label
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
            const displayName = deriveDisplayName(content);
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
    // ── Route to topic-isolated session by mutating ctx ──
    const topic = registry.get(topicLabel);
    const targetSession = topic?.sessionKey ?? `topic:${topicLabel}`;
    log(`[hook-handler] Routing to session "${targetSession}" for topic "${topicLabel}"`);
    // Mutate ctx to route the message to topic-specific session
    // OpenClaw dispatch reads ctx.SessionKey (PascalCase) for session resolution
    if (ctx) {
        ctx.SessionKey = targetSession;
        ctx.sessionKey = targetSession;
    }
    // Return undefined = don't claim, let main agent handle with modified session
    return undefined;
}
