import { Hono } from 'hono';
import type { AppEnv } from '../lib/http.ts';
import type { AppDeps } from './deps.ts';

/** HTTP side of the PeerJS signalling protocol (the WebSocket side lives in realtime/gateway.ts). */
export function peerRoutes(deps: AppDeps) {
  const info = (c: { json: (value: object) => Response }) =>
    c.json({
      name: 'Chatr signalling',
      description: 'WebRTC signalling for Chatr meetings.',
      website: 'https://peerjs.com/',
    });

  return (
    new Hono<AppEnv>()
      .get('/peer', info)
      .get('/peer/', info)
      // The client asks for an id before it connects; it becomes the meeting id for hosts
      .get('/peer/:key/id', (c) => c.text(deps.newPeerId()))
      // Listing peers would let anyone enumerate meetings
      .get('/peer/:key/peers', (c) => c.text('Unauthorized', 401))
  );
}
