/**
 * Regression tests for pending force-continue (the "resend lands in the parent topic"
 * promise). Covers: arm → next message force-continues to the target; one-shot (consumed
 * after one message); no arm → classifier untouched; quoted message outranks force-continue.
 * Run: npx tsx test-force-continue.ts
 *
 * Each case uses a fresh registry: the force-continue path goes through `continue`, which
 * calls learnKeywords — sharing one registry would let case N pollute case N+1.
 */
import { handleBeforeDispatch, setPendingForceContinue } from './src/hook-handler.js';
import { TopicRegistry } from './src/topic-registry.js';

let passed = 0, failed = 0;
const ok = (c: boolean, m: string) => { c ? (passed++, console.log(`  ✓ ${m}`)) : (failed++, console.log(`  ✗ ${m}`)); };

const config: any = {
  enabled: true, targetSessionKey: 'agent:main:main',
  classifier: { mode: 'rule', confidenceThreshold: 0.6 },
  maxTopics: 20, v4: {},
};
// No apiKey → classifier stays rule-only, never makes a network call.
const llm: any = { baseUrl: '', model: '', apiKey: '' };
const log = (..._a: unknown[]) => {};

let n = 0;
function fresh() {
  const tmp = `/tmp/tr-test-${process.pid}-${n++}`;
  const registry = new TopicRegistry(tmp);
  const parent = registry.getOrCreate('meeting', '会议总结');
  const wrong = registry.getOrCreate('verifyc', '验证C');
  registry.setActive(wrong.label); // active is the mis-created topic, like the real bug
  const INBOUND = 'agent:main:main';
  const mk = (body: string, quoted?: string) => ({
    event: { cleanedBody: body, quotedMessage: quoted },
    ctx: { sessionKey: INBOUND },
    registry, config, stateDir: tmp, classifierLlmConfig: llm, log,
  });
  return { registry, parent, wrong, INBOUND, mk };
}

(async () => {
  // 1. Armed → the next message force-continues into the parent topic's session.
  {
    const { parent, INBOUND, mk } = fresh();
    setPendingForceContinue(INBOUND, parent.label);
    const r: any = await handleBeforeDispatch(mk('先用A验证效果，再升级到C'));
    ok(r?.sessionKey === parent.sessionKey, 'armed → force-continue into parent');
  }
  // 2. One-shot: after the armed message is consumed, a later unrelated message is no
  //    longer forced back (active is reset to simulate "no longer in parent").
  {
    const { registry, parent, wrong, INBOUND, mk } = fresh();
    setPendingForceContinue(INBOUND, parent.label);
    await handleBeforeDispatch(mk('第一条任意消息')); // consumes the arm
    registry.setActive(wrong.label);
    const r: any = await handleBeforeDispatch(mk('帮我查下明天的航班时刻'));
    ok(r?.sessionKey !== parent.sessionKey, `one-shot: not forced back after consume (got ${r?.sessionKey})`);
  }
  // 3. No arm → classifier behaves normally, message does not leak into parent.
  {
    const { parent, mk } = fresh();
    const r: any = await handleBeforeDispatch(mk('帮我查下明天的航班时刻'));
    ok(r?.sessionKey !== parent.sessionKey, `no arm → no leak into parent (got ${r?.sessionKey})`);
  }
  // 4. A quoted topic footer outranks force-continue (explicit user intent wins).
  {
    const { parent, wrong, INBOUND, mk } = fresh();
    setPendingForceContinue(INBOUND, parent.label);
    const r: any = await handleBeforeDispatch(mk('继续这个', '某条历史回复\n📌 话题: 验证C'));
    ok(r?.sessionKey === wrong.sessionKey, `quote outranks force-continue (got ${r?.sessionKey})`);
  }

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
