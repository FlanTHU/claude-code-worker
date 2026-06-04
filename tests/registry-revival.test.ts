/**
 * Registry revival tests — ended topics must NOT be revived in place.
 *
 * Covers the fix for the "/endall ghost revival" bug: once a topic is ended,
 * any re-activation (auto-route continue, /switch, /new same-name) allocates a
 * fresh label + sessionKey so the old gateway context stays detached.
 *
 * Run: npx tsx --test tests/registry-revival.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { TopicRegistry } from '../src/topic-registry.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'topic-router-rev-'));
}
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('TopicRegistry — ended topics are not revived in place', () => {
  let stateDir: string;
  beforeEach(() => { stateDir = makeTmpDir(); });

  it('getOrCreate on an active topic reuses the same entry/sessionKey', () => {
    const reg = new TopicRegistry(stateDir);
    const a = reg.getOrCreate('redis', 'Redis缓存');
    const b = reg.getOrCreate('redis');
    assert.equal(b.label, a.label);
    assert.equal(b.sessionKey, a.sessionKey);
    cleanup(stateDir);
  });

  it('getOrCreate on an ENDED topic creates a fresh sibling with a new sessionKey', () => {
    const reg = new TopicRegistry(stateDir);
    const first = reg.getOrCreate('redis', 'Redis缓存');
    const firstKey = first.sessionKey;
    reg.markEnded('redis');

    const revived = reg.getOrCreate('redis');
    assert.notEqual(revived.label, 'redis', 'should not reuse the ended label');
    assert.equal(revived.label, 'redis-2');
    assert.notEqual(revived.sessionKey, firstKey, 'must get a new sessionKey');
    assert.equal(revived.sessionKey, 'agent:main:topic:redis-2');
    assert.equal(revived.status, 'active');
    assert.equal(revived.messageCount, 1, 'fresh sibling starts clean');
    cleanup(stateDir);
  });

  it('the original ended entry stays ended and is hidden from listings', () => {
    const reg = new TopicRegistry(stateDir);
    reg.getOrCreate('redis');
    reg.markEnded('redis');
    reg.getOrCreate('redis'); // -> redis-2

    const ended = reg.get('redis');
    assert.equal(ended?.status, 'ended', 'old entry preserved as ended');
    const visible = reg.getAll().map(t => t.label);
    assert.ok(!visible.includes('redis'), 'ended topic hidden from getAll');
    assert.ok(visible.includes('redis-2'), 'fresh sibling visible');
    cleanup(stateDir);
  });

  it('setActive on an ended topic activates a fresh sibling, not the ended one', () => {
    const reg = new TopicRegistry(stateDir);
    const first = reg.getOrCreate('topic-x');
    reg.markEnded('topic-x');

    const activated = reg.setActive('topic-x');
    assert.ok(activated, 'setActive returns the activated entry');
    assert.equal(activated!.label, 'topic-x-2');
    assert.notEqual(activated!.sessionKey, first.sessionKey);
    assert.equal(reg.getActive()?.label, 'topic-x-2');
    cleanup(stateDir);
  });

  it('setActive on a non-ended topic returns the same entry (no churn)', () => {
    const reg = new TopicRegistry(stateDir);
    const a = reg.getOrCreate('alpha');
    reg.getOrCreate('beta'); // active = beta
    const activated = reg.setActive('alpha');
    assert.equal(activated?.label, a.label);
    assert.equal(activated?.sessionKey, a.sessionKey);
    cleanup(stateDir);
  });

  it('setActive on an unknown topic returns undefined', () => {
    const reg = new TopicRegistry(stateDir);
    assert.equal(reg.setActive('nope'), undefined);
    cleanup(stateDir);
  });

  it('repeated end+revive increments the sibling suffix', () => {
    const reg = new TopicRegistry(stateDir);
    reg.getOrCreate('chat');
    reg.markEnded('chat');
    const r2 = reg.getOrCreate('chat');
    assert.equal(r2.label, 'chat-2');
    reg.markEnded('chat-2');
    const r3 = reg.getOrCreate('chat');
    assert.equal(r3.label, 'chat-3');
    cleanup(stateDir);
  });

  it('simulates /endall then a follow-up message: new session, old context detached', () => {
    const reg = new TopicRegistry(stateDir);
    // user worked on two topics
    reg.getOrCreate('工作', '工作');
    reg.getOrCreate('健身', '健身');
    // /endall
    for (const t of reg.getAll()) reg.markEnded(t.label);
    assert.equal(reg.getAll().length, 0, 'all topics archived');
    assert.equal(reg.getActive(), null, 'no active topic after endall');

    // follow-up message that the classifier maps back to label "工作"
    const revived = reg.getOrCreate('工作');
    assert.equal(revived.label, '工作-2');
    assert.notEqual(revived.sessionKey, 'agent:main:topic:工作');
    cleanup(stateDir);
  });

  it('persists fresh-sibling state across reload', () => {
    const reg = new TopicRegistry(stateDir);
    reg.getOrCreate('persist');
    reg.markEnded('persist');
    const revived = reg.getOrCreate('persist');
    assert.equal(revived.label, 'persist-2');

    const reg2 = new TopicRegistry(stateDir); // reloads from disk
    assert.equal(reg2.get('persist')?.status, 'ended');
    assert.equal(reg2.getActive()?.label, 'persist-2');
    cleanup(stateDir);
  });
});
