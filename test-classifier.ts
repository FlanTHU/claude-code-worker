/**
 * Quick local test for classifier logic (rules-only, no LLM).
 * Run: npx tsx test-classifier.ts
 */

import { classify, parseExplicitCommand, matchKeywords, detectContinuation, generateTopicLabel } from './src/classifier.js';
import { TopicRegistry } from './src/topic-registry.js';
import { handleBeforeDispatch } from './src/hook-handler.js';
import fs from 'node:fs';

const STATE_DIR = '/tmp/topic-router-test-state';

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

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

async function testL0() {
  console.log('\n=== L0: Explicit Commands ===');

  let r = parseExplicitCommand('/switch coding');
  assert(r?.action === 'switch' && r.targetLabel === 'coding', '/switch coding → switch, label=coding');

  r = parseExplicitCommand('/newtopic my-topic');
  assert(r?.action === 'new' && r.targetLabel === 'my-topic', '/newtopic my-topic → new, label=my-topic');

  r = parseExplicitCommand('/newtopic');
  assert(r?.action === 'new' && r.targetLabel === null, '/newtopic → new, label=null');

  r = parseExplicitCommand('/end');
  assert(r?.action === 'passthrough', '/end → passthrough');

  r = parseExplicitCommand('hello /switch coding');
  assert(r === null, 'hello /switch coding → not a command');

  r = parseExplicitCommand('  /switch coding  ');
  assert(r?.action === 'switch', '  /switch coding  → switch (allows whitespace)');
}

