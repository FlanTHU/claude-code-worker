/**
 * Quick local test for classifier logic (rules-only, no LLM).
 * Run: npx tsx test-classifier.ts
 */

import { classify, parseExplicitCommand, matchKeywords, detectContinuation } from './src/classifier.js';
import { TopicRegistry } from './src/topic-registry.js';
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

  r = parseExplicitCommand('/new my-topic');
  assert(r?.action === 'new' && r.targetLabel === 'my-topic', '/new my-topic → new, label=my-topic');

  r = parseExplicitCommand('/new');
  assert(r?.action === 'new' && r.targetLabel === null, '/new → new, label=null');

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
  assert(r.action === 'passthrough', `No topics, substantial message → passthrough (got ${r.action})`);

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

  // Simulate many msgs but recent activity
  const data = JSON.parse(fs.readFileSync(`${STATE_DIR}/topic-sessions.json`, 'utf-8'));
  data.topics['coding'].messageCount = 15;
  data.topics['coding'].lastActiveAt = Date.now() - 5 * 60 * 1000; // 5 min ago
  fs.writeFileSync(`${STATE_DIR}/topic-sessions.json`, JSON.stringify(data));

  const r2 = await classify('明天天气怎么样啊？', [], registry, config);
  assert(r2.action === 'continue', `High msgs but recent (5min) → continue (got ${r2.action})`);
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

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
