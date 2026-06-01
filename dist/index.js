import { TopicRegistry } from './src/topic-registry.js';
import { handleBeforeDispatch, getRecentAutoNew, clearRecentAutoNew } from './src/hook-handler.js';
import { FeedbackStore } from './src/feedback-store.js';
import { ContextBridge } from './src/context-bridge.js';
function definePluginEntry(opts) { return opts; }
const DEFAULT_CONFIG = {
    enabled: true,
    classifier: {
        mode: 'hybrid',
        confidenceThreshold: 0.6,
    },
    maxTopics: 20,
    pruneAfterHours: 168,
    replyFooter: true,
    targetSessionKey: 'agent:main:main',
    v4: {
        softFork: { enabled: true, mergeWindowMinutes: 5 },
        feedback: { enabled: true, adaptInterval: 20 },
        hints: { enabled: true, lowThreshold: 0.5, highThreshold: 0.75 },
    },
};
const DEFAULT_LLM_CONFIG = {
    baseUrl: 'http://model.mify.ai.srv/v1',
    model: 'xiaomi/mimo-v2.5-mit',
};
export default definePluginEntry({
    id: 'topic-router',
    name: 'Topic Router',
    description: '自动将私聊消息路由到话题隔离的 session',
    register(api) {
        const log = api.logger;
        const pluginConfig = {
            ...DEFAULT_CONFIG,
            ...api.pluginConfig ?? {},
        };
        if (!pluginConfig.enabled) {
            log.info('Plugin disabled via configuration');
            return;
        }
        const stateDir = resolveStateDir(api);
        const registry = new TopicRegistry(stateDir);
        const feedbackStore = new FeedbackStore(stateDir);
        const contextBridge = new ContextBridge(stateDir);
        const prunedCount = registry.prune(pluginConfig.pruneAfterHours * 3600 * 1000);
        if (prunedCount > 0) {
            log.info(`Pruned ${prunedCount} stale topic(s)`);
        }
        const fbStats = feedbackStore.getStats();
        if (fbStats.totalRoutes > 0) {
            const correctRate = Math.round((fbStats.correctRoutes / fbStats.totalRoutes) * 100);
            log.info(`[v4] Feedback stats: ${fbStats.totalRoutes} routes, ${correctRate}% correct, ${fbStats.corrections} corrections`);
        }
        // ── Register slash commands via registerCommand (bypasses LLM) ──
        const cmdLog = (...args) => log.info('[cmd]', ...args);
        api.registerCommand({
            name: 'topics',
            description: '列出所有活跃话题',
            acceptsArgs: false,
            channels: ['feishu'],
            handler: async (_ctx) => {
                const activeTopics = registry.getActiveTopics();
                const inactiveTopics = registry.getInactiveTopics();
                const current = registry.getActive();
                if (activeTopics.length === 0 && inactiveTopics.length === 0) {
                    return { text: '📋 当前没有活跃的话题。\n\n发送消息会自动创建新话题，或使用 `/newtopic <标签>` 手动创建。' };
                }
                const lines = ['📋 **话题列表**\n'];
                if (activeTopics.length > 0) {
                    lines.push('**🟢 活跃话题：**');
                    for (const topic of activeTopics) {
                        const isCurrent = current?.label === topic.label;
                        const marker = isCurrent ? ' 👈 当前' : '';
                        const ago = formatTimeAgo(topic.lastActiveAt);
                        lines.push(`  • **${topic.displayName}** (${topic.label}) | ${topic.messageCount}条消息 | ${ago}${marker}`);
                        if (topic.summary)
                            lines.push(`    _${topic.summary}_`);
                    }
                    lines.push('');
                }
                if (inactiveTopics.length > 0) {
                    lines.push('**🟡 休眠话题：**');
                    for (const topic of inactiveTopics) {
                        const ago = formatTimeAgo(topic.lastActiveAt);
                        lines.push(`  • **${topic.displayName}** (${topic.label}) | ${topic.messageCount}条消息 | ${ago}`);
                    }
                    lines.push('');
                }
                lines.push('---');
                lines.push('💡 `/switch <标签>` 切换 | `/newtopic <标签>` 新建 | `/end` 结束当前 | `/endall` 清理全部');
                return { text: lines.join('\n') };
            },
        });
        api.registerCommand({
            name: 'switch',
            description: '切换到指定话题',
            acceptsArgs: true,
            channels: ['feishu'],
            handler: async (ctx) => {
                const label = (ctx.args ?? '').trim();
                if (!label) {
                    const current = registry.getActive();
                    const allTopics = registry.getAll();
                    if (allTopics.length === 0) {
                        return { text: '⚠️ 当前没有可切换的话题。使用 `/newtopic <标签>` 创建一个。' };
                    }
                    const lines = ['🔄 **切换话题** — 请输入 `/switch <标签>`:\n'];
                    for (const topic of allTopics) {
                        const isCurrent = current?.label === topic.label;
                        const marker = isCurrent ? ' 👈 当前' : '';
                        lines.push(`  • \`${topic.label}\` — ${topic.displayName}${marker}`);
                    }
                    return { text: lines.join('\n') };
                }
                const topic = registry.get(label);
                if (!topic) {
                    return { text: `⚠️ 未找到话题 "${label}"。使用 \`/topics\` 查看所有话题。` };
                }
                const currentTopic = registry.getActive();
                // V4: Soft Fork merge-back
                if (currentTopic) {
                    const fork = contextBridge.checkMerge(currentTopic.label, label);
                    if (fork) {
                        contextBridge.markMerged(fork);
                        registry.markEnded(currentTopic.label);
                        registry.setActive(label);
                        cmdLog(`Merged back: ${currentTopic.label} → ${label}`);
                        feedbackStore.record('immediate_switch_back', {
                            fromTopic: currentTopic.label,
                            toTopic: label,
                            classifierLayer: 'command',
                            confidence: 1.0,
                            messageSnippet: `/switch ${label}`,
                        });
                        return {
                            text: `🔄 已合并回话题 **${topic.displayName}**（自动创建的「${currentTopic.displayName}」已结束）`,
                        };
                    }
                    // V4: Feedback — correction detection
                    const lastRoute = feedbackStore.getLastRoute();
                    if (lastRoute && lastRoute.topic !== label) {
                        const elapsed = Date.now() - lastRoute.timestamp;
                        if (elapsed < 60_000) {
                            feedbackStore.record('manual_switch_after_auto', {
                                fromTopic: lastRoute.topic,
                                toTopic: label,
                                classifierLayer: lastRoute.layer,
                                confidence: lastRoute.confidence,
                                messageSnippet: `/switch ${label}`,
                            });
                            cmdLog(`Feedback: correction ${lastRoute.topic} → ${label}`);
                        }
                    }
                }
                registry.setActive(label);
                cmdLog(`Switched to topic: ${label}`);
                return {
                    text: `✅ 已切换到话题 **${topic.displayName}** (${topic.label})\n\nSession: \`${topic.sessionKey}\`\n历史消息: ${topic.messageCount}条`,
                };
            },
        });
        // /newtopic, /new, /end, /endall are handled via before_dispatch → commands.ts
        // (not registered as gateway commands to avoid "new" reserved name conflict)
        // ── Topic classifier hook ──
        // Classifier uses mimo (fast, cheap). Reply dispatches via openclaw agent CLI (full pipeline).
        const apiKey = process.env.MODEL_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';
        const classifierLlmConfig = {
            baseUrl: 'http://model.mify.ai.srv/v1',
            model: 'xiaomi/mimo-v2.5-mit',
            apiKey,
        };
        log.info(`[topic-router] Classifier: ${classifierLlmConfig.model} | Reply: session routing (full agent pipeline)`);
        const hookHandler = async (event, ctx) => {
            log.info(`[topic-router] before_dispatch fired, cleanedBody="${(event.cleanedBody ?? '').slice(0, 50)}"`);
            try {
                const result = await handleBeforeDispatch({
                    event,
                    ctx,
                    registry,
                    config: pluginConfig,
                    stateDir,
                    classifierLlmConfig,
                    log: (...args) => log.info(...args),
                    feedbackStore,
                    contextBridge,
                });
                return result;
            }
            catch (err) {
                log.error('Hook error, passthrough:', err);
                return undefined;
            }
        };
        api.on('before_dispatch', hookHandler);
        // ── Output hook: append topic footer to replies from topic sessions ──
        if (pluginConfig.replyFooter) {
            const outputHandler = (event, ctx) => {
                const sessionKey = ctx?.sessionKey || event?.sessionKey || '';
                log.info(`[topic-router-output] hook fired. sessionKey="${sessionKey}" eventKeys=${JSON.stringify(Object.keys(event ?? {}))} ctxKeys=${JSON.stringify(Object.keys(ctx ?? {}))}`);
                // Try to find topic label from session key or registry active
                let label;
                if (sessionKey.includes(':topic:')) {
                    label = sessionKey.split(':topic:')[1];
                }
                if (!label) {
                    const active = registry.getActive();
                    if (active)
                        label = active.label;
                }
                if (!label)
                    return;
                const topic = registry.get(label);
                const displayName = topic?.displayName ?? label;
                const autoNew = getRecentAutoNew(sessionKey);
                let footer;
                if (autoNew && autoNew.newLabel === label) {
                    footer = `\n\n---\n📌 新话题: ${displayName} | 如非新话题，发送 \`/switch ${autoNew.previousLabel}\` 回到「${autoNew.previousDisplayName}」`;
                    clearRecentAutoNew(sessionKey);
                }
                else {
                    footer = `\n\n---\n📌 话题: ${displayName}`;
                }
                log.info(`[topic-router-output] Appending footer for topic "${label}" (${displayName})`);
                // llm_output shape: {assistantTexts: string[], lastAssistant: string, ...}
                if (event.lastAssistant && typeof event.lastAssistant === 'string') {
                    event.lastAssistant = event.lastAssistant + footer;
                }
                if (event.assistantTexts && Array.isArray(event.assistantTexts)) {
                    const last = event.assistantTexts.length - 1;
                    if (last >= 0 && typeof event.assistantTexts[last] === 'string') {
                        event.assistantTexts[last] = event.assistantTexts[last] + footer;
                    }
                }
                // agent_end shape: {messages: Array<{role, content}>, ...}
                if (event.messages && Array.isArray(event.messages)) {
                    for (let i = event.messages.length - 1; i >= 0; i--) {
                        const msg = event.messages[i];
                        if (msg?.role === 'assistant' && typeof msg.content === 'string') {
                            msg.content = msg.content + footer;
                            break;
                        }
                        if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
                            const textPart = msg.content.find((p) => p.type === 'text' && typeof p.text === 'string');
                            if (textPart) {
                                textPart.text = textPart.text + footer;
                                break;
                            }
                        }
                    }
                }
                // Fallback: generic text/content fields
                if (event.text && typeof event.text === 'string') {
                    event.text = event.text + footer;
                }
                if (event.content && typeof event.content === 'string') {
                    event.content = event.content + footer;
                }
            };
            api.on('llm_output', outputHandler);
            api.on('agent_end', outputHandler);
            api.on('before_reply', outputHandler);
            api.on('reply', outputHandler);
        }
        log.info(`Plugin initialized (mode=${pluginConfig.classifier.mode}, maxTopics=${pluginConfig.maxTopics}, target=${pluginConfig.targetSessionKey})`);
    },
});
function resolveStateDir(_api) {
    return process.env.TOPIC_ROUTER_STATE_DIR || '/root/.openclaw/topic-router-state';
}
function formatTimeAgo(timestamp) {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60)
        return '刚刚';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
}
