# Chatr API

One small Node process that serves everything the apps need:

| Part | What it is |
| --- | --- |
| HTTP | [Hono](https://hono.dev) on `@hono/node-server`, validated with Zod, fully typed (`AppType` is exported for typed clients) |
| Data | SQLite (WAL) through [Drizzle ORM](https://orm.drizzle.team), SQL migrations in `drizzle/` run at startup |
| Auth | [Better Auth](https://better-auth.com) (username + bearer plugins). Roles: `admin` and `host` |
| Realtime | `/socket`: WebSocket gateway for the meeting events (acknowledged publishes, replay after a reconnect, heartbeat) |
| Signalling | `/peer`: PeerJS-compatible WebRTC signalling (the browser keeps using `peerjs`) |
| Chat | `/chat/<meetingId>` channel on the socket: text messages for people who cannot or do not want to use the microphone |
| ICE | `/ice-servers`: STUN list plus short-lived TURN credentials |

Calls stay peer to peer (WebRTC mesh): the server only introduces people, so one small VPS handles
50-200 people online at the same time. A single meeting is bounded by the participants' uplinks
(roughly 6-8 people); that limit would only move with an SFU, which this project does not include.

Requires **Node 26+** (TypeScript runs natively, there is no ts-node/tsx/nodemon) and [Bun](https://bun.sh) 1.4+ as the package manager (`bun.lock`; Bun installs the packages, Node runs the server).

## Quick start

```bash
cd api
cp .env.example .env      # empty values count as "not set"
bun install
bun run dev                # node --watch src/server.ts  ->  http://localhost:8080
```

Point the web app at it with `REACT_APP_API_HOST=localhost:8080` in `app/.env`. The first admin is created
from the app's admin screen; once one exists that endpoint is closed for good.

**Development is plain HTTP, production is HTTPS.** The web app follows the same rule: its dev server talks
`http`/`ws` to the API, a production build talks `https`/`wss` (put `http://` or `https://` in front of
`REACT_APP_API_HOST` to override that). Browsers allow camera and microphone on `http://localhost`, so no
certificate is needed to develop.

With `TLS=auto` (default) the API serves HTTPS in production when `ssl/key.pem` and `ssl/cert.pem` exist, and
plain HTTP when they do not, which is what you want behind nginx or another proxy that terminates TLS (the Docker
image sets `TLS=off` explicitly). `TLS=on` serves HTTPS in any environment, e.g. to try the self-signed
certificate locally; it refuses to start when the files are missing.

## Scripts

| Script | |
| --- | --- |
| `bun run dev` | run with file watching |
| `bun run build` / `bun run start` | compile to `build/` / run it under pm2 (`ecosystem.config.cjs`) |
| `bun run typecheck`, `bun run lint`, `bun run format` | tsc, ESLint + Prettier |
| `bun run test` | Vitest: HTTP API, auth, realtime gateway, legacy import, env |
| `bun run db:generate` | create a migration after editing `src/db/schema.ts` |
| `bun run db:migrate` | apply migrations by hand (the server also does it at startup) |
| `bun run migrate:legacy [old.sqlite]` | import the admins, hosts and privacy policy of the previous API |

## Configuration (`.env`)

| Variable | Default | |
| --- | --- | --- |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | |
| `AUTH_SECRET` | random per process | **Required in production**, 32+ characters. Signs the sessions: change it and everyone has to sign in again |
| `DATABASE_PATH` | `./data/chatr.sqlite` | keep it on a persistent volume |
| `WEB_APP_HOST` | | `host[:port]` of the web app. Used as an exact CORS and WebSocket origin |
| `ALLOWED_ORIGINS` | | extra exact origins, comma separated. The Capacitor and Electron origins are built in |
| `TLS`, `TLS_KEY_PATH`, `TLS_CERT_PATH` | `auto`, `./ssl/key.pem`, `./ssl/cert.pem` | `auto`: HTTP in development, HTTPS in production when the files exist. `on` / `off` force it. Production means `NODE_ENV=production` (set by `bun run start` and the Docker image) |
| `TRUST_PROXY` | `false` | `true` only behind a proxy you control that **sets** `X-Forwarded-For` (the last entry is used, see `nginx.conf`) |
| `STUN_URLS` | Google STUN | comma separated |
| `TURN_URLS`, `TURN_SECRET`, `TURN_TTL_SECONDS` | | relay for networks where a direct path is impossible, see below |
| `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP` | `2000`, `60` | caps on open sockets |

## Security notes

- Passwords are hashed by Better Auth (scrypt). Sign-in is throttled per IP and per account, with a lockout and the same
  response time for unknown users. Passwords are 8-128 characters.
- Sessions are bearer tokens in the `Authorization` header (30 days). Expired ones are purged hourly.
- Admin routes answer `401` without a session and `403` for the wrong role. The first admin can only be created while
  none exists.
- CORS and WebSocket origins are an exact allow-list, never a wildcard. Secure headers, a body size limit and per-IP
  token buckets are on for every route; sockets have connection caps and are dropped when they stop reading.
- The privacy policy HTML is sanitised on write. A participant's identity is stamped by the server on realtime
  messages that need it, and only the host can remove a member.
- Never set `TRUST_PROXY=true` when clients can reach the API directly: they could then pick their own IP.

## Chat

Messages travel over the same realtime socket as the other meeting events, so they get its delivery guarantees:
acknowledged publishes, replay of what a reconnecting client missed, no duplicates. The server accepts a message only
from an identified participant, takes just the text and a client message id from it, and adds the sender and the
time itself, so a participant cannot write in somebody else's name. Text is limited to 1000 characters, control
characters and the bidirectional overrides that make text read backwards are removed, and each connection may send a
burst of ten messages and then one a second. Messages are not stored: they live as long as the meeting, in memory.

## Camera and microphone state

Pictures and sound travel in the calls themselves, but "this person switched their camera off" or "muted
themselves" is not visible in a call (a muted track still arrives, as silence or black). Every participant therefore
announces their own state on the `/mediaState/<meetingId>` channel: just two booleans, `video` and `audio`. As with
the chat, the server adds who it is from the sender's verified identity, so nobody can show somebody else as muted
or on camera, and each connection is limited to a burst of 20 announcements, then 4 a second.

## Calls on a bad network

The server side: acknowledged publishes with ids (no duplicates when a client retries), replay of what a client missed
while it was offline, heartbeats that detect half-open sockets, and ICE servers with time-limited TURN credentials.
The web app does the rest: it reconnects with jittered exponential backoff and re-sends what it could not deliver, keeps a
running call alive while the signalling link is down, restarts ICE when the network path changes, lowers the audio
bitrate and pauses screen sharing when loss or delay rise (and recovers one step at a time), and negotiates Opus with
in-band FEC and DTX. A call that stays down for about 90 seconds is closed and its picture removed; the side that placed
the call then dials again (after 1.5 s, then 3, 6, 12, 20 and every 30 s) until the person answers, says goodbye, or
10 minutes have passed. Losing the host that long ends the meeting for that user; losing anyone else is silent.

### TURN (recommended for mobile users and strict firewalls)

Without a relay, people behind symmetric NATs or carrier-grade NAT cannot connect. Run [coturn](https://github.com/coturn/coturn)
with a shared secret and give the API the same one:

```bash
# turnserver.conf
use-auth-secret
static-auth-secret=<TURN_SECRET>
realm=example.com
fingerprint
no-cli
min-port=49160
max-port=49200
```

```bash
# api/.env
TURN_URLS=turn:example.com:3478?transport=udp,turn:example.com:3478?transport=tcp
TURN_SECRET=<the same secret, 16+ characters>
```

The repository's `.docker-compose.yml` has a `turn` profile that runs it.

## Moving from the previous API

```bash
bun run migrate:legacy ../database.sqlite
```

It runs in one transaction and takes milliseconds. Admins and hosts keep their usernames and passwords (old MD5 hashes are
accepted once and replaced by a strong hash at the next sign-in), and the privacy policy is carried over. Entries with
an invalid or duplicate username are skipped and listed. Sessions of the previous API are not valid any more: everybody
signs in again once.

## Docker

`.Dockerfile` builds a small production image (`TLS=off`, port 8080, data in `/app/data`). `../.docker-compose.yml`
wires it behind nginx with a data volume, an optional `turn` profile (coturn) and a read-only `sqlite3` shell.
`AUTH_SECRET` must be provided in a `.env` file next to the compose file.
