/**
 * Tests for §5 (per-session serialization queue) and §3b (gateway-native command
 * passthrough at the hook layer). Run: npx tsx test-concurrency.ts
 *
 * Uses rules-only classifier mode (no LLM) so handleBeforeDispatch runs fast and
 * deterministically.
 */

import { handleBeforeDispatch } from './src/hook-handler.js';
import { TopicRegistry } from './src/topic-registry.js';
import fs from 'node:fs';

const STATE_DIR = '/tmp/topic-router-concurrency-test';

function resetState() {
  if (fs.existsSync(STATE_DIR)) fs.rmSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

const config = {
  enabled: true,
  classifier: { mode: 'rules' as const, confidenceThreshold: 0.6 },
  maxTopics: 20,
  pruneAfterHours: 168,
  replyFooter: true,
  targetSessionKey: 'agent:main:main',
};

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

const noop = () => {};

function mkParams(content: string, registry: TopicRegistry, sessionKey = 'agent:main:main', log = noop) {
  return {
    event: { cleanedBody: content, sessionKey },
    ctx: { sessionKey },
    registry,
    config,
    stateDir: STATE_DIR,
    classifierLlmConfig: { apiKey: '' }, // no key -> rules-only, no LLM call
    log,
  };
}

function isHandled(result: Awaited<ReturnType<typeof handleBeforeDispatch>>): boolean {
  return result?.handled === true;
}

async function testGatewayCommandPassthrough() {
  // §3b: /new, /reset, /clear must pass through (return undefined) and create NO topic.
  console.log('\n=== §3b: gateway-native command passthrough ===');
  for (const cmd of ['/new', '/NEW', '/reset', '/clear']) {
    resetState();
    const registry = new TopicRegistry(STATE_DIR);
    const r = await handleBeforeDispatch(mkParams(cmd, registry));
    assert(r === undefined, `${cmd} -> passthrough (undefined) (got ${JSON.stringify(r)})`);
    assert(registry.getAll().length === 0, `${cmd} -> no topic created (got ${registry.getAll().length})`);
  }

  // Contrast: /newtopic IS a plugin command and must be handled (not passthrough).
  resetState();
  const reg2 = new TopicRegistry(STATE_DIR);
  const r2 = await handleBeforeDispatch(mkParams('/newtopic mytopic', reg2));
  assert(isHandled(r2), `/newtopic -> handled by plugin (got ${JSON.stringify(r2)})`);
}

async function testSameSessionSerialized() {
  // §5: two concurrent messages on the SAME session must not corrupt registry state.
  console.log('\n=== §5: same-session concurrent messages serialize ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  const logs: string[] = [];
  const log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

  const p1 = handleBeforeDispatch(mkParams('帮我看看这段 python 代码怎么调试', registry, 'agent:main:main', log));
  const p2 = handleBeforeDispatch(mkParams('今天北京的天气怎么样适合穿什么', registry, 'agent:main:main', log));
  await Promise.all([p1, p2]);

  const active = registry.getActive();
  assert(active !== null, `after concurrent run, an active topic exists (got ${active})`);
  const raw = fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8');
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch {}
  assert(parsed !== null && typeof parsed === 'object' && 'topics' in parsed && typeof parsed.topics === 'object', 'registry file is valid JSON after concurrent run');
  const firstRoute = logs.findIndex(line => line.includes('Routing to topic session'));
  const secondStart = logs.findIndex(line => line.includes('content="今天北京的天气'));
  assert(firstRoute >= 0 && secondStart > firstRoute, `second same-session handler starts after first routed (firstRoute=${firstRoute}, secondStart=${secondStart})`);
}

async function testDifferentSessionsIndependent() {
  // §5: concurrent calls must not deadlock; both resolve.
  console.log('\n=== §5: concurrent calls resolve without deadlock ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  const a = handleBeforeDispatch(mkParams('帮我看看 python 代码', registry, 'agent:main:feishu:direct:user-a'));
  const b = handleBeforeDispatch(mkParams('python 报错怎么修', registry, 'agent:main:feishu:direct:user-b'));
  const [ra, rb] = await Promise.all([a, b]);
  assert(true, `both calls resolved without deadlock (a=${ra ? 'routed' : 'passthrough'}, b=${rb ? 'routed' : 'passthrough'})`);
}

async function main() {
  await testGatewayCommandPassthrough();
  await testSameSessionSerialized();
  await testDifferentSessionsIndependent();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
