# Jamlink — Vercel-ready YouTube Jam

Share a link so friends can join a collaborative music room from an iPhone, Android or laptop browser. Everyone can search YouTube, add and reorder tracks, play/pause/seek/skip, and hear the same video on their own device (best-effort synchronization). The host can kick participants, appoint a new host, and leave the room; a connected participant automatically becomes host if the host disconnects for long enough.

**Audio:** This is the **video-only** version. Playback uses the official visible YouTube embedded player. The Piped/experimental audio mode is gone.

**Deployment:** Vercel (Hobby) + Upstash Redis (Free). The `public/` folder contains static site files, the `api/` folder contains the serverless API, and `redis-store.mjs` stores session data across function instances. Polling (2.8 seconds) replaces SSE to avoid long-lived server requests. Rooms expire after 6 hours without write activity. The app doesn't store or host YouTube music.

## Deploy to Vercel (no card needed for the normal free tiers)

1. Create a free Redis database at https://console.upstash.com/ and open **REST API** details or the **Connect** tab. Copy the REST URL and token.
2. Create or use an existing Google Cloud project, enable **YouTube Data API v3**, and create an API key at https://console.cloud.google.com/apis/credentials . Restrict the API key to YouTube Data API v3. YouTube search consumes Google API quota; adding a pasted YouTube link also works without the key.
3. Upload the **contents of this `jamlink` folder** to a GitHub repository. Put `vercel.json`, `package.json`, `api/`, and `public/` in the repository root. Do NOT upload your local `.env`.
4. Go to https://vercel.com/new and import that repository. Use the **Hobby** plan, **Other** framework preset, and keep the **Root Directory** at the folder containing `vercel.json`. No special build command is necessary. `vercel.json` is already configured.
5. Under **Environment Variables**, add exactly these names:

   - `UPSTASH_REDIS_REST_URL` = copied Upstash REST URL
   - `UPSTASH_REDIS_REST_TOKEN` = copied Upstash REST token (keep secret)
   - `YOUTUBE_API_KEY` = your YouTube Data API v3 key (keep secret)

6. Deploy. Open `https://YOUR-VERCEL-DOMAIN.vercel.app/api/health`. When the values `ok`, `redisConfigured`, and `searchConfigured` are `true`, create a Jam at your site homepage and share its room link.

**If using an existing GitHub repository:** Extract ZIP, copy the files from its *inner* `jamlink/` folder over your repository's project files, then run `git add -A`, `git commit -m "Deploy Jamlink on Vercel"`, and `git push`. Set the three environment variables in Vercel and redeploy.

## Run locally (requires Upstash credentials)

Use Node.js 20 or newer. Create `.env` alongside `package.json` by copying `.env.example`, fill in the same three values, then run `npm start`. Open http://localhost:3000 . Do not commit `.env`.

## Test

Run `npm test`. The tests use an in-memory fake of the Redis REST protocol and do not consume Upstash quota. Local tests cover room creation, membership credentials, remote state consistency, queue actions, kicking and banning, host transfer, host-leave takeover, disconnect failover, and concurrent NEXT requests.

## Important limitations

- Listeners may have to tap Play on iPhone Safari to satisfy autoplay restrictions. Audio may be interrupted when Safari is backgrounded.
- Playback position is coordinated approximately using timestamps, polling, and correction; it isn't sample-accurate.
- An inactive browser can be marked offline after ~20 seconds; automatic host takeover happens after another ~12 seconds when an online participant polls the room. Leaving normally causes immediate transfer.
- Rooms expire after ~6 hours without writes/heartbeats. There is a maximum of 30 participants and 150 queued tracks per room.
- A room gets a new anonymous ID for each browser session. A kicked session cannot rejoin with the same browser identity, but this is *not* secure identity-level banning; guests could use another browser session.
- Vercel Hobby and Upstash Redis Free have usage limits. A large number of users or long listening sessions may reach the free quota; this version is suitable for a small academic demo, not guaranteed unrestricted production use.
- Use the YouTube embedded player as shown, in line with provider conditions. Songs that disable embedding cannot be played here.
- Do not commit `YOUTUBE_API_KEY`, `UPSTASH_REDIS_REST_TOKEN`, or any `.env` file to GitHub.