async function testNoTopics() {
  console.log('\n=== No Topics → Passthrough ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);

  const r = await classify('Redis和Memcached有什么区别？', [], registry, config);
  assert(r.action === 'new', `No topics, substantial message → new (got ${r.action})`);

  const r2 = await classify('嗯', [], registry, config);
  assert(r2.action === 'passthrough', `No topics, short message → passthrough (got ${r2.action})`);
}

async function testContinuation() {
  console.log('\n=== Continuation Signals (active topic: coding) ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('coding', '编程');
  registry.learnKeywords('coding', 'python typescript debugging redis memcached');

  const cases = [
    ['那这个怎么实现', 'continue'],
    ['具体怎么做', 'continue'],
    ['能不能给个例子', 'continue'],
    ['详细说说', 'continue'],
    ['比如说', 'continue'],
    ['what about the tests', 'continue'],
  ] as const;

  for (const [input, expected] of cases) {
    const r = await classify(input, [], registry, config);
    assert(r.action === expected, `"${input}" → ${expected} (got ${r.action})`);
  }

  // Should NOT trigger continuation signal if not at start
  // But with sticky sessions, it will still "continue" via the fallback
  const r3 = await classify('我觉得具体怎么做不太清楚', [], registry, config);
  assert(r3.action === 'continue', `"具体" not at start → still continue via sticky (got ${r3.action})`);
}

async function testKeywordMatch() {
  console.log('\n=== Keyword Match ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('coding', '编程');
  registry.learnKeywords('coding', 'python typescript debugging');
  registry.getOrCreate('travel', '旅游');
  registry.learnKeywords('travel', '签证 机票 酒店 景点');
  registry.setActive('travel'); // Set travel as active, coding is not

  // 2 keywords for coding → switch to coding (from travel)
  const r = await classify('我想用python写一个typescript项目', [], registry, config);
  assert(r.action === 'switch', `2 coding keywords from travel → switch (got ${r.action})`);
  assert(r.targetLabel === 'coding', `target = coding (got ${r.targetLabel})`);

  // 1 keyword → not enough for switch
  const r2 = matchKeywords('python是什么', registry.getAll());
  assert(r2 === null, '1 keyword → no match');
}

async function testStickySession() {
  console.log('\n=== Sticky Session (no keyword, stay on active) ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('coding', '编程');
  registry.learnKeywords('coding', 'python typescript debugging redis');

  // Unrelated message with active topic → should continue (sticky), NOT new
  const r = await classify('明天北京会下雨吗？', [], registry, config);
  assert(r.action === 'continue', `Unrelated msg → continue (sticky), got ${r.action}`);
  assert(r.targetLabel === 'coding', `Stays on coding, got ${r.targetLabel}`);

  // Short confirmation → continue
  const r2 = await classify('好', [], registry, config);
  assert(r2.action === 'continue', `"好" → continue, got ${r2.action}`);

  const r3 = await classify('嗯', [], registry, config);
  assert(r3.action === 'continue', `"嗯" → continue, got ${r3.action}`);
}

async function testSwitchBack() {
  console.log('\n=== Switch between existing topics ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('coding', '编程');
  registry.learnKeywords('coding', 'python typescript debugging redis memcached');
  registry.getOrCreate('travel', '旅游');
  registry.learnKeywords('travel', '签证 机票 酒店 景点');
  registry.setActive('travel');

  // From travel, message with 2+ coding keywords → switch to coding
  const r = await classify('python和typescript怎么选', [], registry, config);
  assert(r.action === 'switch' && r.targetLabel === 'coding',
    `From travel, 2 coding keywords → switch to coding (got ${r.action}/${r.targetLabel})`);
}

async function testNoActiveTopicPassthrough() {
  console.log('\n=== No Active Topic → Passthrough ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('coding', '编程');
  registry.markInactive('coding');

  // All topics inactive, no keyword match → passthrough
  const r = await classify('你好啊', [], registry, config);
  assert(r.action === 'passthrough', `No active topic, no match → passthrough (got ${r.action})`);
}

async function testSaturationAutoNew() {
  console.log('\n=== Saturation Auto-New (high msgs + long idle + unrelated) ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  const topic = registry.getOrCreate('coding', '编程');
  registry.learnKeywords('coding', 'python typescript debugging redis');

  // Simulate high message count and long idle
  const data = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8'));
  data.topics['coding'].messageCount = 12;
  data.topics['coding'].lastActiveAt = Date.now() - 45 * 60 * 1000; // 45 min ago
  fs.writeFileSync(`${STATE_DIR}/topic-sessions.json`, JSON.stringify(data));

  // Substantial unrelated message → should trigger new
  const r = await classify('明天北京昌平天气怎么样？', [], registry, config);
  assert(r.action === 'new', `Saturated + 45min idle + unrelated → new (got ${r.action})`);

  // Short message → should NOT trigger new (not substantial)
  const r2 = await classify('嗯', [], registry, config);
  assert(r2.action === 'continue', `Saturated + idle but short msg → continue (got ${r2.action})`);

  // Related message (has keyword) → should NOT trigger new
  const r3 = await classify('python的装饰器怎么用？', [], registry, config);
  assert(r3.action === 'continue', `Saturated + idle but has keyword overlap → continue (got ${r3.action})`);
}

async function testSaturationNotMet() {
  console.log('\n=== Saturation NOT met (recent activity or low msgs) ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('coding', '编程');
  registry.learnKeywords('coding', 'python typescript debugging redis');

  // Fresh topic (messageCount=1, just created) → sticky
  const r = await classify('明天天气怎么样啊？', [], registry, config);
  assert(r.action === 'continue', `Fresh topic (1 msg) + unrelated → continue (got ${r.action})`);

  // Simulate a not-yet-runaway topic with recent activity
  const data = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8'));
  data.topics['coding'].messageCount = 14;
  data.topics['coding'].lastActiveAt = Date.now() - 2 * 60 * 1000; // 2 min ago
  fs.writeFileSync(`${STATE_DIR}/topic-sessions.json`, JSON.stringify(data));

  const r2 = await classify('明天天气怎么样啊？', [], registry, config);
  assert(r2.action === 'continue', `Below runaway threshold + recent (2min) → continue (got ${r2.action})`);
}

async function testRunawayValve() {
  // L3 count-only safety valve: when the LLM classifier is unavailable (here:
  // mode 'rules' → L2 skipped) AND messages arrive back-to-back (idle ~0, so all
  // idle-based L1.5 rules are inert), a single active topic must not absorb the
  // session unbounded. Regression guard for the 29-task eval that collapsed into
  // one "读取多维表格" topic swallowing 69 unrelated messages.
  console.log('\n=== Runaway Valve (LLM down + zero idle + ballooning topic) ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('coding', '编程');
  registry.learnKeywords('coding', 'python typescript debugging redis');

  // Many messages but JUST active (idle ~0 → recentlyActive=true → Rule A/B/B-short
  // all inert). This is exactly the eval scenario the idle rules cannot catch.
  const data = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8'));
  data.topics['coding'].messageCount = 20;
  data.topics['coding'].lastActiveAt = Date.now(); // idle ~0
  fs.writeFileSync(`${STATE_DIR}/topic-sessions.json`, JSON.stringify(data));

  // Substantial unrelated message → valve forks a new topic despite zero idle.
  const r = await classify('帮我创建一个测试群聊并修改群名称？', [], registry, config);
  assert(r.action === 'new', `Ballooned topic (20 msgs) + zero idle + unrelated → new (got ${r.action})`);

  // Related message with a single keyword hit → stays via L3 overlap (valve must
  // not fire). One keyword (not 2+) so it falls through L1 matchKeywords to L3,
  // where overlapCount>=1 yields continue before the valve is reached.
  const r2 = await classify('typescript这块该怎么写才对？', [], registry, config);
  assert(r2.action === 'continue', `Ballooned but keyword overlap → continue (got ${r2.action})`);

  // Below the runaway threshold → sticky continue (valve must not fire on small topics).
  resetState();
  const reg2 = new TopicRegistry(STATE_DIR);
  reg2.getOrCreate('coding', '编程');
  reg2.learnKeywords('coding', 'python typescript debugging redis');
  const d2 = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8'));
  d2.topics['coding'].messageCount = 5; // below max(5*3,15)=15
  d2.topics['coding'].lastActiveAt = Date.now();
  fs.writeFileSync(`${STATE_DIR}/topic-sessions.json`, JSON.stringify(d2));
  const r3 = await classify('帮我创建一个测试群聊并修改群名称？', [], reg2, config);
  assert(r3.action === 'continue', `Below runaway threshold (5 msgs) + zero idle → continue (got ${r3.action})`);
}

async function testReferenceContinue() {
  // C: a message that explicitly refers back to earlier conversation must stay on the
  // active topic (continue), NOT spawn a new one — even when the active topic is
  // saturated + idle (the very condition that otherwise triggers auto-new). This is the
  // source-side fix for the mis-route that leaves the agent with no context.
  console.log('\n=== Reference-Signal Continue (back-reference stays on topic) ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('coding', '编程');
  registry.learnKeywords('coding', 'python typescript debugging redis');

  // Saturate + long idle so auto-new WOULD fire on an unrelated substantial message.
  const data = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8'));
  data.topics['coding'].messageCount = 12;
  data.topics['coding'].lastActiveAt = Date.now() - 45 * 60 * 1000;
  fs.writeFileSync(`${STATE_DIR}/topic-sessions.json`, JSON.stringify(data));

  // Back-reference phrases → continue despite saturation/idle/zero-overlap.
  const refMsgs = [
    '你之前说的那个方案再展开讲讲',
    '刚才提到的第二点是什么意思',
    '上面说的那个怎么操作',
    'about the one you mentioned earlier, how does it work',
  ];
  for (const m of refMsgs) {
    const r = await classify(m, [], registry, config);
    assert(r.action === 'continue', `Back-reference "${m.slice(0, 12)}…" → continue (got ${r.action})`);
  }

  // Guard: a bare "之前" inside a genuinely new unrelated request must NOT be pulled
  // back (compound-phrase matching only) — otherwise topic-collapse returns.
  const rNew = await classify('帮我查之前武汉总部食堂今天的菜单', [], registry, config);
  assert(rNew.action === 'new', `Bare "之前" in new request → new, not pulled back (got ${rNew.action})`);
}

async function testContinuityOverKeyword() {
  // ②-3 continuity-over-keyword guard: while the active topic is being actively talked
  // to (recentlyActive), a 2-keyword hit on ANOTHER topic must not pre-empt the session
  // at L1 — it defers to the LLM (which now sees full context). The deferral is the win
  // ONLY in LLM mode; here we assert the LLM-DOWN (rules) fallback is intact: the same
  // cross-topic keyword result is still reapplied at L3, so the message is deferred, not
  // dropped. Regression guard against the guard accidentally stranding cross-topic msgs.
  console.log('\n=== Continuity-over-keyword (L1 defer, L3 fallback intact) ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('coding', '编程');
  registry.learnKeywords('coding', 'python typescript debugging');
  registry.getOrCreate('travel', '旅游');
  registry.learnKeywords('travel', '签证 机票 酒店 景点');
  registry.setActive('travel');

  // travel just touched + has messages → recentlyActive. A 2-coding-keyword message:
  // L1 suppressed (cross-topic switch while recentlyActive), but in rules mode L3
  // reapplies the keyword switch → still routes to coding (no stranding when LLM down).
  const data = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8'));
  data.topics['travel'].messageCount = 3;
  data.topics['travel'].lastActiveAt = Date.now(); // idle ~0 → recentlyActive
  fs.writeFileSync(`${STATE_DIR}/topic-sessions.json`, JSON.stringify(data));

  const r = await classify('python和typescript项目怎么选', [], registry, config);
  assert(r.action === 'switch' && r.targetLabel === 'coding',
    `LLM-down: recentlyActive cross-topic keyword still switches via L3 (got ${r.action}/${r.targetLabel})`);

  // Same topic, but NOT recentlyActive (idle 10min) → L1 keyword switch fires directly.
  const d2 = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8'));
  d2.topics['travel'].lastActiveAt = Date.now() - 10 * 60 * 1000;
  fs.writeFileSync(`${STATE_DIR}/topic-sessions.json`, JSON.stringify(d2));
  const r2 = await classify('python和typescript项目怎么选', [], registry, config);
  assert(r2.action === 'switch' && r2.targetLabel === 'coding',
    `Not recentlyActive → L1 keyword switch fires (got ${r2.action}/${r2.targetLabel})`);
}

async function testShortFollowUpFragment() {
  console.log('\n=== Short Follow-up Fragment ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('weather', '今天的天气怎么样');
  registry.setKeywords('weather', ['天气', '温度', '湿度']);

  const data = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8'));
  data.topics['weather'].messageCount = 2;
  data.topics['weather'].lastActiveAt = Date.now() - 30 * 1000;
  fs.writeFileSync(`${STATE_DIR}/topic-sessions.json`, JSON.stringify(data));

  const r = await classify('郑州哪', [], registry, config);
  assert(r.action === 'continue' && r.targetLabel === 'weather',
    `Recent short fragment "郑州哪" → continue weather (got ${r.action}/${r.targetLabel})`);
}

async function testHookPassthroughAndShortFollowUp() {
  console.log('\n=== Hook: Gateway Commands + Short Follow-up ===');
  resetState();
  const commandRegistry = new TopicRegistry(STATE_DIR);
  const baseParams = {
    registry: commandRegistry,
    config,
    stateDir: STATE_DIR,
    classifierLlmConfig: {},
    log: () => {},
  };

  const newResult = await handleBeforeDispatch({
    ...baseParams,
    event: { cleanedBody: '/NEW', sessionKey: config.targetSessionKey },
    ctx: { sessionKey: config.targetSessionKey },
  });
  assert(newResult === undefined, '/NEW gateway command → passthrough');
  assert(commandRegistry.getAll().length === 0, '/NEW gateway command → no topic created');

  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('weather', '今天的天气怎么样');
  registry.setKeywords('weather', ['天气', '温度', '湿度']);
  const data = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8'));
  data.topics['weather'].messageCount = 2;
  data.topics['weather'].lastActiveAt = Date.now() - 30 * 1000;
  fs.writeFileSync(`${STATE_DIR}/topic-sessions.json`, JSON.stringify(data));

  const result = await handleBeforeDispatch({
    ...baseParams,
    registry,
    event: { cleanedBody: '郑州哪', sessionKey: 'agent:main:main:hook-short' },
    ctx: { sessionKey: config.targetSessionKey },
  });
  assert(result?.handled === false, 'Short follow-up hook lets gateway continue');
  assert(result?.sessionKey !== config.targetSessionKey && result?.sessionKey?.includes(':weather') === true,
    `Short follow-up hook routes to weather session (got ${result?.sessionKey})`);
}

async function testExpireStaleInactive() {
  // 24h auto-end: inactive topics idle past the window become 'ended' (dropped from
  // candidate pool); active and not-yet-stale topics are untouched.
  console.log('\n=== Auto-end stale inactive topics ===');
  resetState();
  const registry = new TopicRegistry(STATE_DIR);
  registry.getOrCreate('fresh', '近期话题');
  registry.getOrCreate('stale', '陈旧话题');
  registry.getOrCreate('live', '当前话题');
  registry.setActive('live'); // fresh+stale become inactive, live is active

  const data = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8'));
  data.topics['stale'].lastActiveAt = Date.now() - 25 * 3600 * 1000; // 25h ago
  data.topics['fresh'].lastActiveAt = Date.now() - 1 * 3600 * 1000;  // 1h ago
  data.topics['live'].lastActiveAt = Date.now() - 25 * 3600 * 1000;  // old but ACTIVE
  fs.writeFileSync(`${STATE_DIR}/topic-sessions.json`, JSON.stringify(data));

  const ended = registry.expireStaleInactive(24 * 3600 * 1000);
  assert(ended === 1, `Only the stale inactive topic ended (got ${ended})`);

  const raw = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8')).topics;
  assert(raw['stale'].status === 'ended', `stale → ended (got ${raw['stale'].status})`);
  assert(raw['fresh'].status === 'inactive', `fresh (1h) stays inactive (got ${raw['fresh'].status})`);
  assert(raw['live'].status === 'active', `live stays active despite 25h idle (got ${raw['live'].status})`);
}

function testSlashLabelGuard() {
  // §3b defense-in-depth: generateTopicLabel must NOT hash slash-command text into a
  // per-command junk label (the "/NEW (vnxt)" pollution). Any "/"-prefixed content
  // collapses to the single stable "misc" bucket; real content keeps its normal label.
  console.log('\n=== Slash-command label guard (§3b backstop) ===');
  assert(generateTopicLabel('/NEW') === 'misc', `/NEW → misc (got ${generateTopicLabel('/NEW')})`);
  assert(generateTopicLabel('/reset') === 'misc', `/reset → misc (got ${generateTopicLabel('/reset')})`);
  assert(generateTopicLabel('/foobar baz') === 'misc', `/foobar → misc (got ${generateTopicLabel('/foobar baz')})`);
  // Real content unaffected: keyword pattern still wins.
  assert(generateTopicLabel('今天天气怎么样') === 'weather', `weather content → weather (got ${generateTopicLabel('今天天气怎么样')})`);
  assert(generateTopicLabel('帮我看看这段 python 代码') === 'coding', `coding content → coding (got ${generateTopicLabel('帮我看看这段 python 代码')})`);
}

async function main() {
  await testL0();
  await testNoTopics();
  await testContinuation();
  await testKeywordMatch();
  await testStickySession();
  await testSwitchBack();
  await testNoActiveTopicPassthrough();
  await testSaturationAutoNew();
  await testSaturationNotMet();
  await testRunawayValve();
  await testReferenceContinue();
  await testContinuityOverKeyword();
  await testExpireStaleInactive();
  await testShortFollowUpFragment();
  await testHookPassthroughAndShortFollowUp();
  testSlashLabelGuard();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
