import fs from 'fs';
import path from 'path';
import { TopicRegistry } from './src/topic-registry.js';
import { handleBeforeDispatch, getRecentAutoNew, clearRecentAutoNew, setPendingForceContinue, setLastAssistantReply } from './src/hook-handler.js';
import { FeedbackStore } from './src/feedback-store.js';
import { ContextBridge } from './src/context-bridge.js';
import { looksLikeNoContext, extractAssistantText } from './src/no-context-detect.js';
import type { TopicRouterConfig, OpenClawEvent, OpenClawContext } from './src/types.js';
import type { LLMConfig } from './src/llm-client.js';
import { resolveClassifierLlmConfig } from './src/llm-client.js';

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
  v4: {
    softFork: { enabled: true, mergeWindowMinutes: 5 },
    feedback: { enabled: true, adaptInterval: 20 },
    hints: { enabled: true, lowThreshold: 0.5, highThreshold: 0.75 },
  },
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

    // Runtime toggle — persisted to state file, controllable via /topic-router on|off
    const toggleFile = `${stateDir}/enabled.json`;
    let runtimeEnabled = readToggle(toggleFile);
    log.info(`[topic-router] Runtime enabled: ${runtimeEnabled} (from ${toggleFile})`);

    api.registerCommand({
      name: 'topic-router',
      description: '开关话题路由 (/topic-router on|off|status|reset)',
      acceptsArgs: true,
      channels: ['feishu'],
      handler: async (ctx: any) => {
        const arg = (ctx.args ?? '').trim().toLowerCase();
        if (arg === 'on') {
          runtimeEnabled = true;
          try { writeToggle(toggleFile, true); }
          catch (err) { log.error(`[topic-router] Failed to persist toggle=on to ${toggleFile}:`, err); }
          return { text: '✅ 话题路由已**开启**' };
        }
        if (arg === 'off') {
          runtimeEnabled = false;
          try { writeToggle(toggleFile, false); }
          catch (err) { log.error(`[topic-router] Failed to persist toggle=off to ${toggleFile}:`, err); }
          return { text: '⏸️ 话题路由已**关闭**，消息将直接进入默认 session' };
        }
        if (arg === 'reset') {
          // Clear learned feedback (in-memory + disk) at runtime — no restart needed.
          feedbackStore.reset();
          const d = feedbackStore.getThresholds();
          return {
            text:
              `🔄 自学习数据已**重置**为默认值\n` +
              `• confidenceThreshold: ${d.confidenceThreshold}\n` +
              `• saturationMessageCount: ${d.saturationMessageCount}\n` +
              `• saturationIdleMinutes: ${d.saturationIdleMinutes}\n` +
              `反馈事件/统计已清零,自学习从干净状态重新开始。`,
          };
        }
        // status (default): show toggle + self-learning thresholds/stats so it's
        // observable whether adaptive learning is actually moving.
        const t = feedbackStore.getThresholds();
        const s = feedbackStore.getStats();
        const adjustedAgo = t.lastAdjustedAt
          ? `${Math.round((Date.now() - t.lastAdjustedAt) / 60000)}分钟前`
          : '从未';
        return {
          text:
            `📡 话题路由: **${runtimeEnabled ? '开启' : '关闭'}**\n` +
            `\n**自学习阈值**(上次调整: ${adjustedAgo})\n` +
            `• 置信门槛 confidenceThreshold: ${t.confidenceThreshold}\n` +
            `• 饱和消息数 saturationMessageCount: ${t.saturationMessageCount}\n` +
            `• 饱和空闲分钟 saturationIdleMinutes: ${t.saturationIdleMinutes}\n` +
            `• 提示区间 hint: [${t.hintThresholdLow}, ${t.hintThresholdHigh}]\n` +
            `\n**反馈统计**\n` +
            `• 反馈事件总数: ${s.totalRoutes}\n` +
            `• 正向(continue留存): ${s.correctRoutes}\n` +
            `• 纠错(/switch): ${s.corrections}\n` +
            `• 漏判新话题(/newtopic): ${s.missedNewTopics}\n` +
            `\n使用 \`/topic-router on|off\` 切换,\`/topic-router reset\` 重置自学习`,
        };
      },
    });

    const registry = new TopicRegistry(stateDir);
    const feedbackStore = new FeedbackStore(stateDir, (...a: unknown[]) => log.info(...a));
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
        const cmdSessionKey: string = ctx?.sessionKey ?? ctx?.ctx?.sessionKey ?? '';
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

        // Ended topic: don't silently open an empty same-name session.
        if (topic.status === 'ended') {
          return { text: `⚠️ 话题 **${topic.displayName}** (${topic.label}) 已结束，无法切回其上下文。\n→ 发送 \`/newtopic ${topic.label}\` 开启同名新话题，或 \`/topics\` 查看现有话题。` };
        }

        const currentTopic = registry.getActive();

        // V4: Soft Fork merge-back
        if (currentTopic) {
          const fork = contextBridge.checkMerge(currentTopic.label, label);
          if (fork) {
            contextBridge.markMerged(fork);
            registry.markEnded(currentTopic.label);
            registry.setActive(label);
            if (cmdSessionKey) setPendingForceContinue(cmdSessionKey, label);
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
          const lastRoute = feedbackStore.getLastRoute(cmdSessionKey);
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

        // Ended topics are not revived in place; use the entry that became active.
        const activated = registry.setActive(topic.label) ?? topic;
        cmdLog(`Switched to topic: ${activated.label}`);

        // Arm a one-shot force-continue so the user's NEXT message stays in the topic they
        // just chose. Without this, re-classification (or L1 keywords learned by a previously
        // mis-created topic) can pull the immediate follow-up right back out — the loop the
        // user hit ("switch 回原话题后重复输入又被分到新话题").
        if (cmdSessionKey) setPendingForceContinue(cmdSessionKey, activated.label);

        return {
          text: `✅ 已切换到话题 **${activated.displayName}** (${activated.label})\n\nSession: \`${activated.sessionKey}\`\n历史消息: ${activated.messageCount}条`,
        };
      },
    });

    // /newtopic, /new, /end, /endall are handled via before_dispatch → commands.ts
    // (not registered as gateway commands to avoid "new" reserved name conflict)

    // ── Topic classifier hook ──
    // Classifier uses mimo (fast, cheap). Reply dispatches via openclaw agent CLI (full pipeline).
    const apiKey = process.env.MODEL_API_KEY || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';

    // Cluster-aware config (normal/vip) from env; defaults reproduce prior hardcoded values.
    const { config: classifierLlmConfig, cluster } = resolveClassifierLlmConfig(process.env, apiKey);

    log.info(`[topic-router] Classifier: ${classifierLlmConfig.model} (cluster=${cluster}, baseUrl=${classifierLlmConfig.baseUrl}) | Reply: session routing (full agent pipeline)`);

    const hookHandler = async (event: OpenClawEvent, ctx: OpenClawContext) => {
      if (!readToggle(toggleFile)) return undefined;
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
          feedbackStore,
          contextBridge,
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
      const outputHandler = (event: OpenClawEvent, ctx: OpenClawContext) => {
        if (!readToggle(toggleFile)) return;
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

        // Record the assistant's reply so the classifier can see the other half of the
        // dialog on the user's NEXT message (a follow-up operating on what was just said
        // would otherwise look unrelated to the topic's keywords → misclassified `new`).
        const assistantText = extractAssistantText(event);
        if (assistantText) setLastAssistantReply(sessionKey, assistantText);

        const autoNew = getRecentAutoNew(sessionKey);
        let footer: string;
        if (autoNew && autoNew.newLabel === label) {
          // Auto-switch-back: this reply came from a freshly auto-created topic. If the
          // agent explicitly says it lacks prior context, the routing was almost certainly
          // wrong — the message was a follow-up that belonged to the parent topic. Switch
          // the active topic back so the user's NEXT message lands there, and tell them to
          // just resend (this turn can't be salvaged — the reply already went out). We only
          // act on an explicit "no context" declaration, never a generic clarifying question,
          // so genuine new topics are not merged back (would re-trigger topic-collapse).
          if (looksLikeNoContext(assistantText)) {
            registry.setActive(autoNew.previousLabel);
            // Arm a one-shot force-continue on the INBOUND key so the user's resend
            // actually lands in the parent topic — classify() would otherwise re-judge
            // the identical text `new` again and the "resend" promise would never hold.
            setPendingForceContinue(autoNew.originalSessionKey, autoNew.previousLabel);
            log.info(`[topic-router-output] No-context reply in auto-new topic "${label}"; auto-switched active back to "${autoNew.previousLabel}", armed force-continue on "${autoNew.originalSessionKey}"`);
            footer = `\n\n---\n⚠️ 检测到这条可能是上个话题的追问，已自动切回「${autoNew.previousDisplayName}」。请重发刚才的消息即可在原上下文继续。`;
            // This turn handled the misroute via force-continue; the auto-new record has
            // done its job — clear it so it can't also fire the classifier-side rescue.
            clearRecentAutoNew(sessionKey);
          } else {
            footer = `\n\n---\n📌 新话题: ${displayName} | 如非新话题，发送 \`/switch ${autoNew.previousLabel}\` 回到「${autoNew.previousDisplayName}」`;
            // Wording regex missed (or this is a genuine new topic): do NOT clear. Keep the
            // record so the user's NEXT message gets the classifier-side misroute-rescue
            // (LLM-judged switch-back). Its own 5-min TTL expires it if no follow-up comes.
          }
        } else {
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
              const textPart = msg.content.find((p: any) => p.type === 'text' && typeof p.text === 'string');
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


function resolveStateDir(_api: any): string {
  return process.env.TOPIC_ROUTER_STATE_DIR || '/root/.openclaw/topic-router-state';
}

function readToggle(filePath: string): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data.enabled !== false;
  } catch {
    return true;
  }
}

function writeToggle(filePath: string, enabled: boolean): void {
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  fs.writeFileSync(filePath, JSON.stringify({ enabled, updatedAt: Date.now() }));
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
