import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FakeRedis } from './fake-redis.mjs';
const redis = new FakeRedis();
const realFetch = globalThis.fetch;
process.env.UPSTASH_REDIS_REST_URL = 'https://local-fake-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-secret';
// Emulates the Upstash REST HTTP JSON response protocol.
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://local-fake-redis.test')) {
    const command = JSON.parse(options.body);
    const result = await redis.command(...command);
    return new Response(JSON.stringify({ result }), { headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, options);
};
const { server } = await import('../server.mjs');
const post = async (base, route, body) => {
  const r = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
test('Full HTTP API with fake remote REST storage and two participants', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Jamlink/);
    const health = await fetch(base + '/api/health');
    assert.equal((await health.json()).redisConfigured, true);
    const owner = randomUUID(), friend = randomUUID();
    const created = await post(base, '/api/rooms', { name: 'Owner', clientId: owner });
    assert.equal(created.status, 201);
    const code = created.data.state.code;
    const joined = await post(base, `/api/rooms/${code}/join`, { name: 'Friend', clientId: friend });
    assert.equal(joined.status, 200);
    const heartbeat = await post(base, `/api/rooms/${code}/heartbeat`, { clientId: friend, token: joined.data.token });
    assert.equal(heartbeat.status, 200);
    const add = await post(base, `/api/rooms/${code}/action`, { clientId: friend, token: joined.data.token, action: { type: 'ADD', track: { videoId: 'M7lc1UVf-VE', title: 'Demo' } } });
    assert.equal(add.status, 200);
    const qs = new URLSearchParams({ id: owner, token: created.data.token });
    const got = await fetch(`${base}/api/rooms/${code}?${qs}`);
    assert.equal((await got.json()).state.current.title, 'Demo');
    const kicked = await post(base, `/api/rooms/${code}/action`, { clientId: owner, token: created.data.token, action: { type: 'KICK', participantId: friend } });
    assert.equal(kicked.status, 200);
    const failed = await fetch(`${base}/api/rooms/${code}?id=${friend}&token=${joined.data.token}`);
    assert.equal(failed.status, 403);
    const page = await fetch(`${base}/room/${code}`);
    assert.equal(page.status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('Vercel rewrite route parameter invokes the API handler', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await fetch(`${base}/api/index?route=health`);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).playback, 'youtube-video');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
