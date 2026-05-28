import type { TopicRouterConfig, HookResult } from './types.js';
import type { TopicRegistry } from './topic-registry.js';
import { classify, generateTopicLabel } from './classifier.js';
import { isTargetSession } from './utils.js';
import { tryHandleCommand } from './commands.js';
import type { LLMConfig } from './llm-client.js';
import { execFile } from 'node:child_process';

const RECENT_MESSAGE_WINDOW = 5;
const MAX_TRACKED_SESSIONS = 50;
const AGENT_TIMEOUT_MS = 120_000; // 2 minutes

const CLI_PATH = '/root/.openclaw/workspace/bin/openclaw-cli.sh';

const recentMessagesBySession = new Map<string, string[]>();

function runAgentTurn(sessionId: string, message: string, log: (...args: unknown[]) => void): Promise<string> {
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
      } catch {
        resolve(cleanedStdout || '(无回复)');
      }
    });
  });
}

const TOPIC_FOOTER_REGEX = /📌\s*话题[:：]\s*(.+?)(?:\s*$|\n)/;

function resolveTopicFromQuote(
  quotedContent: string,
  registry: TopicRegistry,
  log: (...args: unknown[]) => void
): string | null {
  if (!quotedContent) return null;

  const match = quotedContent.match(TOPIC_FOOTER_REGEX);
  if (!match) return null;

  const footerValue = match[1].trim();
  log(`[hook-handler] Found topic footer "${footerValue}" in quoted message`);

  // Try direct label match first
  if (registry.get(footerValue)) return footerValue;

  // Footer uses displayName — find topic by displayName
  const allTopics = registry.getAll();
  const byDisplayName = allTopics.find(t => t.displayName === footerValue);
  if (byDisplayName) return byDisplayName.label;

  // Partial match (displayName may be truncated with …)
  const byPrefix = allTopics.find(t =>
    footerValue.endsWith('…') && t.displayName.startsWith(footerValue.slice(0, -1))
  );
  if (byPrefix) return byPrefix.label;

  log(`[hook-handler] Topic from footer "${footerValue}" not found in registry`);
  return null;
}

function deriveDisplayNameFallback(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, ' ');
  const maxLen = 15;
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen) + '…';
}

async function deriveDisplayName(
  content: string,
  llmConfig: LLMConfig | undefined,
  log: (...args: unknown[]) => void
): Promise<string> {
  const fallback = deriveDisplayNameFallback(content);

  if (!llmConfig?.apiKey) {
    log(`[hook-handler] deriveDisplayName: no apiKey, using fallback "${fallback}"`);
    return fallback;
  }

  const baseUrl = llmConfig.baseUrl ?? 'http://model.mify.ai.srv/v1';
  const model = llmConfig.model ?? 'xiaomi/mimo-v2.5-pro-mit';
  const url = `${baseUrl}/chat/completions`;
  log(`[hook-handler] deriveDisplayName: calling ${model} at ${baseUrl}`);

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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (llmConfig.apiKey) {
      headers['Authorization'] = `Bearer ${llmConfig.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      log(`[hook-handler] Display name LLM HTTP ${response.status}`);
      return fallback;
    }

    const data = await response.json() as any;
    const msg = data?.choices?.[0]?.message;
    const raw = (msg?.content ?? msg?.reasoning_content ?? '').trim();

    // Extract last line as the actual answer (reasoning models may prefix with thinking)
    const lines = raw.split('\n').filter((l: string) => l.trim());
    const answer = lines[lines.length - 1]?.trim() ?? '';

    if (answer && answer.length <= 20 && answer.length >= 2) {
      log(`[hook-handler] Generated display name: "${answer}"`);
      return answer;
    }
    log(`[hook-handler] Display name LLM response not usable: "${raw.slice(0, 50)}"`);
    return fallback;
  } catch (err: any) {
    log(`[hook-handler] deriveDisplayName error: ${err?.message ?? err}`);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
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

  const content: string = event.cleanedBody || event.content || event.body || '';
  const sessionKey: string = params.ctx?.sessionKey || event.sessionKey || '';

  // Extract quoted/reply message content from event (field name varies by adapter)
  const quotedContent: string = event.quotedMessage || event.quotedContent
    || event.replyContent || event.quote || event.parentContent
    || event.replyText || event.quoteText || '';

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
  if (/^\/(topics|switch|newtopic|new|endall|end)\b/i.test(trimmed)) {
    const cmdResult = await tryHandleCommand(content, registry, config, log);
    if (cmdResult) return cmdResult;
    return undefined;
  }

  // Detect topic from quoted message footer (📌 话题: xxx)
  const quotedTopicLabel = resolveTopicFromQuote(quotedContent, registry, log);

  const recentMessages = recentMessagesBySession.get(sessionKey) ?? [];

  // If quoting a topic message, force-route to that topic
  let result;
  if (quotedTopicLabel) {
    result = {
      action: 'continue' as const,
      targetLabel: quotedTopicLabel,
      confidence: 0.95,
      reason: `Quoted message belongs to topic "${quotedTopicLabel}"`,
    };
    log(`[hook-handler] Routed via quoted message to topic "${quotedTopicLabel}"`);
  } else {
    result = await classify(content, recentMessages, registry, config, classifierLlmConfig, log);
  }

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

  if (!topicLabel) return undefined;

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
  } catch (err: any) {
    log(`[hook-handler] Agent call failed: ${err?.message?.slice(0, 150)}`);
    return undefined;
  }
}
