import { classify, generateTopicLabel } from './classifier.js';
import { isTargetSession } from './utils.js';
import { tryHandleCommand } from './commands.js';
import { execFile } from 'node:child_process';
const RECENT_MESSAGE_WINDOW = 5;
const MAX_TRACKED_SESSIONS = 50;
const AGENT_TIMEOUT_MS = 300_000; // 5 minutes
const CLI_PATH = '/root/.openclaw/workspace/bin/openclaw-cli.sh';
const recentMessagesBySession = new Map();
function runAgentTurn(sessionId, message, log) {
    return new Promise((resolve, reject) => {
        const args = ['agent', '--session-id', sessionId, '--message', message, '--json'];
        log(`[agent-call] ${CLI_PATH} ${args.join(' ').slice(0, 100)}...`);
        execFile(CLI_PATH, args, {
            timeout: AGENT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error) {
                log(`[agent-call] Error: ${error.message}`);
                log(`[agent-call] stderr: ${stderr?.slice(0, 200)}`);
                reject(error);
                return;
            }
            log(`[agent-call] stdout length=${stdout.length}`);
            const cleanedStdout = stdout
                .split('\n')
                .filter(l => !l.startsWith('Debugger listening') && !l.startsWith('For help, see:') && !l.startsWith('Track SDK:'))
                .join('\n')
                .trim();
            try {
                const result = JSON.parse(cleanedStdout);
                const text = result?.result?.payloads?.[0]?.text ?? result?.reply?.text ?? result?.text ?? result?.output ?? cleanedStdout;
                resolve(typeof text === 'string' ? text : JSON.stringify(text));
            }
            catch {
                resolve(cleanedStdout || '(无回复)');
            }
        });
    });
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
    // Try direct label match first
    if (registry.get(footerValue))
        return footerValue;
    // Footer uses displayName — find topic by displayName
    const allTopics = registry.getAll();
    const byDisplayName = allTopics.find(t => t.displayName === footerValue);
    if (byDisplayName)
        return byDisplayName.label;
    // Partial match (displayName may be truncated with …)
    const byPrefix = allTopics.find(t => footerValue.endsWith('…') && t.displayName.startsWith(footerValue.slice(0, -1)));
    if (byPrefix)
        return byPrefix.label;
    log(`[hook-handler] Topic from footer "${footerValue}" not found in registry`);
    return null;
}
function deriveDisplayName(content) {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    const maxLen = 15;
    if (trimmed.length <= maxLen)
        return trimmed;
    return trimmed.slice(0, maxLen) + '…';
}
export async function handleBeforeDispatch(params) {
    const { event, registry, config, classifierLlmConfig, log } = params;
    const content = event.cleanedBody ?? event.content ?? event.body ?? '';
    const sessionKey = params.ctx?.sessionKey ?? event.sessionKey ?? '';
    // Extract quoted/reply message content from event (field name varies by adapter)
    const quotedContent = event.quotedMessage ?? event.quotedContent
        ?? event.replyContent ?? event.quote ?? event.parentContent
        ?? event.replyText ?? event.quoteText ?? '';
    // Log event keys on first call to discover field names
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
    // Slash commands are handled by registerCommand, but also intercept here as fallback
    if (/^\/(topics|switch|new|end)\b/i.test(trimmed)) {
        const cmdResult = await tryHandleCommand(content, registry, config, log);
        if (cmdResult)
            return cmdResult;
        return undefined;
    }
    // Detect topic from quoted message footer (📌 话题: xxx)
    const quotedTopicLabel = resolveTopicFromQuote(quotedContent, registry, log);
    const recentMessages = recentMessagesBySession.get(sessionKey) ?? [];
    // If quoting a topic message, force-route to that topic
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
    // ── Dispatch via OpenClaw agent CLI with topic-isolated session ──
    const topicSessionId = `topic-${topicLabel}`;
    try {
        const reply = await runAgentTurn(topicSessionId, content, log);
        const topic = registry.get(topicLabel);
        const footer = config.replyFooter
            ? `\n\n---\n📌 话题: ${topic?.displayName ?? topicLabel}`
            : '';
        log(`[hook-handler] Agent reply ${reply.length} chars for topic "${topicLabel}"`);
        return { handled: true, text: reply + footer };
    }
    catch (err) {
        log(`[hook-handler] Agent call failed: ${err?.message ?? err}`);
        return {
            handled: true,
            text: `⚠️ 话题 "${topicLabel}" 处理失败: ${err?.message ?? '未知错误'}\n\n---\n📌 话题: ${topicLabel}`,
        };
    }
}
