/**
 * Where the API lives. REACT_APP_API_HOST is `host[:port][/prefix]` (e.g. `localhost:8080` or `example.com/api`);
 * everything else is derived from it so the HTTP calls, the socket and the WebRTC signalling always agree.
 *
 * Development (the Vite dev server) talks plain http/ws, production builds talk https/wss. Put `http://` or
 * `https://` in front of the host to override that, e.g. to try a production build against a local API.
 */
export function resolveApi(rawHost: string, dev: boolean) {
  const explicit = /^(https?):\/\//i.exec(rawHost)?.[1]?.toLowerCase();
  const secure = explicit ? explicit === 'https' : !dev;
  const host = rawHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const baseUrl = `${secure ? 'https' : 'http'}://${host}`;
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '');
  return {
    secure,
    baseUrl,
    socketUrl: `${secure ? 'wss' : 'ws'}://${host}/socket`,
    peer: {
      host: url.hostname,
      port: Number(url.port || (secure ? 443 : 80)),
      path: `${prefix}/peer`,
      secure,
    },
  };
}

const api = resolveApi(import.meta.env.REACT_APP_API_HOST, import.meta.env.DEV);

export const apiBaseUrl = api.baseUrl;

export const socketUrl = api.socketUrl;

export const iceServersUrl = `${apiBaseUrl}/ice-servers`;

export function peerServerOptions() {
  return api.peer;
}

/** The public address of the web app itself (used for invitation links); REACT_APP_HOST may carry its own scheme. */
export function resolveAppUrl(rawHost: string, dev: boolean) {
  const host = rawHost.replace(/\/+$/, '');
  return /^https?:\/\//i.test(host) ? host : `${dev ? 'http' : 'https'}://${host}`;
}

export const appBaseUrl = resolveAppUrl(import.meta.env.REACT_APP_HOST, import.meta.env.DEV);
