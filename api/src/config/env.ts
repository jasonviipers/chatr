import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),

  DATABASE_PATH: z.string().default('./data/chatr.sqlite'),

  /** Signs session tokens. Required in production; generated per process otherwise. */
  AUTH_SECRET: z
    .string()
    .min(32, 'AUTH_SECRET must be at least 32 characters')
    .optional(),
  /** Public URL of this API (used by Better Auth for redirects / cookie scoping). */
  BASE_URL: z.url().optional(),

  /** `host[:port]` of the web app (kept from the previous API) plus extra exact origins. */
  WEB_APP_HOST: z.string().optional(),
  ALLOWED_ORIGINS: csv,

  /**
   * `auto`: plain HTTP in development, HTTPS in production when the key/cert files exist (plain HTTP
   * behind a TLS-terminating proxy otherwise). `on`: HTTPS everywhere. `off`: always plain HTTP.
   */
  TLS: z.enum(['auto', 'on', 'off']).default('auto'),
  TLS_KEY_PATH: z.string().default('./ssl/key.pem'),
  TLS_CERT_PATH: z.string().default('./ssl/cert.pem'),
  /** Trust X-Forwarded-For (only enable behind a reverse proxy you control). */
  TRUST_PROXY: z.stringbool().default(false),

  /** WebRTC ICE servers handed to clients. TURN is what makes bad networks / strict NATs work. */
  STUN_URLS: csv.transform((urls) =>
    urls.length > 0 ? urls : ['stun:stun.l.google.com:19302'],
  ),
  TURN_URLS: csv,
  /** Shared secret of coturn (`use-auth-secret`); credentials are time limited. */
  TURN_SECRET: z.string().min(16).optional(),
  TURN_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  /**
   * Cloudflare Realtime TURN (https://developers.cloudflare.com/realtime/turn/): create a TURN key in the
   * dashboard and put its id and API token here. Both or neither. It can be used next to coturn.
   */
  CLOUDFLARE_TURN_KEY_ID: z.string().min(1).optional(),
  CLOUDFLARE_TURN_API_TOKEN: z.string().min(1).optional(),
  /** How long the relay credentials last. It must outlast the longest meeting; Cloudflare allows up to 48 hours. */
  CLOUDFLARE_TURN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(600)
    .max(172_800)
    .default(86_400),
  /** Only changed in tests. */
  CLOUDFLARE_TURN_API_URL: z
    .url()
    .transform((url) => url.replace(/\/+$/, ''))
    .default('https://rtc.live.cloudflare.com'),

  MAX_CONNECTIONS: z.coerce.number().int().min(1).default(2000),
  MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(1).default(60),
});

export type Env = z.infer<typeof schema> & {
  authSecret: string;
  allowedOrigins: ReadonlySet<string>;
};

/** Browsers, the Capacitor apps and Electron send these exact origins. */
const APP_ORIGINS = [
  'capacitor://localhost', // iOS
  'ionic://localhost',
  'https://localhost', // Android
  'http://localhost',
  'capacitor-electron://-', // Electron
];

const DEV_ORIGINS = [
  'https://localhost:3000',
  'http://localhost:3000',
  'https://localhost:3001',
];

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  // `KEY=` in a .env file (or an unset compose variable) means "not set", not "an empty value"
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== ''),
  );
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${problems}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production' && !env.AUTH_SECRET) {
    throw new Error(
      'Invalid environment:\n  AUTH_SECRET: required in production (min 32 characters)',
    );
  }
  if (
    Boolean(env.CLOUDFLARE_TURN_KEY_ID) !==
    Boolean(env.CLOUDFLARE_TURN_API_TOKEN)
  ) {
    const missing = env.CLOUDFLARE_TURN_KEY_ID
      ? 'CLOUDFLARE_TURN_API_TOKEN'
      : 'CLOUDFLARE_TURN_KEY_ID';
    throw new Error(
      `Invalid environment:\n  ${missing}: required together with the other CLOUDFLARE_TURN_* key setting`,
    );
  }
  const authSecret = env.AUTH_SECRET ?? randomBytes(32).toString('base64url');

  const origins = new Set<string>([...APP_ORIGINS, ...env.ALLOWED_ORIGINS]);
  if (env.NODE_ENV !== 'production')
    for (const origin of DEV_ORIGINS) origins.add(origin);
  if (env.WEB_APP_HOST) {
    // host[:port]; a scheme or trailing slash that slipped in is tolerated
    const host = env.WEB_APP_HOST.replace(/^https?:\/\//i, '').replace(
      /\/+$/,
      '',
    );
    origins.add(`https://${host}`);
    if (env.NODE_ENV !== 'production') origins.add(`http://${host}`);
  }

  return { ...env, authSecret, allowedOrigins: origins };
}
