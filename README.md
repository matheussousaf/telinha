# telinha 🖥️

Low-latency screensharing for your Discord friend group, now that [video features are suspended in Brazil](https://support.discord.com/hc/en-us/articles/42704051358359). Voice chat stays on Discord; the video moves to your own page.

- **Web app** — streamer page captures your game with `getDisplayMedia` (60 fps, game audio on Chromium/Windows) and streams it peer-to-peer over WebRTC to each viewer. Sub-second latency, so it stays in sync with voice chat.
- **Viewer page** — one click to watch, plus a **Pop out (PiP)** button that floats the stream in an always-on-top mini-window you can park over Discord.
- **Discord bot** — `/screenshare` creates a room, DM-style ephemeral reply gives *you* the secret streamer link, and a pinned embed in the channel shows a 🔴 LIVE card with an auto-refreshing thumbnail, viewer count, and a *Watch live* button.

## How it works

```
streamer browser ──getDisplayMedia──► RTCPeerConnection ──► viewer 1
        │                                   ├────────────► viewer 2
        │                                   └────────────► viewer 3   (P2P mesh)
        └── WS signaling + thumbnails ──► Node server ◄── WS ── viewers
                                            │
                                            └── Discord bot (same process)
```

No media server: video goes directly from the streamer to each viewer. That means the streamer's upload bandwidth is `bitrate × viewers` — comfortable for 2–4 friends at 1080p, which is the use case. If you outgrow it, swap the transport for an SFU (LiveKit) and keep everything else.

## Setup

```bash
cp .env.example .env   # then edit it
npm install
npm start              # web-only if DISCORD_TOKEN is unset
npm run smoke          # signaling smoke test (no browser needed)
```

### Discord bot

1. Create an app at <https://discord.com/developers/applications> → Bot → copy the token.
2. On the same Bot page, under **Privileged Gateway Intents**, enable **Presence Intent** — this is what powers game detection. (No verification needed while the bot is in fewer than 100 servers.)
3. Put `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` (the Application ID) in `.env`. Set `GUILD_ID` to your server's ID for instant command registration while testing.
4. Register the slash command: `npm run register`
5. Invite the bot (replace the client id):

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=27648
   ```

   `27648` = View Channels + Send Messages + Embed Links + Manage Messages (the last one is only for pinning the live card — the bot works without it, just doesn't pin).
6. `npm start`, then `/screenshare` in any channel.

### Game detection

The bot piggybacks on Discord's own client-side game detection (which still works in Brazil — only *video* was suspended). When you run `/screenshare`, it reads your presence: the detected game becomes the room title, shows as 🎮 on the live card and on the streamer/viewer pages, and updates everywhere in real time if you switch games mid-stream. Requirements:

- **Presence Intent** enabled in the developer portal (step 2 above).
- The streamer has **Settings → Activity Privacy → "Share your detected activities with others"** turned on in their Discord client (it's the default).

If nothing is detected, `/screenshare` just falls back to your voice channel name, and you can always pass `/screenshare title:` explicitly.

### Going public (so friends outside your LAN can watch)

- The server needs to be reachable over **HTTPS** (browsers require a secure context for `getDisplayMedia` anywhere except `localhost`). Easiest options: a `cloudflared` tunnel (`cloudflared tunnel --url http://localhost:3000` for a quick throwaway URL) or a VPS with Caddy in front.
- Set `BASE_URL` to that public URL — it's what the bot puts in links and what Discord fetches embed thumbnails from (thumbnails silently skip rendering while `BASE_URL` is localhost).
- **TURN**: without it, friends behind strict NATs (CGNAT is common on Brazilian ISPs) won't connect. Run [coturn](https://github.com/coturn/coturn) on the same VPS and fill in `TURN_URL` / `TURN_USERNAME` / `TURN_PASSWORD`.

## Notes & limits

- Stream from **Chrome or Edge**. Game/tab audio capture is Chromium-only; whole-screen audio capture works on Windows.
- P2P mesh: expect it to be great up to ~4 viewers, degrading past that.
- Rooms live in memory — a server restart clears them (streams die with it anyway).
- The streamer link contains the room's secret key. The ephemeral reply keeps it visible only to whoever ran `/screenshare` — don't paste it in chat.

## Keep it between friends

This tool is deliberately private-by-design: unguessable room links, no public directory, no accounts, no discovery. That's not just simplicity — Brazil's Digital ECA (Lei 15.211/2025) puts real obligations (age assurance, content-risk mitigation) on platforms "likely to be accessed by minors", and the ANPD's Discord order shows it's enforced. A self-hosted room shared among friends is ordinary private communication; a public "screenshare for everyone" service is a regulated platform. Don't turn this into the latter without talking to a lawyer first.
