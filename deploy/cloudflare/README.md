# Chatr on Cloudflare

The web app is served by **Cloudflare** (static files on a Worker, which is free); the API runs on any machine that has Docker (reached directly, or through a Cloudflare **Tunnel** so that no port
has to be opened). Example names: the app at `chat.example.com`, the API at
`chat-api.example.com` (a sibling name; the free Universal certificate does not cover `api.chat.example.com`).
Both names must be on a domain that is in your Cloudflare account.

## 1. The API

On the machine that will run it (Docker installed):

```bash
git clone https://github.com/jasonviipers/chatr.git && cd chatr/deploy/cloudflare
cp .env.example .env     # APP_HOST, API_HOST and AUTH_SECRET (the file says how to make one)
```

Then pick how it is reached over HTTPS:

- **Direct** (needs ports 80 and 443 open): in the Cloudflare DNS settings add an **A record** for `chat-api`
  pointing at the machine's IP address, **DNS only** (grey cloud). Then `docker compose --profile direct up -d --build`;
  Caddy fetches the certificate by itself.
- **Tunnel** (nothing to open): in the dashboard, **Zero Trust → Networks → Tunnels → Create a tunnel**, copy the token
  into `TUNNEL_TOKEN` in `.env`, and add a public hostname `chat-api.example.com` with service `http://api:8080`. Then
  `docker compose --profile tunnel up -d --build`.

Check `https://chat-api.example.com/health`. Then open the web app and **create the administrator straight away**:
until someone has, the first visitor can.

## 2. The web app

```bash
cd deploy/cloudflare
APP_HOST=chat.example.com API_HOST=chat-api.example.com ./deploy-web.sh
```

The script builds the app for those two addresses and publishes it with Wrangler (log in once with
`bun x wrangler login`, or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). The domain, its DNS record and its
certificate are created for you, so the domain of `APP_HOST` must already be in your Cloudflare account. `DRY_RUN=1`
builds and checks everything without publishing.

Run the script again whenever the app changes; the API is updated with `docker compose up -d --build`.

## Good to know

- Nothing but the API is stored, in the `api-data` volume on that machine: back it up (see [../README.md](../README.md)).
- Caddy (direct) or Cloudflare (tunnel) terminates HTTPS and passes the visitor's address on; the API uses it for its
  rate limits (`TRUST_PROXY=true` is already set).
- WebRTC media does not go through Cloudflare. For participants on strict networks add a TURN relay on a machine with
  a public address (see [../README.md](../README.md)).
