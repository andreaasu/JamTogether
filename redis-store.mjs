import { randomBytes, randomUUID } from 'node:crypto';
import { ClientError, cleanName, normalizeTrack, secondsAt } from './room.mjs';

// The Vercel backend intentionally uses a REST datastore instead of process memory.
// Changes to one room are serialized by a short-lived Redis lock.
const ttlSeconds = 6 * 60 * 60;
const liveForMs = 20_000;
const hostGraceMs = 12_000;
const roomKey = code => `jamlink:v2:room:${code}`;
const lockKey = code => `jamlink:v2:lock:${code}`;
const isId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
const round = x => Math.max(0, Math.round(x * 100) / 100);
const chooseHost = (room, now, except) => room.participants.find(p => p.id !== except && now - p.lastSeen < liveForMs)?.id || null;
const online = (p, now) => now - p.lastSeen < liveForMs;
const makeCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), n => alphabet[n % alphabet.length]).join('');
};

export class UpstashRest {
  constructor(url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN) {
    if (!url || !token) throw new ClientError('Redis is not configured. Add both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel.', 503);
    this.url = url.replace(/\/$/, ''); this.token = token;
  }
  async command(...parts) {
    let res;
    try {
      res = await fetch(this.url, { method: 'POST', headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(parts), signal: AbortSignal.timeout(7500), cache: 'no-store' });
    } catch { throw new ClientError('Database connection failed. Please try again.', 503); }
    if (!res.ok) throw new ClientError(`Database unavailable (HTTP ${res.status}).`, 503);
    const response = await res.json();
    if (response.error) throw new ClientError('Database command failed: ' + String(response.error).slice(0, 90), 503);
    return response.result;
  }
}

