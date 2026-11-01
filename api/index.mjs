import { ClientError, validVideoId } from '../room.mjs';
import { UpstashRest, createRedisRoomStore } from '../redis-store.mjs';

try { process.loadEnvFile?.('.env'); } catch { /* deployed environment variables are supplied by Vercel */ }
const duration = value => {
  const m = String(value || '').match(/^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) || null : null;
};
let backend = null;
function store() {
  if (!backend) backend = createRedisRoomStore(new UpstashRest());
  return backend;
}
const searchCache = new Map();
async function searchYouTube(q) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new ClientError('Search is not configured. Add YOUTUBE_API_KEY to Vercel Environment Variables.', 503);
  if (searchCache.has(q) && Date.now() - searchCache.get(q).at < 600_000) return searchCache.get(q).items;
  const params = new URLSearchParams({ key, part: 'snippet', q, maxResults: '12', type: 'video', videoEmbeddable: 'true', videoCategoryId: '10', safeSearch: 'moderate' });
  const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal: AbortSignal.timeout(9000) });
  const data = await r.json();
  if (!r.ok) throw new ClientError(data.error?.message || 'YouTube search unavailable.', 502);
  const ids = (data.items || []).map(x => x.id?.videoId).filter(Boolean);
  if (!ids.length) return [];
  const details = new URLSearchParams({ key, part: 'contentDetails,status', id: ids.join(',') });
  const result = await fetch(`https://www.googleapis.com/youtube/v3/videos?${details}`, { signal: AbortSignal.timeout(9000) });
  const detail = result.ok ? await result.json() : { items: [] };
  const map = new Map((detail.items || []).map(x => [x.id, x]));
  const items = (data.items || []).filter(x => x.id?.videoId && map.get(x.id.videoId)?.status?.embeddable !== false).map(x => ({
    videoId: x.id.videoId, title: x.snippet.title, artist: x.snippet.channelTitle,
    thumbnail: `https://i.ytimg.com/vi/${x.id.videoId}/hqdefault.jpg`,
    duration: duration(map.get(x.id.videoId)?.contentDetails?.duration)
  }));
  searchCache.set(q, { at: Date.now(), items });
  if (searchCache.size > 150) searchCache.delete(searchCache.keys().next().value);
  return items;
}
function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  if (req.body != null) {
    if (typeof req.body === 'string') {
      try { return JSON.parse(req.body); } catch { throw new ClientError('Invalid JSON.'); }
    }
    return req.body;
  }
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 16000) throw new ClientError('Request too large.', 413);
  }
  try { return JSON.parse(data || '{}'); } catch { throw new ClientError('Invalid JSON.'); }
}
export async function handleApi(req, res) {
  const url = new URL(req.url, 'https://localhost');
  const route = '/' + (url.searchParams.get('route') || url.pathname.replace(/^\/api\/?/, ''));
  const method = req.method;
  try {
    if (route === '/health' && method === 'GET') {
      const configured = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
      return json(res, configured ? 200 : 503, { ok: configured, redisConfigured: configured, searchConfigured: Boolean(process.env.YOUTUBE_API_KEY), playback: 'youtube-video', realtime: 'polling' });
    }
    if (route === '/search' && method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      if (q.length < 2) throw new ClientError('Enter at least two characters.');
      return json(res, 200, { items: await searchYouTube(q) });
    }
    if (route === '/video' && method === 'GET') {
      const id = String(url.searchParams.get('id') || '');
      if (!validVideoId(id)) throw new ClientError('Invalid video ID.');
      const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
      try {
        const r = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) throw Error('oEmbed unavailable');
        const data = await r.json();
        return json(res, 200, { title: String(data.title || 'YouTube video').slice(0, 120), artist: String(data.author_name || 'YouTube').slice(0, 80) });
      } catch { return json(res, 200, { title: 'YouTube video', artist: 'YouTube' }); }
    }
    if (route === '/rooms' && method === 'POST') {
      const body = await readBody(req);
      return json(res, 201, await store().create(body.name, body.clientId));
    }
    const match = route.match(/^\/rooms\/([A-Za-z0-9]{6})(?:\/(join|action|leave|heartbeat))?$/);
    if (match) {
      const code = match[1].toUpperCase();
      const operation = match[2];
      if (!operation && method === 'GET') return json(res, 200, { state: await store().getState(code, url.searchParams.get('id'), url.searchParams.get('token')) });
      if (method !== 'POST') throw new ClientError('Method not allowed.', 405);
      const body = await readBody(req);
      if (operation === 'join') return json(res, 200, await store().join(code, body.name, body.clientId, body.token));
      if (operation === 'action') return json(res, 200, { state: await store().action(code, body.clientId, body.token, body.action) });
      if (operation === 'heartbeat') return json(res, 200, { state: await store().heartbeat(code, body.clientId, body.token) });
      if (operation === 'leave') return json(res, 200, await store().leave(code, body.clientId, body.token));
    }
    throw new ClientError('Not found.', 404);
  } catch (err) {
    if (!err.status) console.error('[Jamlink API]', err);
    return json(res, err.status || 500, { error: err.status ? err.message : 'Unexpected server error.' });
  }
}
export default handleApi;
