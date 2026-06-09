/**
 * Tests for the no-context detector used by auto-switch-back (feature B).
 * Run: npx tsx test-no-context.ts
 */

import { looksLikeNoContext, extractAssistantText } from './src/no-context-detect.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

// ── Positive: explicit "no prior context" declarations must be detected ──
console.log('\n=== Positive: no-context declarations ===');
const positives = [
  '这是个新会话，我这边没有之前的上下文。',
  '抱歉，我没有之前的对话记录，麻烦你补充下背景。',
  '当前是一个新的对话，不知道你指的是哪个文件。',
  '我这边缺乏相关上下文，能说明下吗？',
  '我没有你之前提到的那份文档的信息。',
  '不清楚你说的是哪个，之前的对话我看不到。',
  'This is a new session, I have no prior context.',
  "Sorry, I don't have access to the previous conversation.",
  'I lack any earlier context for this request.',
];
for (const t of positives) {
  assert(looksLikeNoContext(t), `detect: "${t.slice(0, 24)}…"`);
}

// ── Negative: normal replies / clarifying questions must NOT be flagged ──
// Critical: a generic clarifying question on a LEGIT new topic must not be treated as
// a mis-route, or real new topics get merged back (re-triggers topic-collapse).
console.log('\n=== Negative: normal replies & clarifying questions ===');
const negatives = [
  '给你汇总过去一个月的会议数据如下：……',
  '你想查哪个时间段的日程？我可以帮你拉出来。',  // clarifying, but NOT a no-context claim
  '请问你要创建的群聊叫什么名字？',
  '好的，已经帮你创建了文档，标题是「Q2 计划」。',
  '这个问题有多种方案，你更看重性能还是可维护性？',
  'Which folder should I upload the file to?',
  'I can do that — what should the spreadsheet be named?',
  '武汉总部今天食堂的菜单是：宫保鸡丁、麻婆豆腐……',
];
for (const t of negatives) {
  assert(!looksLikeNoContext(t), `ignore: "${t.slice(0, 24)}…"`);
}

// ── extractAssistantText across event shapes ──
console.log('\n=== extractAssistantText: event shapes ===');
assert(extractAssistantText({ lastAssistant: 'hello' }) === 'hello', 'lastAssistant string');
assert(extractAssistantText({ assistantTexts: ['a', 'b'] }) === 'a\nb', 'assistantTexts array');
assert(
  extractAssistantText({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'ans' }] }) === 'ans',
  'messages with string content'
);
assert(
  extractAssistantText({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'partans' }] }] }) === 'partans',
  'messages with content parts'
);
assert(extractAssistantText({ text: 'tx' }) === 'tx', 'generic text field');
assert(extractAssistantText({ content: 'ct' }) === 'ct', 'generic content field');
assert(extractAssistantText({}) === '', 'empty event → empty string');
assert(extractAssistantText(null) === '', 'null event → empty string');

// ── End-to-end: extract then detect ──
console.log('\n=== End-to-end: extract + detect ===');
assert(
  looksLikeNoContext(extractAssistantText({ lastAssistant: '这是个新会话，我没有之前的上下文' })),
  'extract+detect: no-context reply flagged'
);
assert(
  !looksLikeNoContext(extractAssistantText({ lastAssistant: '已帮你创建群聊并改好名称' })),
  'extract+detect: normal reply not flagged'
);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
