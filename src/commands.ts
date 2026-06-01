/**
 * Commands — handles /topics, /switch, /new, /end commands.
 *
 * These commands are intercepted before the before_dispatch hook
 * and provide the user interface for topic management.
 */

import type { TopicRouterConfig, TopicEntry, HookResult } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
import type { FeedbackStore } from './feedback-store.js';
import type { ContextBridge } from './context-bridge.js';

function findSimilarTopics(query: string, topics: TopicEntry[], maxResults: number): TopicEntry[] {
  if (topics.length === 0) return [];
  const q = query.toLowerCase();

  const scored = topics.map(t => {
    const label = t.label.toLowerCase();
    const name = t.displayName.toLowerCase();
    let score = 0;
    if (label.includes(q) || q.includes(label)) score += 3;
    if (name.includes(q) || q.includes(name)) score += 3;
    for (const kw of t.keywords) {
      if (q.includes(kw.toLowerCase())) score += 1;
    }
    // Character overlap for fuzzy matching
    const chars = new Set(q);
    for (const c of name) {
      if (chars.has(c)) score += 0.1;
    }
    return { topic: t, score };
  });

  return scored
    .filter(s => s.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.topic);
}

type CommandHandler = (params: {
  args: string;
  registry: TopicRegistry;
  config: TopicRouterConfig;
  log: (...args: unknown[]) => void;
  feedbackStore?: FeedbackStore;
  contextBridge?: ContextBridge;
}) => Promise<HookResult | undefined>;

// ---------------------------------------------------------------------------
// /topics — List all active topics
// ---------------------------------------------------------------------------

const handleTopics: CommandHandler = async ({ registry }) => {
  const activeTopics = registry.getActiveTopics();
  const inactiveTopics = registry.getInactiveTopics();
  const current = registry.getActive();

  if (activeTopics.length === 0 && inactiveTopics.length === 0) {
    return {
      handled: true,
      text: '📋 当前没有活跃的话题。\n\n发送消息会自动创建新话题，或使用 `/new <标签>` 手动创建。',
    };
  }

  const lines: string[] = ['📋 **话题列表**\n'];

  if (activeTopics.length > 0) {
    lines.push('**🟢 活跃话题：**');
    for (const topic of activeTopics) {
      const isCurrent = current?.label === topic.label;
      const marker = isCurrent ? ' 👈 当前' : '';
      const ago = formatTimeAgo(topic.lastActiveAt);
      lines.push(
        `  • **${topic.displayName}** (${topic.label}) | ${topic.messageCount}条消息 | ${ago}${marker}`
      );
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
      lines.push(
        `  • **${topic.displayName}** (${topic.label}) | ${topic.messageCount}条消息 | ${ago}`
      );
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

const handleSwitch: CommandHandler = async ({ args, registry, log, feedbackStore, contextBridge }) => {
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

  const topic = registry.get(label) ?? registry.findByDisplayName(label);
  if (!topic) {
    const allTopics = registry.getAll();
    const suggestions = findSimilarTopics(label, allTopics, 3);
    if (suggestions.length > 0) {
      const lines = [`⚠️ 未找到话题 "${label}"，你是否想切换到：\n`];
      for (const s of suggestions) {
        lines.push(`  • \`/switch ${s.label}\` — ${s.displayName}`);
      }
      return { handled: true, text: lines.join('\n') };
    }
    return {
      handled: true,
      text: `⚠️ 未找到话题 "${label}"。使用 \`/topics\` 查看所有话题。`,
    };
  }

  const currentTopic = registry.getActive();

  // V4: Check for merge-back (soft fork)
  if (contextBridge && currentTopic) {
    const fork = contextBridge.checkMerge(currentTopic.label, label);
    if (fork) {
      contextBridge.markMerged(fork);
      registry.markEnded(currentTopic.label);
      registry.setActive(label);
      log(`[v4-soft-fork] Merged back: ${currentTopic.label} → ${label}`);

      if (feedbackStore) {
        feedbackStore.record('immediate_switch_back', {
          fromTopic: currentTopic.label,
          toTopic: label,
          classifierLayer: 'command',
          confidence: 1.0,
          messageSnippet: `/switch ${label}`,
        });
      }

      return {
        handled: true,
        text: `🔄 已合并回话题 **${topic.displayName}**（自动创建的「${currentTopic.displayName}」已结束）`,
      };
    }
  }

  // V4: Emit feedback if this is a correction of recent auto-route
  if (feedbackStore) {
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
        log(`[v4-feedback] Correction detected: auto-routed to "${lastRoute.topic}", user switched to "${label}"`);
      }
    }
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

const handleNew: CommandHandler = async ({ args, registry, log, feedbackStore }) => {
  const label = args.trim() || `topic-${Date.now().toString(36)}`;
  const topic = registry.getOrCreate(label, label);
  topic.keywords = [];

  // V4: Emit feedback if system should have auto-created
  if (feedbackStore) {
    const lastRoute = feedbackStore.getLastRoute();
    if (lastRoute && lastRoute.action === 'continue') {
      const elapsed = Date.now() - lastRoute.timestamp;
      if (elapsed < 120_000) {
        feedbackStore.record('manual_new_after_continue', {
          fromTopic: lastRoute.topic,
          toTopic: label,
          classifierLayer: lastRoute.layer,
          confidence: lastRoute.confidence,
          messageSnippet: `/new ${label}`,
        });
        log(`[v4-feedback] Missed new-topic: system continued "${lastRoute.topic}", user created "${label}"`);
      }
    }
  }

  log(`[topic-router] Created new topic: ${label}`);

  return {
    handled: true,
    text: `✅ 已创建新话题 **${topic.displayName}** (${topic.label})\n\nSession: \`${topic.sessionKey}\`\n后续消息将自动路由到此话题。`,
  };
};

// ---------------------------------------------------------------------------
// /end — End the current topic
// ---------------------------------------------------------------------------

const handleEnd: CommandHandler = async ({ args, registry, log }) => {
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

const handleEndAll: CommandHandler = async ({ registry, log }) => {
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
};

const COMMANDS: Record<string, CommandHandler> = {
  topics: handleTopics,
  switch: handleSwitch,
  newtopic: handleNew,
  end: handleEnd,
  endall: handleEndAll,
};

/**
 * Try to handle a slash command. Returns undefined if the message is not a command.
 */
export async function tryHandleCommand(
  content: string,
  registry: TopicRegistry,
  config: TopicRouterConfig,
  log: (...args: unknown[]) => void,
  feedbackStore?: FeedbackStore,
  contextBridge?: ContextBridge
): Promise<HookResult | undefined> {
  const trimmed = content.trim();
  const match = trimmed.match(/^\/(\w+)\s*(.*)/s);
  if (!match) return undefined;

  const commandName = match[1]?.toLowerCase();
  const args = match[2] ?? '';

  const handler = COMMANDS[commandName];
  if (!handler) return undefined;

  return handler({ args, registry, config, log, feedbackStore, contextBridge });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}
