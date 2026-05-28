import type { TopicRouterConfig, HookResult } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
import { classify, generateTopicLabel } from './classifier.js';
import { isTargetSession } from './utils.js';
import { tryHandleCommand } from './commands.js';
import type { LLMConfig } from './llm-client.js';
import { execFile } from 'node:child_process';

const RECENT_MESSAGE_WINDOW = 5;
const MAX_TRACKED_SESSIONS = 50;
const AGENT_TIMEOUT_MS = 300_000; // 5 minutes

const CLI_PATH = '/root/.openclaw/workspace/bin/openclaw-cli.sh';

const recentMessagesBySession = new Map<string, string[]>();

function runAgentTurn(sessionId: string, message: string, log: (...args: unknown[]) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['agent', '--session-id', sessionId, '--message', message, '--json'];
    log(`[agent-call] ${CLI_PATH} ${args.join(' ').slice(0, 100)}...`);

    execFile(CLI_PATH, args, {
      timeout: AGENT_TIMEOUT_MS,
      env: { ...process.env, HOME: '/root/.openclaw/workspace/.oc-home' },
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        log(`[agent-call] Error: ${error.message}`);
        log(`[agent-call] stderr: ${stderr?.slice(0, 200)}`);
        reject(error);
        return;
      }

      log(`[agent-call] stdout length=${stdout.length}`);

      try {
        const result = JSON.parse(stdout);
        const text = result?.reply?.text ?? result?.text ?? result?.output ?? stdout;
        resolve(typeof text === 'string' ? text : JSON.stringify(text));
      } catch {
        // Not JSON — use raw stdout, strip debugger lines
        const cleaned = stdout
          .split('\n')
          .filter(l => !l.startsWith('Debugger listening') && !l.startsWith('For help, see:'))
          .join('\n')
          .trim();
        resolve(cleaned || '(无回复)');
      }
    });
  });
}

function deriveDisplayName(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, ' ');
  const maxLen = 15;
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen) + '…';
}

export async function handleBeforeDispatch(params: {
  event: any;
  ctx: any;
  registry: TopicRegistry;
  config: TopicRouterConfig;
  stateDir: string;
  classifierLlmConfig: LLMConfig;
  log: (...args: unknown[]) => void;
}): Promise<HookResult | undefined> {
  const { event, registry, config, classifierLlmConfig, log } = params;

  const content: string = event.cleanedBody ?? event.content ?? event.body ?? '';
  const sessionKey: string = params.ctx?.sessionKey ?? event.sessionKey ?? '';

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
    if (cmdResult) return cmdResult;
    return undefined;
  }

  const recentMessages = recentMessagesBySession.get(sessionKey) ?? [];

  const result = await classify(content, recentMessages, registry, config, classifierLlmConfig, log);

  log(`Classification: action=${result.action} label=${result.targetLabel} confidence=${result.confidence} reason=${result.reason}`);

  const updated = [...recentMessages, content].slice(-RECENT_MESSAGE_WINDOW);
  recentMessagesBySession.set(sessionKey, updated);

  if (recentMessagesBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = recentMessagesBySession.keys().next().value;
    if (oldest) recentMessagesBySession.delete(oldest);
  }

  // Determine topic label
  let topicLabel: string | null = null;

  switch (result.action) {
    case 'passthrough':
      return undefined;

    case 'continue': {
      if (!result.targetLabel) return undefined;
      topicLabel = result.targetLabel;
      registry.getOrCreate(topicLabel);
      registry.learnKeywords(topicLabel, content);
      break;
    }

    case 'switch': {
      if (!result.targetLabel) return undefined;
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

  if (!topicLabel) return undefined;

  // ── Dispatch via OpenClaw agent CLI with topic-isolated session ──
  const topicSessionId = `topic:${topicLabel}`;

  try {
    const reply = await runAgentTurn(topicSessionId, content, log);

    const topic = registry.get(topicLabel);
    const footer = config.replyFooter
      ? `\n\n---\n📌 话题: ${topic?.displayName ?? topicLabel}`
      : '';

    log(`[hook-handler] Agent reply ${reply.length} chars for topic "${topicLabel}"`);

    return { handled: true, text: reply + footer };
  } catch (err: any) {
    log(`[hook-handler] Agent call failed: ${err?.message ?? err}`);
    return {
      handled: true,
      text: `⚠️ 话题 "${topicLabel}" 处理失败: ${err?.message ?? '未知错误'}\n\n---\n📌 话题: ${topicLabel}`,
    };
  }
}
