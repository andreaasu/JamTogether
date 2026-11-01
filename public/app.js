const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = value => String(value || '').trim();
const storeId = 'jamlink-browser-id';
let clientId = sessionStorage.getItem(storeId);
if (!clientId || !/^[\da-f-]{36}$/i.test(clientId)) {
  clientId = crypto.randomUUID();
  sessionStorage.setItem(storeId, clientId);
}
let nick = localStorage.getItem('jamlink-nickname') || '';
let code = null;
let token = null;
let snapshot = null;
let source = null;
let ytReady = false;
let player = null;
let playerReady = false;
let playerVideo = null;
let audioEnabled = false;
let lastAppliedPlayState = null;
let suppressionUntil = 0;
let offset = 0;
let seeking = false;
let searchItems = [];
let timerId = null;
let toastTimer;
// YouTube's official, visible embedded player is the only playback option.

$('lobby-name').value = nick;
$('modal-name').value = nick;

function toast(message, error = false) {
  const box = $('toast');
  box.textContent = message;
  box.className = `show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.className = '', 4200);
}
async function api(path, data) {
  const r = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  let payload;
  try { payload = await r.json(); } catch { throw Error('Cannot reach the server. Check your internet.'); }
  if (!r.ok) throw Error(payload.error || 'Something went wrong.');
  return payload;
}
function saveName(value) {
  nick = clean(value).slice(0, 28) || 'Guest';
  localStorage.setItem('jamlink-nickname', nick);
  $('lobby-name').value = nick;
  $('modal-name').value = nick;
}
function fromLink(raw) {
  const value = clean(raw);
  if (/^[a-z0-9]{6}$/i.test(value)) return value.toUpperCase();
  try { const u = new URL(value); return u.pathname.match(/\/room\/([a-z0-9]{6})/i)?.[1].toUpperCase() || ''; } catch { return ''; }
}
function fromYouTubeLink(raw) {
  const value = clean(raw);
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    if (host === 'youtu.be' || host === 'www.youtu.be') return /^[A-Za-z0-9_-]{11}$/.test(u.pathname.split('/')[1]) ? u.pathname.split('/')[1] : '';
    if (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'www.youtube-nocookie.com') {
      const id = u.searchParams.get('v') || u.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/)?.[1];
      return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : '';
    }
  } catch { /* invalid URL */ }
  return '';
}
const invitation = () => `${location.origin}/room/${code}`;
async function copyInvite() {
  if (!code) return;
  try { await navigator.clipboard.writeText(invitation()); toast('Invite link copied! Send it to your friends ✳'); }
  catch { window.prompt('Copy this invitation link:', invitation()); }
}

async function createRoom() {
  const button = $('create-btn');
  button.disabled = true;
  try {
    saveName($('lobby-name').value);
    const result = await api('/api/rooms', { name: nick, clientId });
    enterRoom(result.state.code, result.token, result.state);
    toast('Your Jam is live! Invite your crew.');
  } catch (e) { toast(e.message, true); }
  finally { button.disabled = false; }
}
function showJoinModal(roomCode) {
  code = roomCode;
  $('modal-room-code').textContent = roomCode;
  $('modal-name').value = nick;
  $('join-modal').classList.remove('hidden');
  setTimeout(() => $('modal-name').focus(), 20);
}
async function joinRoom(roomCode, name) {
  const button = $('modal-join-btn');
  button.disabled = true;
  try {
    saveName(name);
    const saved = sessionStorage.getItem(`jamlink-token-${roomCode}`);
    const result = await api(`/api/rooms/${roomCode}/join`, { name: nick, clientId, token: saved });
    enterRoom(roomCode, result.token, result.state);
    toast(`You're in! Welcome to Jam ${roomCode}.`);
  } catch (e) { toast(e.message, true); }
  finally { button.disabled = false; }
}
function enterRoom(roomCode, newToken, initial) {
  if (source) source.close();
  code = roomCode; token = newToken;
  sessionStorage.setItem(`jamlink-token-${code}`, token);
  history.replaceState({}, '', `/room/${code}`);
  $('lobby').classList.add('hidden');
  $('join-modal').classList.add('hidden');
  $('room-view').classList.remove('hidden');
  document.title = `Jam ${code} — Jamlink`;
  window.scrollTo({ top: 0, behavior: 'instant' });
  render(initial);
  choosePlayer();
  // Poll Redis-backed snapshots: works across independent Vercel Functions.
  // A separate heartbeat keeps this participant online and enables host failover.
  let closed = false;
  let inFlight = false;
  let pingFlight = false;
  const refresh = async () => {
    if (closed || inFlight || !code || !token) return;
    inFlight = true;
    try {
      const qs = new URLSearchParams({ id: clientId, token });
      const result = await api(`/api/rooms/${code}?${qs}`);
      if (closed) return;
      if (!result.state.participants.some(p => p.id === clientId)) {
        exitRoom(true, 'The host removed you from this Jam.'); return;
      }
      render(result.state);
      $('sync-message').textContent = 'Connected · updates shared with everyone';
    } catch (err) {
      if (closed) return;
      if (/no longer|removed|rejoin|expired|not found/i.test(err.message)) {
        exitRoom(true, err.message);
      } else $('sync-message').textContent = 'Connection interrupted · retrying automatically';
    } finally { inFlight = false; }
  };
  const heartbeat = async () => {
    if (closed || pingFlight || !code || !token) return;
    pingFlight = true;
    try { await api(`/api/rooms/${code}/heartbeat`, { clientId, token }); }
    catch (err) {
      if (/no longer|removed|rejoin|expired|not found/i.test(err.message)) exitRoom(true, err.message);
    } finally { pingFlight = false; }
  };
  const pollingTimer = setInterval(refresh, 2800);
  const heartbeatTimer = setInterval(heartbeat, 7000);
  const onVisible = () => { if (document.visibilityState === 'visible') { heartbeat(); refresh(); } };
  document.addEventListener('visibilitychange', onVisible);
  source = { close() { closed = true; clearInterval(pollingTimer); clearInterval(heartbeatTimer); document.removeEventListener('visibilitychange', onVisible); } };
  refresh();
  if (timerId) clearInterval(timerId);
  timerId = setInterval(tick, 500);
}
async function exitRoom(wasKicked = false, message = '') {
  if (source) { source.close(); source = null; }
  if (code && token) {
    if (!wasKicked) api(`/api/rooms/${code}/leave`, { clientId, token }).catch(() => {});
    sessionStorage.removeItem(`jamlink-token-${code}`);
  }
  stopPlayers();
  snapshot = null;
  if (timerId) clearInterval(timerId);
  code = null; token = null;
  history.replaceState({}, '', '/');
  document.title = 'Jamlink — Listen together, from anywhere';
  $('lobby').classList.remove('hidden');
  $('room-view').classList.add('hidden');
  $('join-modal').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (message) toast(message, wasKicked);
}
async function leaveRoom() { await exitRoom(); }
function stopPlayers() {
  if (player) { try { player.destroy(); } catch { /* iframe already closed */ } player = null; }
  $('yt-player-holder').innerHTML = '<div id="yt-player"></div>';
  playerReady = false; playerVideo = null; audioEnabled = false; lastAppliedPlayState = null;
}
function choosePlayer() {
  $('yt-player-holder').classList.toggle('hidden', !snapshot?.current);
  $('video-empty').classList.toggle('hidden', Boolean(snapshot?.current));
  if (snapshot) initializeYouTube();
}

