import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRedisRoomStore } from '../redis-store.mjs';
import { FakeRedis } from './fake-redis.mjs';
const track = id => ({ videoId: id, title: 'A test song' });
const makes = () => {
  const redis = new FakeRedis();
  return { redis, a: createRedisRoomStore(redis), b: createRedisRoomStore(redis) };
};
test('Redis room persists across two independent server instances', async () => {
  const { a, b } = makes();
  const owner = randomUUID(), friend = randomUUID();
  const created = await a.create('Owner', owner);
  const code = created.state.code;
  const joined = await b.join(code, 'Friend', friend);
  assert.equal(joined.state.participants.length, 2);
  await b.action(code, friend, joined.token, { type: 'ADD', track: track('M7lc1UVf-VE') });
  const updated = await a.getState(code, owner, created.token);
  assert.equal(updated.current.videoId, 'M7lc1UVf-VE');
  assert.equal(updated.hostId, owner);
});
test('Host can kick participants; kicked token cannot poll or rejoin', async () => {
  const { a, b } = makes();
  const owner = randomUUID(), friend = randomUUID();
  const created = await a.create('Owner', owner), code = created.state.code;
  const joined = await b.join(code, 'Friend', friend);
  await a.action(code, owner, created.token, { type: 'KICK', participantId: friend });
  await assert.rejects(b.getState(code, friend, joined.token), /no longer/i);
  await assert.rejects(b.join(code, 'Friend', friend, joined.token), /removed/i);
});
test('Host transfer only permitted to current host', async () => {
  const { a, b } = makes();
  const owner = randomUUID(), friend = randomUUID();
  const created = await a.create('Owner', owner), code = created.state.code;
  const joined = await b.join(code, 'Friend', friend);
  await assert.rejects(b.action(code, friend, joined.token, { type: 'TRANSFER_HOST', participantId: owner }), /Only the host/);
  await a.action(code, owner, created.token, { type: 'TRANSFER_HOST', participantId: friend });
  assert.equal((await b.getState(code, friend, joined.token)).hostId, friend);
});
test('Host leaving promotes participant; disconnected host promotes after grace', async () => {
  const { a, b, redis } = makes();
  const owner = randomUUID(), friend = randomUUID();
  const created = await a.create('Owner', owner), code = created.state.code;
  const joined = await b.join(code, 'Friend', friend);
  const key = `jamlink:v2:room:${code}`;
  const r = JSON.parse(redis.data.get(key));
  r.participants.find(p => p.id === owner).lastSeen = Date.now() - 40_000;
  redis.data.set(key, JSON.stringify(r));
  const s = await b.getState(code, friend, joined.token);
  assert.equal(s.hostId, friend);
  await b.leave(code, friend, joined.token);
  assert.equal((await a.getState(code, owner, created.token)).participants.length, 1);
});
test('Simultaneous NEXT calls do not skip two tracks with expectedVideoId', async () => {
  const { a, b } = makes();
  const owner = randomUUID(), friend = randomUUID();
  const created = await a.create('Owner', owner), code = created.state.code;
  const joined = await b.join(code, 'Friend', friend);
  await a.action(code, owner, created.token, { type: 'ADD', track: track('M7lc1UVf-VE') });
  await a.action(code, owner, created.token, { type: 'ADD', track: track('dQw4w9WgXcQ') });
  await a.action(code, owner, created.token, { type: 'ADD', track: track('5qap5aO4i9A') });
  await Promise.all([
    a.action(code, owner, created.token, { type: 'NEXT', expectedVideoId: 'M7lc1UVf-VE' }),
    b.action(code, friend, joined.token, { type: 'NEXT', expectedVideoId: 'M7lc1UVf-VE' })
  ]);
  const result = await b.getState(code, friend, joined.token);
  assert.equal(result.current.videoId, 'dQw4w9WgXcQ');
  assert.equal(result.queue.length, 1);
});
