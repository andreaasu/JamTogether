import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeRoomStore, ClientError, secondsAt, normalizeTrack } from '../room.mjs';

const sample = id => ({ videoId: id, title: 'Sample track', artist: 'Artist', duration: 240 });
const a = 'dQw4w9WgXcQ', b = 'M7lc1UVf-VE', c = 'jfKfPfyJRdk';
function start() {
  const store = makeRoomStore();
  const id1 = randomUUID(), id2 = randomUUID();
  const { room, token: token1 } = store.create('Alex', id1);
  const token2 = store.join(room, 'Jamie', id2);
  const act = (type, fields = {}, id = id1, token = token1) => store.update(room, id, token, { type, ...fields });
  return { store, room, id1, id2, token1, token2, act };
}
test('create rooms and join, same room snapshot visible to two participants', () => {
  const { room, store, id1, id2 } = start();
  assert.equal(room.code.length, 6);
  assert.equal(store.get(room.code), room);
  assert.equal(store.snapshot(room).participants.length, 2);
  assert.ok(store.snapshot(room).participants.some(x => x.id === id1));
  assert.ok(store.snapshot(room).participants.some(x => x.id === id2));
});
test('only valid membership token may mutate', () => {
  const { act, id2 } = start();
  assert.throws(() => act('ADD', { track: sample(a) }, id2, 'bad-token'), { status: 403 });
});
test('adding first track cues it, later tracks are queued', () => {
  const { room, act, id2, token2 } = start();
  act('ADD', { track: sample(a) });
  act('ADD', { track: sample(b) }, id2, token2);
  assert.equal(room.current.videoId, a);
  assert.equal(room.playback.playing, false);
  assert.equal(room.queue[0].videoId, b);
  assert.equal(room.queue[0].addedBy, 'Jamie');
});
test('play pause seek keeps shared server position', () => {
  const { room, act } = start();
  act('ADD', { track: sample(a) });
  act('PLAY');
  assert.equal(room.playback.playing, true);
  act('SEEK', { seconds: 48 });
  assert.ok(secondsAt(room.playback) >= 48);
  act('PAUSE');
  assert.equal(room.playback.playing, false);
  assert.ok(room.playback.position >= 48);
});
test('next is idempotent when participants both report same ended track', () => {
  const { room, act, id2, token2 } = start();
  [a,b,c].forEach(videoId => act('ADD', { track: sample(videoId) }));
  act('NEXT', { expectedVideoId: a });
  act('NEXT', { expectedVideoId: a }, id2, token2);
  assert.equal(room.current.videoId, b);
  assert.equal(room.queue.length, 1);
});
test('reorder, remove, play now, previous and clear queue', () => {
  const { room, act } = start();
  [a,b,c].forEach(videoId => act('ADD', { track: sample(videoId) }));
  const itemId = room.queue[1].id;
  act('MOVE', { trackId: itemId, direction: 'up' });
  assert.equal(room.queue[0].videoId, c);
  act('PLAY_NOW', { trackId: itemId });
  assert.equal(room.current.videoId, c);
  act('PREVIOUS');
  assert.equal(room.current.videoId, a);
  act('REMOVE', { trackId: room.queue[0].id });
  act('CLEAR');
  assert.equal(room.queue.length, 0);
});
test('invalid track ID, oversized room names, invalid seek are rejected or sanitized', () => {
  const { act } = start();
  assert.throws(() => normalizeTrack({ videoId: '../../secret' }), ClientError);
  assert.throws(() => act('SEEK', { seconds: -2 }), ClientError);
  assert.throws(() => act('ADD', { track: sample('not-valid') }), ClientError);
});
test('leaving removes participant and invalidates session', () => {
  const { room, store, id2, token2 } = start();
  store.leave(room, id2, token2);
  assert.equal(store.snapshot(room).participants.length, 1);
  assert.throws(() => store.authorize(room, id2, token2), { status: 403 });
});

import { EventEmitter } from 'node:events';
const connection = () => {
  const res = new EventEmitter();
  res.data = [];
  res.write = item => { res.data.push(item); return true; };
  res.end = () => res.emit('close');
  return res;
};

test('creator starts as host; others cannot kick or transfer', () => {
  const { store, room, id1, id2, token2, act } = start();
  assert.equal(store.snapshot(room).hostId, id1);
  assert.throws(() => act('KICK', { participantId: id1 }, id2, token2), { status: 403 });
  assert.throws(() => act('TRANSFER_HOST', { participantId: id1 }, id2, token2), { status: 403 });
});

test('host may give an online participant control; previous host loses moderation rights', () => {
  const { store, room, id1, id2, token2, act } = start();
  const conn = connection();
  const hostConn = connection();
  store.subscribe(room, id1, room.participants.get(id1).token, hostConn);
  store.subscribe(room, id2, token2, conn);
  act('TRANSFER_HOST', { participantId: id2 });
  assert.equal(store.snapshot(room).hostId, id2);
  assert.throws(() => act('KICK', { participantId: id2 }), { status: 403 });
  assert.throws(() => act('TRANSFER_HOST', { participantId: id1 }), { status: 403 });
  act('TRANSFER_HOST', { participantId: id1 }, id2, token2);
  assert.equal(room.hostId, id1);
  conn.emit('close'); hostConn.emit('close');
});

test('host can kick and revoke active SSE session, and kicked browser cannot rejoin', () => {
  const { room, store, id1, id2, token2, act } = start();
  const conn = connection();
  store.subscribe(room, id2, token2, conn);
  act('KICK', { participantId: id2 });
  assert.equal(room.participants.has(id2), false);
  assert.ok(conn.data.some(chunk => chunk.includes('event: removed')));
  assert.throws(() => store.authorize(room, id2, token2), { status: 403 });
  assert.throws(() => store.join(room, 'Back again', id2), { status: 403 });
  assert.throws(() => act('KICK', { participantId: id1 }), ClientError);
});

test('explicit host leave immediately transfers host to an existing participant', () => {
  const { room, store, id1, id2, token1 } = start();
  store.leave(room, id1, token1);
  assert.equal(room.hostId, id2);
  assert.equal(store.snapshot(room).participants.find(p => p.id === id2).isHost, true);
});

test('host disconnect automatically transfers after grace period, not immediately', async () => {
  const store = makeRoomStore({ hostGraceMs: 16 });
  const id1 = randomUUID(), id2 = randomUUID();
  const { room, token: token1 } = store.create('Host', id1);
  const token2 = store.join(room, 'Friend', id2);
  const hostConn = connection(), otherConn = connection();
  store.subscribe(room, id1, token1, hostConn);
  store.subscribe(room, id2, token2, otherConn);
  hostConn.emit('close');
  assert.equal(room.hostId, id1);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(room.hostId, id2);
  assert.equal(store.snapshot(room).participants.find(p => p.id === id2).isHost, true);
  otherConn.emit('close');
});

test('temporary host disconnect that reconnects during grace does not transfer role', async () => {
  const store = makeRoomStore({ hostGraceMs: 20 });
  const id1 = randomUUID(), id2 = randomUUID();
  const { room, token: token1 } = store.create('Host', id1);
  const token2 = store.join(room, 'Friend', id2);
  const h = connection(), f = connection();
  store.subscribe(room, id1, token1, h);
  store.subscribe(room, id2, token2, f);
  h.emit('close');
  const again = connection();
  store.subscribe(room, id1, token1, again);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(room.hostId, id1);
  again.emit('close'); f.emit('close');
});
