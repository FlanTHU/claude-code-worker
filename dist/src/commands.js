/**
 * Commands — handles /topics, /switch, /new, /end commands.
 *
 * These commands are intercepted before the before_dispatch hook
 * and provide the user interface for topic management.
 */
// ---------------------------------------------------------------------------
// /topics — List all active topics
// ---------------------------------------------------------------------------
const handleTopics = async ({ registry }) => {
    const activeTopics = registry.getActiveTopics();
    const inactiveTopics = registry.getInactiveTopics();
    const current = registry.getActive();
    if (activeTopics.length === 0 && inactiveTopics.length === 0) {
        return {
            handled: true,
            text: '📋 当前没有活跃的话题。\n\n发送消息会自动创建新话题，或使用 `/new <标签>` 手动创建。',
        };
    }
    const lines = ['📋 **话题列表**\n'];
    if (activeTopics.length > 0) {
        lines.push('**🟢 活跃话题：**');
        for (const topic of activeTopics) {
            const isCurrent = current?.label === topic.label;
            const marker = isCurrent ? ' 👈 当前' : '';
            const ago = formatTimeAgo(topic.lastActiveAt);
            lines.push(`  • **${topic.displayName}** (${topic.label}) | ${topic.messageCount}条消息 | ${ago}${marker}`);
            if (topic.summary) {
                lines.push(`    _${topic.summary}_`);
            }
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
    lines.push('💡 使用 `/switch <标签>` 切换话题 | `/new <标签>` 新建话题 | `/end` 结束当前话题');
    return { handled: true, text: lines.join('\n') };
};
// ---------------------------------------------------------------------------
// /switch — Switch to a specific topic
// ---------------------------------------------------------------------------
const handleSwitch = async ({ args, registry, log }) => {
    const label = args.trim();
    if (!label) {
        const current = registry.getActive();
        const allTopics = registry.getAll();
        if (allTopics.length === 0) {
            return { handled: true, text: '⚠️ 当前没有可切换的话题。使用 `/new <标签>` 创建一个。' };
        }
        const lines = ['🔄 **切换话题** — 请输入 `/switch <标签>`:\n'];
        for (const topic of allTopics) {
            const isCurrent = current?.label === topic.label;
            const marker = isCurrent ? ' 👈 当前' : '';
            lines.push(`  • \`${topic.label}\` — ${topic.displayName}${marker}`);
        }
        return { handled: true, text: lines.join('\n') };
    }
    const topic = registry.get(label);
    if (!topic) {
        return {
            handled: true,
            text: `⚠️ 未找到话题 "${label}"。使用 \`/topics\` 查看所有话题。`,
        };
    }
    registry.setActive(label);
    log(`[topic-router] Switched to topic: ${label}`);
    return {
        handled: true,
        text: `✅ 已切换到话题 **${topic.displayName}** (${topic.label})\n\nSession: \`${topic.sessionKey}\`\n历史消息: ${topic.messageCount}条`,
    };
};
// ---------------------------------------------------------------------------
// /new — Create a new topic
// ---------------------------------------------------------------------------
const handleNew = async ({ args, registry, log }) => {
    const label = args.trim() || `topic-${Date.now().toString(36)}`;
    const topic = registry.getOrCreate(label);
    log(`[topic-router] Created new topic: ${label}`);
    return {
        handled: true,
        text: `✅ 已创建新话题 **${topic.displayName}** (${topic.label})\n\nSession: \`${topic.sessionKey}\`\n后续消息将自动路由到此话题。`,
    };
};
// ---------------------------------------------------------------------------
// /end — End the current topic
// ---------------------------------------------------------------------------
const handleEnd = async ({ args, registry, log }) => {
    const label = args.trim();
    if (label.toLowerCase() === 'all') {
        const all = registry.getAll();
        if (all.length === 0) {
            return { handled: true, text: '⚠️ 当前没有话题。' };
        }
        for (const topic of all) {
            registry.markEnded(topic.label);
        }
        log(`[topic-router] Ended all ${all.length} topics`);
        return {
            handled: true,
            text: `✅ 已清理全部 ${all.length} 个话题。后续消息将创建新话题。`,
        };
    }
    const target = label || registry.getActive()?.label;
    if (!target) {
        return { handled: true, text: '⚠️ 当前没有活跃话题。' };
    }
    const topic = registry.get(target);
    if (!topic) {
        return { handled: true, text: `⚠️ 未找到话题 "${target}"。` };
    }
    registry.markEnded(target);
    log(`[topic-router] Ended topic: ${target}`);
    return {
        handled: true,
        text: `✅ 已结束话题 **${topic.displayName}** (${topic.label})\n\n后续消息将回到主 session。`,
    };
};
// ---------------------------------------------------------------------------
// Command router
// ---------------------------------------------------------------------------
const COMMANDS = {
    topics: handleTopics,
    switch: handleSwitch,
    new: handleNew,
    end: handleEnd,
};
/**
 * Try to handle a slash command. Returns undefined if the message is not a command.
 */
export async function tryHandleCommand(content, registry, config, log) {
    const trimmed = content.trim();
    const match = trimmed.match(/^\/(\w+)\s*(.*)/s);
    if (!match)
        return undefined;
    const commandName = match[1]?.toLowerCase();
    const args = match[2] ?? '';
    const handler = COMMANDS[commandName];
    if (!handler)
        return undefined;
    return handler({ args, registry, config, log });
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