async function action(type, fields = {}) {
  if (!code || !token) return false;
  try { await api(`/api/rooms/${code}/action`, { clientId, token, action: { type, ...fields } }); return true; }
  catch (e) { toast(e.message, true); return false; }
}

function durationOf() {
  if (!snapshot?.current) return 0;
  const d = Number(snapshot.current.duration);
  if (d > 0) return d;
  if (playerReady && player && typeof player.getDuration === 'function') return Math.max(0, player.getDuration() || 0);
  return 0;
}
function positionOf() {
  if (!snapshot) return 0;
  const pb = snapshot.playback;
  return Math.max(0, pb.position + (pb.playing ? (Date.now() + offset - pb.changedAt) / 1000 : 0));
}
function fmt(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function render(room) {
  const before = snapshot;
  snapshot = room;
  offset = room.serverTime - Date.now();
  $('room-code').textContent = room.code;
  const online = room.participants.filter(p => p.online).length;
  $('online-count').textContent = `${online} listening`;
  $('people-count').textContent = `${room.participants.length} people`;
  const amHost = room.hostId === clientId;
  $('host-status').textContent = amHost ? '♛ You are the host' : `♛ Hosted by ${room.participants.find(p => p.id === room.hostId)?.name || 'waiting...'}`;
  $('people-list').innerHTML = room.participants.map(p => `<div class="person ${p.online ? '' : 'offline'}"><span class="person-avatar">${esc(p.name.charAt(0).toUpperCase())}</span><span class="person-name">${esc(p.name)}${p.online ? '' : ' · offline'}</span>${p.isHost ? '<span class="host-chip">HOST</span>' : ''}${p.id === clientId ? '<span class="you">YOU</span>' : ''}${amHost && p.id !== clientId ? `<span class="moderation-actions"><button data-host="${esc(p.id)}" ${p.online ? '' : 'disabled'} title="Make host">Make host</button><button data-kick="${esc(p.id)}" title="Remove participant">Kick</button></span>` : ''}</div>`).join('') || '<span class="track-sub">Nobody here yet</span>';
  $('queue-count').textContent = `${room.queue.length} track${room.queue.length === 1 ? '' : 's'} in queue`;
  $('queue-list').innerHTML = room.queue.length ? room.queue.map((track, index) => `<div class="queue-item">
    <span class="queue-index">${index + 1}</span><img class="track-art" src="${esc(track.thumbnail)}" alt="" loading="lazy" /><div class="track-info"><div class="track-title" title="${esc(track.title)}">${esc(track.title)}</div><div class="track-sub">${esc(track.addedBy || track.artist)}</div></div><div class="queue-actions"><button data-queue="now" data-id="${esc(track.id)}" title="Play now">▶</button><button data-queue="up" data-id="${esc(track.id)}" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button><button data-queue="down" data-id="${esc(track.id)}" title="Move down" ${index === room.queue.length - 1 ? 'disabled' : ''}>↓</button><button data-queue="remove" data-id="${esc(track.id)}" title="Remove">×</button></div>
    </div>`).join('') : '<div class="empty-queue"><span>♬</span><strong>It\'s quiet in here</strong><small>Add a song and set the mood.</small></div>';
  $('clear-btn').disabled = room.queue.length === 0;
  const current = room.current;
  $('current-title').textContent = current?.title || 'Queue up your first track';
  $('current-artist').textContent = current?.artist || 'The room is waiting for you';
  $('play-btn').textContent = room.playback.playing ? 'Ⅱ' : '▶';
  $('play-btn').style.paddingLeft = room.playback.playing ? '9px' : '13px';
  ['play-btn', 'next-btn', 'back-btn', 'forward-btn'].forEach(id => $(id).disabled = !current);
  $('prev-btn').disabled = !room.history.length;
  $('audio-prompt').classList.toggle('hidden', !current || !room.playback.playing || audioEnabled);
  if (!current) $('sync-message').textContent = 'Waiting for the first song';
  else $('sync-message').textContent = 'Shared playback · synced across this room';
  syncVideo(before);
  tick();
}

function initializeYouTube() {
  if (window.YT?.Player) { ytReady = true; syncVideo(); return; }
  if (document.getElementById('youtube-iframe-api')) return;
  window.onYouTubeIframeAPIReady = () => { ytReady = true; syncVideo(); };
  const script = document.createElement('script');
  script.id = 'youtube-iframe-api'; script.src = 'https://www.youtube.com/iframe_api';
  script.onerror = () => toast('Could not load YouTube. Check your connection or content blockers.', true);
  document.head.appendChild(script);
}
function remotePlayState() {
  if (!player || !playerReady || !snapshot?.current) return;
  const wantPlay = snapshot.playback.playing;
  if (lastAppliedPlayState === wantPlay) return;
  lastAppliedPlayState = wantPlay;
  suppressionUntil = Date.now() + 1700;
  if (wantPlay && audioEnabled) player.playVideo();
  if (!wantPlay) player.pauseVideo();
}
function syncVideo(before) {
  if (!ytReady || !snapshot) return;
  const current = snapshot.current;
  $('video-empty').classList.toggle('hidden', Boolean(current));
  $('yt-player-holder').classList.toggle('hidden', !current);
  if (!current) {
    if (player) player.destroy();
    player = null; playerReady = false; playerVideo = null; lastAppliedPlayState = null;
    $('yt-player-holder').innerHTML = '<div id="yt-player"></div>';
    return;
  }
  const changed = playerVideo !== current.videoId;
  if (!player) {
    playerVideo = current.videoId;
    player = new window.YT.Player('yt-player', {
      width: '100%', height: '100%', videoId: current.videoId,
      playerVars: { playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: ev => {
          playerReady = true;
          suppressionUntil = Date.now() + 1800;
          ev.target.cueVideoById({ videoId: snapshot.current.videoId, startSeconds: positionOf() });
          lastAppliedPlayState = null;
          remotePlayState();
        },
        onStateChange: onPlayerState,
        onAutoplayBlocked: () => { audioEnabled = false; $('audio-prompt').classList.remove('hidden'); toast('Tap Enable audio or Play in the YouTube player to listen.'); },
        onError: () => toast('This video cannot play here. Try another YouTube track.', true)
      }
    });
    return;
  }
  if (changed && playerReady) {
    playerVideo = current.videoId;
    suppressionUntil = Date.now() + 2000;
    const args = { videoId: current.videoId, startSeconds: positionOf() };
    if (audioEnabled && snapshot.playback.playing) player.loadVideoById(args);
    else player.cueVideoById(args);
    lastAppliedPlayState = null;
  }
  if (playerReady) remotePlayState();
}
function onPlayerState(event) {
  if (!snapshot?.current) return;
  const state = event.data;
  if (state === 0) { // Track ended: server rejects duplicate skip requests by expectedVideoId.
    action('NEXT', { expectedVideoId: playerVideo });
    return;
  }
  if (state === 1) {
    audioEnabled = true;
    $('audio-prompt').classList.add('hidden');
  }
  if (Date.now() < suppressionUntil) return;
  if (state === 1 && !snapshot.playback.playing) action('PLAY');
  if (state === 2 && snapshot.playback.playing) action('PAUSE');
}
function tick() {
  if (!snapshot) return;
  const current = snapshot.current;
  const duration = durationOf();
  let seconds = positionOf();
  if (duration) seconds = Math.min(seconds, duration);
  if (!seeking) {
    $('progress').max = String(duration || Math.max(100, seconds + 30));
    $('progress').value = String(Math.min(Number($('progress').max), seconds));
    $('elapsed').textContent = fmt(seconds);
  }
  $('duration').textContent = duration ? fmt(duration) : '--:--';
  if (current && player && playerReady && snapshot.playback.playing && audioEnabled && !seeking && Date.now() > suppressionUntil) {
    try {
      const actual = player.getCurrentTime();
      if (Number.isFinite(actual) && Math.abs(actual - seconds) > 3.3 && player.getPlayerState() === 1) {
        suppressionUntil = Date.now() + 1200;
        player.seekTo(seconds, true);
      }
    } catch { /* iframe not ready */ }
  }
}

async function search(query) {
  $('search-results').innerHTML = '<div class="empty-search"><span class="disc-icon">◌</span><strong>Searching...</strong><small>Finding tracks from YouTube</small></div>';
  $('search-note').textContent = 'Searching YouTube for embeddable music videos…';
  try {
    const { items } = await api(`/api/search?q=${encodeURIComponent(query)}`);
    searchItems = items;
    $('search-results').innerHTML = items.length ? items.map((track, i) => `<div class="result-item"><img class="track-art" src="${esc(track.thumbnail)}" loading="lazy" alt=""/><div class="track-info"><div class="track-title" title="${esc(track.title)}">${esc(track.title)}</div><div class="track-sub">${esc(track.artist)} · ${track.duration ? fmt(track.duration) : 'Video'}</div></div><button class="icon-button" data-add="${i}" title="Add track to shared queue" aria-label="Add ${esc(track.title)}">+</button></div>`).join('') : '<div class="empty-search"><strong>No matches found</strong><small>Try another artist or song title.</small></div>';
    $('search-note').textContent = 'Tap + to add a track for everyone.';
  } catch (e) {
    $('search-results').innerHTML = `<div class="empty-search"><span class="disc-icon">!</span><strong>Search unavailable</strong><small>${esc(e.message)}</small></div>`;
    $('search-note').textContent = 'You can still add music by pasting YouTube links below.';
  }
}

// Video-only deployment: playback mode selector intentionally disabled.

$('people-list').addEventListener('click', ev => {
  const target = ev.target.closest('[data-host], [data-kick]');
  if (!target || snapshot?.hostId !== clientId) return;
  const id = target.dataset.host || target.dataset.kick;
  const p = snapshot?.participants.find(member => member.id === id);
  if (!p) return;
  if (target.hasAttribute('data-host') && confirm(`Make ${p.name} the new host? You will become a regular participant.`)) {
    action('TRANSFER_HOST', { participantId: id }).then(ok => { if (ok) toast(`${p.name} is now the host.`); });
  }
  if (target.hasAttribute('data-kick') && confirm(`Remove ${p.name} from this Jam? They will not be able to rejoin with the same browser identity.`)) {
    action('KICK', { participantId: id }).then(ok => { if (ok) toast(`${p.name} was removed from the Jam.`); });
  }
});
$('create-btn').addEventListener('click', createRoom);
$('join-btn').addEventListener('click', () => {
  const roomCode = fromLink($('join-code').value);
  if (!roomCode) return toast('Enter a 6-character room code or full invitation link.', true);
  showJoinModal(roomCode);
});
$('join-code').addEventListener('keydown', ev => { if (ev.key === 'Enter') $('join-btn').click(); });
$('lobby-name').addEventListener('keydown', ev => { if (ev.key === 'Enter') $('create-btn').click(); });
$('modal-join-btn').addEventListener('click', () => joinRoom(code, $('modal-name').value));
$('modal-name').addEventListener('keydown', ev => { if (ev.key === 'Enter') $('modal-join-btn').click(); });
$('cancel-modal').addEventListener('click', () => { $('join-modal').classList.add('hidden'); code = null; history.replaceState({}, '', '/'); });
$('home-link').addEventListener('click', ev => { if (code && token) { ev.preventDefault(); leaveRoom(); } });
$('leave-btn').addEventListener('click', leaveRoom);
$('invite-btn').addEventListener('click', copyInvite);
$('copy-inline').addEventListener('click', copyInvite);
$('search-form').addEventListener('submit', ev => { ev.preventDefault(); const q = clean($('search-input').value); if (q.length < 2) return toast('Type at least two characters.', true); search(q); });
$('search-results').addEventListener('click', ev => {
  const button = ev.target.closest('[data-add]');
  if (!button) return;
  const track = searchItems[Number(button.dataset.add)];
  if (track) action('ADD', { track }).then(ok => { if (ok) toast('Added to the shared queue ♫'); });
});
$('paste-form').addEventListener('submit', async ev => {
  ev.preventDefault();
  const id = fromYouTubeLink($('paste-url').value);
  if (!id) return toast('Paste a valid YouTube video link.', true);
  const title = clean($('paste-title').value) || 'YouTube video';
  let artist = 'YouTube';
  let finalTitle = title;
  if (title === 'YouTube video') {
    try {
      const data = await api(`/api/video?id=${encodeURIComponent(id)}`);
      finalTitle = data.title || title;
      artist = data.artist || artist;
    } catch { /* fallback to manual title */ }
  }
  const added = await action('ADD', { track: { videoId: id, title: finalTitle, artist } });
  if (added) {
    $('paste-url').value = '';
    $('paste-title').value = '';
    toast('Link added to the room queue ♫');
  }
});
$('queue-list').addEventListener('click', ev => {
  const button = ev.target.closest('[data-queue]');
  if (!button) return;
  const id = button.dataset.id;
  switch (button.dataset.queue) {
    case 'now': action('PLAY_NOW', { trackId: id }); break;
    case 'up': case 'down': action('MOVE', { trackId: id, direction: button.dataset.queue }); break;
    case 'remove': action('REMOVE', { trackId: id }); break;
  }
});
$('clear-btn').addEventListener('click', () => { if (snapshot?.queue.length && window.confirm('Clear all upcoming tracks for everyone?')) action('CLEAR'); });
$('play-btn').addEventListener('click', () => {
  if (!snapshot?.current) return;
  suppressionUntil = Date.now() + 1500;
  if (snapshot.playback.playing) {
    if (playerReady) player.pauseVideo();
    action('PAUSE');
  } else {
    audioEnabled = true;
    if (playerReady) player.playVideo();
    action('PLAY');
  }
});
$('enable-audio').addEventListener('click', () => {
  audioEnabled = true;
  suppressionUntil = Date.now() + 1500;
  if (playerReady) { player.seekTo(positionOf(), true); player.playVideo(); }
  $('audio-prompt').classList.add('hidden');
  if (!snapshot?.playback.playing) action('PLAY');
});
$('next-btn').addEventListener('click', () => action('NEXT'));
$('prev-btn').addEventListener('click', () => action('PREVIOUS'));
function stepSeek(amount) {
  if (!snapshot?.current) return;
  const sec = Math.max(0, Math.min(durationOf() || 43200, positionOf() + amount));
  suppressionUntil = Date.now() + 1500;
  if (playerReady) player.seekTo(sec, true);
  action('SEEK', { seconds: sec });
}
$('back-btn').addEventListener('click', () => stepSeek(-10));
$('forward-btn').addEventListener('click', () => stepSeek(10));
$('progress').addEventListener('input', () => { seeking = true; $('elapsed').textContent = fmt(Number($('progress').value)); });
$('progress').addEventListener('change', () => {
  const sec = Number($('progress').value);
  seeking = false; suppressionUntil = Date.now() + 1500;
  if (playerReady) player.seekTo(sec, true);
  action('SEEK', { seconds: sec });
});
window.addEventListener('popstate', () => {
  const match = location.pathname.match(/^\/room\/([A-Z0-9]{6})\/?$/i);
  if (!match && code && token) leaveRoom();
});

// On direct invitation links, returning participants rejoin automatically.
const linkMatch = location.pathname.match(/^\/room\/([A-Z0-9]{6})\/?$/i);
if (linkMatch) {
  const roomCode = linkMatch[1].toUpperCase();
  const saved = sessionStorage.getItem(`jamlink-token-${roomCode}`);
  if (saved && nick) {
    api(`/api/rooms/${roomCode}/join`, { name: nick, clientId, token: saved })
      .then(data => enterRoom(roomCode, data.token, data.state))
      .catch(() => showJoinModal(roomCode));
  } else showJoinModal(roomCode);
}
