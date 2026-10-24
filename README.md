## Server Requirements

You can build web (PWA), mobile (Android), and desktop (Mac, Windows, and 
Linux) apps from this package. All of the apps are backed by a single API. And 
the API is developed as a separate package from the frontend package for 
isolation. Here are the server-side requirements for deploying the web app 
(frontend) and API (backend).

* CPU: 1 vCore (Minimum), 2CPU (recommended)
* Memory: 2 GB (Minimum)
* Space: 1 GB (Minimum)
* OS: Ubuntu 20.04 or higher

## Server Setup

Get a VPS/Cloud/Dedicated Server and install Ubuntu OS. We suggest to go with 20.04 as it is more stable.

### You need the following things from your server:

* IP Address
* Root SSH Access (Username & Password)

1. Logging In (SSH)

Install Putty if you are on Windows otherwise you can use Terminal if you are using MacOS.

``` ssh root@YOUR_SERVER_IP ```

Now it'll ask for your password. Enter your password and you'll be into your server.

Note: If it asks you to save fingerprint, write Yes and press enter.

2. Installing NodeJS

We have to install NodeJS now to run our application and install dependencies. Run each line one by one.

`` curl -sL https://deb.nodesource.com/setup_26.x -o nodesource_setup.sh
sudo bash nodesource_setup.sh
sudo apt-get install -y nodejs
sudo apt install apt-transport-https ca-certificates curl software-properties-common ``

3. Installing Docker

We have to install Docker to run our Proxy Server and main application.

`` curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -
sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu focal stable"
sudo apt update
apt-cache policy docker-ce
sudo apt install docker-ce ``

Press Y.

`` sudo curl -L "https://github.com/docker/compose/releases/download/1.29.2/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose ``

Creating Docker Network for communication.

``` docker network create connect-proxy ```

You have successfully created our server.

## Running the API

The backend in `api/` is a single Node 26 process (Hono, Drizzle + SQLite, Better Auth, a WebSocket gateway
and the WebRTC signalling). Configuration, security notes, TURN setup and the import of an old database are in
[api/README.md](api/README.md).

With Docker, put a secret in a `.env` file next to `.docker-compose.yml` and start the stack:

``` echo "AUTH_SECRET=$(node -p "require('crypto').randomBytes(48).toString('base64url')")" > .env
docker compose -f .docker-compose.yml up -d --build ```

nginx publishes the API under `/api`, so the web app is built with `REACT_APP_API_HOST=your-domain.com/api`
(or `api.your-domain.com` when the API has its own host name). Add `--profile turn` to also run a TURN relay for
participants on mobile data or behind strict firewalls.

## Development

[Bun](https://bun.sh) 1.4+ is the package manager (a `bun.lock` in `api/`, `app/` and `app/electron/`) and runs the
scripts; the API itself runs on Node 26+. The Docker images install Bun themselves, so the server needs neither.

``` cd api && bun install && bun run dev
cd app && bun install && bun run dev ```

Meeting features: voice calls, an optional camera (off until you switch it on), text chat, whiteboard and screen
sharing. The native apps need the camera and microphone permissions declared in their projects (`NSCameraUsageDescription`
and `NSMicrophoneUsageDescription` on iOS, `CAMERA` and `RECORD_AUDIO` on Android). A proposal for noise suppression of the
microphone is in [docs/voice-cancellation.md](docs/voice-cancellation.md).

Development is plain HTTP (`http://localhost:3000` for the app, `http://localhost:8080` for the API, no certificate
needed); production is HTTPS (see [api/README.md](api/README.md)).

The desktop app (Electron) is started with `cd app && bun run desktop:serve`. Its window only allows connections to
the API under a Content Security Policy (`app/electron/src/csp.ts`): `http`/`ws` too while developing, `https`/`wss`
only once packaged.

Or from the repository root: `bun run dev:api` and `bun run dev:app`. Dependency install scripts are not run
(`"trustedDependencies": []` in each `package.json`); add a package there if it really needs one.

## Licence

Proprietary software, all rights reserved (see [LICENSE](LICENSE)); the open-source packages it uses keep their own
licences ([THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)). The footer of the app shows `REACT_APP_NAME` and the current
year, so the new owner sets their own name there.
