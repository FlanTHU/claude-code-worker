import { TopicRegistry } from './src/topic-registry.js';
import { handleBeforeDispatch } from './src/hook-handler.js';
import type { TopicRouterConfig } from './src/types.js';
import type { LLMConfig } from './src/llm-client.js';

function definePluginEntry<T>(opts: T): T { return opts; }


const DEFAULT_CONFIG: TopicRouterConfig = {
  enabled: true,
  classifier: {
    mode: 'hybrid',
    confidenceThreshold: 0.6,
  },
  maxTopics: 20,
  pruneAfterHours: 168,
  replyFooter: true,
  targetSessionKey: 'agent:main:main',
};

const DEFAULT_LLM_CONFIG: LLMConfig = {
  baseUrl: 'http://model.mify.ai.srv/v1',
  model: 'xiaomi/mimo-v2.5-pro-mit',
};

export default definePluginEntry({
  id: 'topic-router',
  name: 'Topic Router',
  description: '自动将私聊消息路由到话题隔离的 session',

  register(api: any) {
    const log = api.logger;

    const pluginConfig: TopicRouterConfig = {
      ...DEFAULT_CONFIG,
      ...api.pluginConfig ?? {},
    };

    if (!pluginConfig.enabled) {
      log.info('Plugin disabled via configuration');
      return;
    }

    const stateDir = resolveStateDir(api);
    const registry = new TopicRegistry(stateDir);

    const prunedCount = registry.prune(pluginConfig.pruneAfterHours * 3600 * 1000);
    if (prunedCount > 0) {
      log.info(`Pruned ${prunedCount} stale topic(s)`);
    }

    // ── Register slash commands via registerCommand (bypasses LLM) ──
    const cmdLog = (...args: unknown[]) => log.info('[cmd]', ...args);

    api.registerCommand({
      name: 'topics',
      description: '列出所有活跃话题',
      acceptsArgs: false,
      channels: ['feishu'],
      handler: async (_ctx: any) => {
        const activeTopics = registry.getActiveTopics();
        const inactiveTopics = registry.getInactiveTopics();
        const current = registry.getActive();

        if (activeTopics.length === 0 && inactiveTopics.length === 0) {
          return { text: '📋 当前没有活跃的话题。\n\n发送消息会自动创建新话题，或使用 `/newtopic <标签>` 手动创建。' };
        }

        const lines: string[] = ['📋 **话题列表**\n'];

        if (activeTopics.length > 0) {
          lines.push('**🟢 活跃话题：**');
          for (const topic of activeTopics) {
            const isCurrent = current?.label === topic.label;
            const marker = isCurrent ? ' 👈 当前' : '';
            const ago = formatTimeAgo(topic.lastActiveAt);
            lines.push(`  • **${topic.displayName}** (${topic.label}) | ${topic.messageCount}条消息 | ${ago}${marker}`);
            if (topic.summary) lines.push(`    _${topic.summary}_`);
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
      handler: async (ctx: any) => {
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

        registry.setActive(label);
        cmdLog(`Switched to topic: ${label}`);

        return {
          text: `✅ 已切换到话题 **${topic.displayName}** (${topic.label})\n\nSession: \`${topic.sessionKey}\`\n历史消息: ${topic.messageCount}条`,
        };
      },
    });

    api.registerCommand({
      name: 'newtopic',
      description: '创建新话题',
      acceptsArgs: true,
      channels: ['feishu'],
      handler: async (ctx: any) => {
        const label = (ctx.args ?? '').trim() || `topic-${Date.now().toString(36)}`;
        const topic = registry.getOrCreate(label);

        cmdLog(`Created new topic: ${label}`);

        return {
          text: `✅ 已创建新话题 **${topic.displayName}** (${topic.label})\n\nSession: \`${topic.sessionKey}\`\n后续消息将自动路由到此话题。`,
        };
      },
    });

    api.registerCommand({
      name: 'end',
      description: '结束当前或指定话题',
      acceptsArgs: true,
      channels: ['feishu'],
      handler: async (ctx: any) => {
        const label = (ctx.args ?? '').trim();
        const target = label || registry.getActive()?.label;

        if (!target) {
          return { text: '⚠️ 当前没有活跃话题。' };
        }

        const topic = registry.get(target);
        if (!topic) {
          return { text: `⚠️ 未找到话题 "${target}"。` };
        }

        registry.markEnded(target);
        cmdLog(`Ended topic: ${target}`);

        return {
          text: `✅ 已结束话题 **${topic.displayName}** (${topic.label})\n\n后续消息将回到主 session。`,
        };
      },
    });

    api.registerCommand({
      name: 'endall',
      description: '清理全部话题',
      acceptsArgs: false,
      channels: ['feishu'],
      handler: async (_ctx: any) => {
        const all = registry.getAll();
        if (all.length === 0) {
          return { text: '⚠️ 当前没有话题。' };
        }
        for (const topic of all) {
          registry.markEnded(topic.label);
        }
        cmdLog(`Ended all ${all.length} topics`);
        return {
          text: `✅ 已清理全部 ${all.length} 个话题。后续消息将创建新话题。`,
        };
      },
    });

    // ── Topic classifier hook ──
    // Classifier uses mimo (fast, cheap). Reply dispatches via openclaw agent CLI (full pipeline).
    const apiKey = process.env.MODEL_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';

    const classifierLlmConfig: LLMConfig = {
      baseUrl: 'http://model.mify.ai.srv/v1',
      model: 'xiaomi/mimo-v2.5-pro-mit',
      apiKey,
    };

    log.info(`[topic-router] Classifier: ${classifierLlmConfig.model} | Reply: session routing (full agent pipeline)`);

    const hookHandler = async (event: any, ctx: any) => {
      log.info(`[topic-router] before_dispatch fired, cleanedBody="${(event.cleanedBody ?? '').slice(0, 50)}"`);
      try {
        const result = await handleBeforeDispatch({
          event,
          ctx,
          registry,
          config: pluginConfig,
          stateDir,
          classifierLlmConfig,
          log: (...args: unknown[]) => log.info(...args),
        });

        return result;
      } catch (err) {
        log.error('Hook error, passthrough:', err);
        return undefined;
      }
    };
    api.on('before_dispatch', hookHandler);

    // ── Output hook: append topic footer to replies from topic sessions ──
    if (pluginConfig.replyFooter) {
      const outputHandler = (event: any, ctx: any) => {
        const sessionKey: string = ctx?.sessionKey || event?.sessionKey || '';
        log.info(`[topic-router-output] hook fired. sessionKey="${sessionKey}" eventKeys=${JSON.stringify(Object.keys(event ?? {}))} ctxKeys=${JSON.stringify(Object.keys(ctx ?? {}))}`);

        // Try to find topic label from session key or registry active
        let label: string | undefined;
        if (sessionKey.includes(':topic:')) {
          label = sessionKey.split(':topic:')[1];
        }
        if (!label) {
          const active = registry.getActive();
          if (active) label = active.label;
        }
        if (!label) return;

        const topic = registry.get(label);
        const displayName = topic?.displayName ?? label;
        const footer = `\n\n---\n📌 话题: ${displayName}`;

        log.info(`[topic-router-output] Appending footer for topic "${label}" (${displayName})`);

        // Try multiple known event shapes
        if (event.text && typeof event.text === 'string') {
          event.text = event.text + footer;
        }
        if (event.content && typeof event.content === 'string') {
          event.content = event.content + footer;
        }
        if (event.message && typeof event.message === 'string') {
          event.message = event.message + footer;
        }
        if (event.payloads && Array.isArray(event.payloads)) {
          for (const payload of event.payloads) {
            if (payload.text && typeof payload.text === 'string') {
              payload.text = payload.text + footer;
            }
            if (payload.content && typeof payload.content === 'string') {
              payload.content = payload.content + footer;
            }
          }
        }
        // Feishu card content
        if (event.card && event.card.elements && Array.isArray(event.card.elements)) {
          event.card.elements.push({
            tag: 'markdown',
            content: `---\n📌 话题: ${displayName}`,
          });
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


function resolveStateDir(_api: any): string {
  return '/tmp/topic-router-state';
}

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
