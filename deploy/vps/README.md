# Chatr on your own server

One machine with Docker runs everything: **Caddy** (serves the web app and gets the HTTPS certificate by itself), the
**API**, and optionally a **TURN** relay. Ubuntu 22.04 or newer with 1 vCPU and 2 GB of memory is enough to start.

1. Point a DNS record for your domain (for example `chat.example.com`) at the server, and open ports **80** and **443**
   (TCP, and UDP 443 for HTTP/3) in its firewall.
2. Install Docker, then on the server:

   ```bash
   git clone https://github.com/jasonviipers/chatr.git
   cd chatr/deploy/vps
   cp .env.example .env     # set DOMAIN and AUTH_SECRET
   docker compose up -d --build
   ```

3. Open `https://<your domain>` and create the administrator.

Updating: `git pull && docker compose up -d --build`. The database lives in the `api-data` volume.

## Relay for strict networks (optional)

The simplest is Cloudflare Realtime TURN: create a key in the Cloudflare dashboard (*Realtime → TURN Server*) and put its id
and token in `.env` as `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`, then `docker compose up -d`. Or run your own:

Set `TURN_SECRET` (random) and `TURN_URLS=turn:<your domain>:3478?transport=udp,turn:<your domain>:3478?transport=tcp`
in `.env`, open UDP/TCP 3478 and UDP 49160–49200, then start it:

```bash
docker compose --profile turn up -d
```

## Behind Cloudflare's proxy?

Do not put an orange-cloud proxy in front of this setup: the API would see Cloudflare's address instead of the
visitor's and rate-limit everybody together. Use the [Cloudflare setup](../cloudflare/README.md) instead, or keep the
DNS record "DNS only".
