export interface CspOptions {
  /** the scheme the app's own files are served from (capacitor-electron) */
  customScheme: string;
  /** running from source (electron .) rather than as a packaged app */
  isDev: boolean;
}

/**
 * The Content Security Policy of the Electron window.
 *
 * The app's own files come from the custom scheme and everything else is refused by default. The API is the one
 * thing it has to reach over the network (fetch for REST, WebSockets for the realtime socket and the signalling),
 * and that is `connect-src`. Without it the browser falls back to `default-src`, which only allows the app's own
 * scheme, and every call to the API is blocked.
 *
 * Development talks plain `http`/`ws` to a local API, a packaged app only talks `https`/`wss` (production is HTTPS).
 * Calls between participants are WebRTC, which a CSP does not govern.
 */
export function buildCsp({ customScheme, isDev }: CspOptions): string {
  const own = `${customScheme}://*`;
  const defaultSrc = isDev
    ? `default-src ${own} 'unsafe-inline' devtools://* 'unsafe-eval' data:`
    : `default-src ${own} 'unsafe-inline' data:`;
  const connectSrc = isDev
    ? `connect-src ${own} http: https: ws: wss:`
    : `connect-src ${own} https: wss:`;
  return `${defaultSrc}; ${connectSrc}`;
}
