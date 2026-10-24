# Deploying Chatr

Chatr has two parts: the **web app** (static files) and the **API** (a Node server with a SQLite file, the realtime
socket and the WebRTC signalling). Calls themselves go directly between the participants; the server never sees the
voice or the pictures. Pick where they live:

| | Web app | API | Good for |
| --- | --- | --- | --- |
| [**Cloudflare**](cloudflare/README.md) | Cloudflare Pages | any machine with Docker, reached through a Cloudflare Tunnel (no open ports) | free hosting for the web app, a small or home server for the API |
| [**Your own server (VPS)**](vps/README.md) | Caddy, on the server | the same server | everything in one place, nothing depends on a provider |

Both need the browser to reach the site over **HTTPS** (cameras and microphones are blocked otherwise). The API
cannot run on Cloudflare Workers as it is: it keeps a database file and long-lived sockets.

## Settings you will meet

| Where | Name | Meaning |
| --- | --- | --- |
| web app (build time) | `REACT_APP_HOST` | public address of the web app, used in invitation links |
| web app (build time) | `REACT_APP_API_HOST` | address of the API, `host` or `host/prefix` (the VPS setup uses `your.domain/api`) |
| web app (build time) | `REACT_APP_NAME`, `REACT_APP_TAGLINE` | name and tagline shown in the app |
| API | `WEB_APP_HOST` | the one origin allowed to talk to the API |
| API | `AUTH_SECRET` | signs the session tokens (48+ random characters, keep it) |
| API | `TRUST_PROXY` | `true` behind a proxy you control (both setups) |
| API | `TURN_URLS`, `TURN_SECRET` | optional relay for strict networks, see below |

The complete list is in [`api/.env.example`](../api/.env.example).

## After the first start

Open the web app: the first visit asks you to create the **administrator** (this is only possible once). The
administrator then creates the hosts, who are the people allowed to start meetings.

## Strict networks (TURN)

Most calls connect directly through STUN. Participants behind mobile carriers or corporate firewalls need a relay
(TURN). The VPS setup includes one (`docker compose --profile turn up -d`, see [vps/README.md](vps/README.md)); it
needs a machine with a public IP address and open UDP/TCP ports, so it cannot run behind a Cloudflare Tunnel. You can
run it on a separate small server and point `TURN_URLS`/`TURN_SECRET` of the API at it.

## Backups

All data is the SQLite file in the `api-data` volume (`/app/data/chatr.sqlite`): hosts, the administrator and the
privacy policy. Meetings and chats are not stored.