export function createRedisRoomStore(redis) {
  async function load(code) {
    const raw = await redis.command('GET', roomKey(code));
    const room = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    if (!room) throw new ClientError('Jam room not found or expired. Ask for a new invite.', 404);
    return room;
  }
  const snapshot = (room, now = Date.now()) => ({
    code: room.code, revision: room.revision, serverTime: now, createdAt: room.createdAt,
    hostId: room.hostId,
    participants: room.participants.map(p => ({ id: p.id, name: p.name, online: online(p, now), isHost: room.hostId === p.id })),
    current: room.current, queue: room.queue, history: room.history.slice(-8).reverse(), playback: room.playback
  });
  function auth(room, id, token) {
    const p = room.participants.find(p => p.id === id);
    if (!p || !token || p.token !== token) throw new ClientError('You are no longer in this Jam. Rejoin using the invitation link.', 403);
    return p;
  }
  function promote(room, now) {
    const host = room.participants.find(p => p.id === room.hostId);
    if (host && now - host.lastSeen < liveForMs + hostGraceMs) return false;
    const successor = chooseHost(room, now, room.hostId);
    if (!successor) return false;
    room.hostId = successor;
    return true;
  }
  async function withLock(code, fn) {
    const lock = lockKey(code), owner = randomUUID();
    let acquired = false;
    for (let attempt = 0; attempt < 35; attempt++) {
      if (await redis.command('SET', lock, owner, 'PX', '7000', 'NX') === 'OK') { acquired = true; break; }
      await new Promise(resolve => setTimeout(resolve, 35 + Math.floor(Math.random() * 35)));
    }
    if (!acquired) throw new ClientError('Room is busy. Try again.', 503);
    try {
      const room = await load(code);
      const now = Date.now();
      const result = await fn(room, now);
      // Save to Redis and refresh the room TTL. No tokens leave this datastore.
      if (result?.save !== false) {
        room.revision++;
        await redis.command('SET', roomKey(code), JSON.stringify(room), 'EX', ttlSeconds);
      }
      return { room, value: result?.value };
    } finally {
      const script = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
      try { await redis.command('EVAL', script, '1', lock, owner); } catch (e) { console.warn('Lock cleanup:', e.message); }
    }
  }
  async function create(name, id) {
    if (!isId(id)) throw new ClientError('Invalid browser session ID.');
    const now = Date.now();
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = makeCode();
      const token = randomBytes(24).toString('hex');
      const room = { code, createdAt: now, revision: 1,
        hostId: id, bannedIds: [], participants: [{ id, token, name: cleanName(name), lastSeen: now }],
        current: null, queue: [], history: [], playback: { playing: false, position: 0, changedAt: now }
      };
      const result = await redis.command('SET', roomKey(code), JSON.stringify(room), 'EX', ttlSeconds, 'NX');
      if (result === 'OK') return { token, state: snapshot(room) };
    }
    throw new ClientError('Could not create a unique room. Try again.', 503);
  }
  async function join(code, name, id, previousToken) {
    if (!isId(id)) throw new ClientError('Invalid browser session ID.');
    const { room, value } = await withLock(code, async (room, now) => {
      if (room.bannedIds.includes(id)) throw new ClientError('The host removed this browser from the Jam.', 403);
      let participant = room.participants.find(p => p.id === id);
      if (participant && participant.token !== previousToken) throw new ClientError('This browser identity already belongs to a participant.', 403);
      if (!participant && room.participants.length >= 30) throw new ClientError('The room is full (30 participants).', 403);
      if (!participant) {
        participant = { id, token: randomBytes(24).toString('hex'), name: cleanName(name), lastSeen: now };
        room.participants.push(participant);
      } else { participant.name = cleanName(name || participant.name); participant.lastSeen = now; }
      if (!room.hostId) room.hostId = id;
      promote(room, now);
      return { value: participant.token };
    });
    return { token: value, state: snapshot(room) };
  }
  async function getState(code, id, token) {
    let room = await load(code);
    auth(room, id, token);
    if (promote(room, Date.now())) {
      room = (await withLock(code, async (r, now) => { auth(r, id, token); return { save: promote(r, now) }; })).room;
    }
    return snapshot(room);
  }
  async function heartbeat(code, id, token) {
    const { room } = await withLock(code, async (room, now) => {
      auth(room, id, token).lastSeen = now;
      promote(room, now);
    });
    return snapshot(room);
  }
  const setCurrent = (room, track, playing, now) => {
    if (room.current) room.history.push(room.current);
    room.history = room.history.slice(-20);
    room.current = track || null;
    room.playback = { playing: Boolean(track && playing), position: 0, changedAt: now };
  };
  async function action(code, id, token, action = {}) {
    const { room } = await withLock(code, async (room, now) => {
      const p = auth(room, id, token);
      p.lastSeen = now;
      promote(room, now);
      const pb = room.playback;
      switch (action?.type) {
        case 'KICK': {
          if (room.hostId !== id) throw new ClientError('Only the host can do that.', 403);
          const target = String(action.participantId || '');
          if (target === id) throw new ClientError('Use Leave room instead.');
          if (!room.participants.some(x => x.id === target)) throw new ClientError('Participant not found.');
          room.bannedIds.push(target); room.participants = room.participants.filter(x => x.id !== target);
          break;
        }
        case 'TRANSFER_HOST': {
          if (room.hostId !== id) throw new ClientError('Only the host can do that.', 403);
          const target = room.participants.find(p => p.id === action.participantId);
          if (!target || !online(target, now)) throw new ClientError('Choose an online participant.');
          if (target.id === id) throw new ClientError('You are already the host.');
          room.hostId = target.id; break;
        }
        case 'ADD': {
          if (room.queue.length >= 150) throw new ClientError('Queue is full (150 tracks).');
          const track = normalizeTrack(action.track); track.addedBy = p.name;
          if (!room.current) setCurrent(room, track, false, now); else room.queue.push(track);
          break;
        }
        case 'PLAY':
          if (!room.current) throw new ClientError('Add a track first.');
          pb.position = round(secondsAt(pb, now)); pb.changedAt = now; pb.playing = true; break;
        case 'PAUSE':
          pb.position = round(secondsAt(pb, now)); pb.changedAt = now; pb.playing = false; break;
        case 'SEEK': {
          if (!room.current) throw new ClientError('Nothing playing.');
          const sec = Number(action.seconds);
          if (!Number.isFinite(sec) || sec < 0) throw new ClientError('Invalid seek position.');
          pb.position = round(Math.min(sec, room.current.duration || 43200)); pb.changedAt = now; break;
        }
        case 'NEXT':
          if (action.expectedVideoId && room.current?.videoId !== action.expectedVideoId) return { save: false };
          setCurrent(room, room.queue.shift() || null, true, now); break;
        case 'PREVIOUS': {
          const track = room.history.pop(); if (!track) throw new ClientError('No previous track.');
          if (room.current) room.queue.unshift(room.current);
          room.current = track; room.playback = { playing: true, position: 0, changedAt: now }; break;
        }
        case 'REMOVE': {
          const before = room.queue.length; room.queue = room.queue.filter(t => t.id !== action.trackId);
          if (before === room.queue.length) throw new ClientError('Track no longer in queue.'); break;
        }
        case 'MOVE': {
          const index = room.queue.findIndex(t => t.id === action.trackId);
          if (index < 0) throw new ClientError('Track not found.');
          const change = action.direction === 'up' ? -1 : action.direction === 'down' ? 1 : 0;
          const target = Math.max(0, Math.min(room.queue.length - 1, index + change));
          room.queue.splice(target, 0, ...room.queue.splice(index, 1)); break;
        }
        case 'PLAY_NOW': {
          const idx = room.queue.findIndex(t => t.id === action.trackId);
          if (idx < 0) throw new ClientError('Track not found.');
          const [track] = room.queue.splice(idx, 1); setCurrent(room, track, true, now); break;
        }
        case 'CLEAR': room.queue = []; break;
        default: throw new ClientError('Unknown Jam action.');
      }
    });
    return snapshot(room);
  }
  async function leave(code, id, token) {
    await withLock(code, async (room, now) => {
      auth(room, id, token);
      room.participants = room.participants.filter(p => p.id !== id);
      if (room.hostId === id) room.hostId = chooseHost(room, now, id) || room.participants[0]?.id || null;
    });
    return { ok: true };
  }
  return { create, join, getState, heartbeat, action, leave, snapshot, load };
}
