# Chatr on Cloudflare

The web app goes to **Cloudflare Pages**; the API runs on any machine that has Docker and is connected to Cloudflare
with a **Tunnel**, so no port has to be opened. Example names: the app at `chat.example.com`, the API at
`chat-api.example.com` (a sibling name; the free Universal certificate does not cover `api.chat.example.com`).
Both names must be on a domain that is in your Cloudflare account.

## 1. The API and the tunnel

1. In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a tunnel** (Cloudflared). Copy the token
   from the install command it shows (the long string after `--token`).
2. In the tunnel, add a **public hostname**: `chat-api.example.com`, service type **HTTP**, URL `api:8080`.
3. On the machine that will run the API:

   ```bash
   cd deploy/cloudflare
   cp .env.example .env     # APP_HOST=chat.example.com, AUTH_SECRET=<random>, TUNNEL_TOKEN=<from step 1>
   docker compose up -d --build
   ```

   Check `https://chat-api.example.com/health`.

## 2. The web app

```bash
cd deploy/cloudflare
APP_HOST=chat.example.com API_HOST=chat-api.example.com ./deploy-pages.sh
```

The script builds the app for those two addresses and uploads it with Wrangler (log in once with
`bun x wrangler login`, or set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). Then, in the dashboard under
**Workers & Pages → chatr → Custom domains**, add `chat.example.com`.

Run the script again whenever the app changes; the API is updated with `docker compose up -d --build`.

## Good to know

- Nothing but the API is stored, in the `api-data` volume on that machine: back it up (see [../README.md](../README.md)).
- Cloudflare terminates HTTPS and passes the visitor's address on; the API uses it for its rate limits
  (`TRUST_PROXY=true` is already set).
- WebRTC media does not go through Cloudflare. For participants on strict networks add a TURN relay on a machine with
  a public address (see [../README.md](../README.md)).
