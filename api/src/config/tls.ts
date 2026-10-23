import { existsSync } from 'node:fs';
import type { Env } from './env.ts';

export interface TlsDecision {
  useTls: boolean;
  /** one line for the startup log */
  note: string;
}

/**
 * Development is plain HTTP, production is HTTPS.
 *
 * - `TLS=auto` (default): HTTPS only in production and only when the key and certificate exist. In
 *   production without them the API speaks plain HTTP, which is what you want behind nginx or
 *   another proxy that terminates TLS.
 * - `TLS=on`: HTTPS in any environment (e.g. to test with the self-signed certificate); refuses to
 *   start when the files are missing.
 * - `TLS=off`: always plain HTTP.
 */
export function decideTls(
  env: Pick<Env, 'TLS' | 'NODE_ENV' | 'TLS_KEY_PATH' | 'TLS_CERT_PATH'>,
  fileExists: (path: string) => boolean = existsSync,
): TlsDecision {
  const haveFiles =
    fileExists(env.TLS_KEY_PATH) && fileExists(env.TLS_CERT_PATH);

  if (env.TLS === 'on') {
    if (!haveFiles)
      throw new Error(
        `TLS=on needs ${env.TLS_KEY_PATH} and ${env.TLS_CERT_PATH}, but at least one is missing`,
      );
    return { useTls: true, note: 'TLS=on' };
  }
  if (env.TLS === 'off')
    return {
      useTls: false,
      note: 'serving plain HTTP (TLS=off): only do this behind a TLS-terminating proxy',
    };

  if (env.NODE_ENV !== 'production')
    return {
      useTls: false,
      note: 'serving plain HTTP (development); production serves HTTPS, or HTTP behind a TLS-terminating proxy',
    };
  if (haveFiles) return { useTls: true, note: 'production: HTTPS' };
  return {
    useTls: false,
    note: `serving plain HTTP: no certificate at ${env.TLS_KEY_PATH}, so this must sit behind a TLS-terminating proxy`,
  };
}
