import { randomBytes, randomUUID } from 'node:crypto';

export class ClientError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const validVideoId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
export const cleanName = value => String(value ?? '').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 28) || 'Guest';
const text = (value, limit = 140) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, limit);
const round = x => Math.max(0, Math.round(x * 100) / 100);
export function secondsAt(playback, now = Date.now()) {
  return Math.max(0, playback.position + (playback.playing ? (now - playback.changedAt) / 1000 : 0));
}
export function normalizeTrack(source) {
  if (!source || !validVideoId(source.videoId)) throw new ClientError('Provide a valid YouTube video link or search result.');
  const duration = Number(source.duration);
  return {
    id: randomUUID(), videoId: source.videoId, title: text(source.title || 'YouTube video', 120),
    artist: text(source.artist || 'YouTube', 80),
    thumbnail: `https://i.ytimg.com/vi/${source.videoId}/hqdefault.jpg`,
    duration: Number.isFinite(duration) && duration > 0 && duration < 43200 ? Math.floor(duration) : null,
    addedBy: '', addedAt: Date.now()
  };
}
const randomCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(6), byte => alphabet[byte % alphabet.length]).join('');
};

// In-memory prototype: room state is lost on server restart. For real deployments use Redis.
export function makeRoomStore({ maxRooms = 500, hostGraceMs = 12000 } = {}) {
  const rooms = new Map();
  const snapshot = room => ({
    code: room.code, revision: room.revision, serverTime: Date.now(), createdAt: room.createdAt,
    hostId: room.hostId,
    participants: [...room.participants.values()].map(p => ({ id: p.clientId, name: p.name,
      online: p.connected, isHost: p.clientId === room.hostId })),
    current: room.current, queue: room.queue, history: room.history.slice(-8).reverse(), playback: room.playback
  });
  const notify = room => {
    room.revision++; room.touchedAt = Date.now();
    const payload = `data: ${JSON.stringify(snapshot(room))}\n\n`;
    for (const [res] of [...room.connections]) {
      try { res.write(payload); } catch { room.connections.delete(res); }
    }
  };
  const preferredSuccessor = room => {
    const members = [...room.participants.values()];
    return members.find(p => p.connected)?.clientId || members[0]?.clientId || null;
  };
  const assignHost = (room, id) => {
    room.hostId = id;
    room.hostDisconnectedAt = null;
    if (room.hostTimer) { clearTimeout(room.hostTimer); room.hostTimer = null; }
  };
  const promoteIfDisconnected = room => {
    if (room.hostId && room.participants.get(room.hostId)?.connected) {
      room.hostDisconnectedAt = null;
      return false;
    }
    if (!room.hostId || room.hostDisconnectedAt && Date.now() - room.hostDisconnectedAt >= hostGraceMs) {
      const successor = [...room.participants.values()].find(p => p.clientId !== room.hostId && p.connected);
      if (successor) { assignHost(room, successor.clientId); notify(room); return true; }
    }
    return false;
  };
  const scheduleHandover = room => {
    if (!room.hostId || room.participants.get(room.hostId)?.connected) return;
    if (!room.hostDisconnectedAt) room.hostDisconnectedAt = Date.now();
    if (room.hostTimer) return;
    room.hostTimer = setTimeout(() => {
      room.hostTimer = null;
      promoteIfDisconnected(room);
    }, hostGraceMs);
    room.hostTimer.unref?.();
  };
  const create = (name, clientId) => {
    if (rooms.size >= maxRooms) throw new ClientError('Server room limit reached; try later.', 503);
    let code;
    do { code = randomCode(); } while (rooms.has(code));
    const room = {
      code, createdAt: Date.now(), touchedAt: Date.now(), revision: 0,
      participants: new Map(), bannedIds: new Set(), connections: new Map(),
      current: null, queue: [], history: [], hostId: clientId,
      hostDisconnectedAt: null, hostTimer: null,
      playback: { playing: false, position: 0, changedAt: Date.now() }
    };
    rooms.set(code, room);
    try { return { room, token: join(room, name, clientId) }; }
    catch (err) { rooms.delete(code); throw err; }
  };
  const get = code => rooms.get(String(code || '').toUpperCase());
  const join = (room, name, clientId, currentToken) => {
    if (!room) throw new ClientError('Jam room not found. Check your invitation link.', 404);
    if (!/^[0-9a-f-]{36}$/i.test(String(clientId))) throw new ClientError('Invalid browser session ID.');
    if (room.bannedIds.has(clientId)) throw new ClientError('You were removed from this room by the host.', 403);
    let p = room.participants.get(clientId);
    if (p && p.token !== currentToken) throw new ClientError('This browser identity already belongs to a participant.', 403);
    if (!p && room.participants.size >= 30) throw new ClientError('This room is full (30 people).', 403);
    if (!p) {
      p = { clientId, token: randomBytes(24).toString('hex'), name: cleanName(name),
        connected: false, lastSeen: Date.now(), streams: 0 };
      room.participants.set(clientId, p);
    } else p.name = cleanName(name || p.name);
    p.lastSeen = Date.now();
    if (!room.hostId) assignHost(room, clientId);
    notify(room);
    return p.token;
  };
  const authorize = (room, clientId, token) => {
    if (!room) throw new ClientError('Room no longer exists.', 404);
    const p = room.participants.get(clientId);
    if (!p || !token || p.token !== token) throw new ClientError('Join the room to control it.', 403);
    return p;
  };
  const hostOnly = (room, id) => {
    if (room.hostId !== id) throw new ClientError('Only the current host can do that.', 403);
  };
  const setCurrent = (room, track, playing = true) => {
    if (room.current) room.history.push(room.current);
    room.history = room.history.slice(-20);
    room.current = track || null;
    room.playback = { playing: Boolean(track && playing), position: 0, changedAt: Date.now() };
  };
  const revokeConnections = (room, clientId) => {
    for (const [res, id] of [...room.connections]) if (id === clientId) {
      try { res.write('event: removed\ndata: {"message":"The host removed you from this Jam."}\n\n'); } catch { /* connection already gone */ }
      room.connections.delete(res);
      try { res.end(); } catch { /* response already closed */ }
    }
  };
  const update = (room, clientId, token, action = {}) => {
    const p = authorize(room, clientId, token);
    p.lastSeen = Date.now();
    const pb = room.playback;
    switch (action.type) {
      case 'KICK': {
        hostOnly(room, clientId);
        const target = String(action.participantId || '');
        if (target === clientId) throw new ClientError('You cannot kick yourself. Use Leave room.');
        if (!room.participants.has(target)) throw new ClientError('Participant not found.');
        room.bannedIds.add(target);
        room.participants.delete(target);
        revokeConnections(room, target);
        break;
      }
      case 'TRANSFER_HOST': {
        hostOnly(room, clientId);
        const target = room.participants.get(String(action.participantId || ''));
        if (!target) throw new ClientError('Participant not found.');
        if (target.clientId === clientId) throw new ClientError('You are already the host.');
        if (!target.connected) throw new ClientError('Choose an online participant to become host.');
        assignHost(room, target.clientId);
        break;
      }
      case 'ADD': {
        if (room.queue.length >= 150) throw new ClientError('The shared queue is full (150 tracks).');
        const track = normalizeTrack(action.track);
        track.addedBy = p.name;
        if (!room.current) setCurrent(room, track, false);
        else room.queue.push(track);
        break;
      }
      case 'PLAY':
        if (!room.current) throw new ClientError('Add a song first.');
        pb.position = round(secondsAt(pb)); pb.changedAt = Date.now(); pb.playing = true;
        break;
      case 'PAUSE':
        pb.position = round(secondsAt(pb)); pb.changedAt = Date.now(); pb.playing = false;
        break;
      case 'SEEK': {
        if (!room.current) throw new ClientError('Nothing is playing.');
        const sec = Number(action.seconds);
        if (!Number.isFinite(sec) || sec < 0) throw new ClientError('Invalid seek position.');
        pb.position = round(Math.min(sec, room.current.duration || 43200)); pb.changedAt = Date.now();
        break;
      }
      case 'NEXT': {
        if (action.expectedVideoId && room.current?.videoId !== action.expectedVideoId) return snapshot(room);
        setCurrent(room, room.queue.shift() || null, true);
        break;
      }
      case 'PREVIOUS': {
        const track = room.history.pop();
        if (!track) throw new ClientError('No previous song.');
        if (room.current) room.queue.unshift(room.current);
        room.current = track;
        room.playback = { playing: true, position: 0, changedAt: Date.now() };
        break;
      }
      case 'REMOVE': {
        const before = room.queue.length;
        room.queue = room.queue.filter(t => t.id !== action.trackId);
        if (before === room.queue.length) throw new ClientError('Track no longer in queue.');
        break;
      }
      case 'MOVE': {
        const index = room.queue.findIndex(t => t.id === action.trackId);
        if (index === -1) throw new ClientError('Track no longer in queue.');
        const target = Math.min(room.queue.length - 1, Math.max(0, index + (action.direction === 'up' ? -1 : action.direction === 'down' ? 1 : 0)));
        room.queue.splice(target, 0, ...room.queue.splice(index, 1));
        break;
      }
      case 'PLAY_NOW': {
        const idx = room.queue.findIndex(t => t.id === action.trackId);
        if (idx < 0) throw new ClientError('Track no longer in queue.');
        const [track] = room.queue.splice(idx, 1);
        setCurrent(room, track, true);
        break;
      }
      case 'CLEAR': room.queue = []; break;
      default: throw new ClientError('Unknown Jam action.');
    }
    notify(room);
    return snapshot(room);
  };
  const leave = (room, clientId, token) => {
    authorize(room, clientId, token);
    room.participants.delete(clientId);
    revokeConnections(room, clientId);
    if (room.hostId === clientId) assignHost(room, preferredSuccessor(room));
    notify(room);
  };
  const subscribe = (room, clientId, token, res) => {
    const p = authorize(room, clientId, token);
    room.connections.set(res, clientId);
    p.streams++; p.connected = true; p.lastSeen = Date.now();
    if (room.hostId === clientId) {
      room.hostDisconnectedAt = null;
      if (room.hostTimer) { clearTimeout(room.hostTimer); room.hostTimer = null; }
    } else promoteIfDisconnected(room);
    res.write(`data: ${JSON.stringify(snapshot(room))}\n\n`);
    notify(room);
    const heartbeat = setInterval(() => {
      if (!room.connections.has(res)) return;
      try { res.write(': alive\n\n'); p.lastSeen = Date.now(); } catch { /* close cleanup */ }
    }, 22000);
    heartbeat.unref?.();
    res.on('close', () => {
      clearInterval(heartbeat); room.connections.delete(res);
      if (room.participants.get(clientId) !== p) return;
      p.streams = Math.max(0, p.streams - 1); p.connected = p.streams > 0;
      if (room.hostId === clientId && !p.connected) scheduleHandover(room);
      notify(room);
    });
  };
  const cleanup = () => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      let changed = false;
      for (const [id, p] of room.participants) if (!p.connected && now - p.lastSeen > 60 * 60 * 1000) {
        room.participants.delete(id);
        if (id === room.hostId) assignHost(room, preferredSuccessor(room));
        changed = true;
      }
      if (changed) notify(room);
      promoteIfDisconnected(room);
      if (room.connections.size === 0 && now - room.touchedAt > 6 * 60 * 60 * 1000) {
        if (room.hostTimer) clearTimeout(room.hostTimer);
        rooms.delete(code);
      }
    }
  };
  return { rooms, create, get, join, authorize, snapshot, update, leave, subscribe, cleanup };
}
