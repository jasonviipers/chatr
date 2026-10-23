export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

type Clock = () => number;

/** Allows short bursts (`capacity`) and a sustained rate (`refillPerSecond`). O(1), no allocation. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: Clock;

  constructor(
    capacity: number,
    refillPerSecond: number,
    now: Clock = Date.now,
  ) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }

  take(): boolean {
    const now = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (now - this.last) * this.refillPerMs,
    );
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * In-memory sliding-window limiter. Enough for a single instance serving a few hundred users;
 * bounded in size so a flood of distinct keys cannot exhaust memory.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: Clock;
  private readonly maxKeys: number;

  constructor(
    windowMs: number,
    max: number,
    now: Clock = Date.now,
    maxKeys = 50_000,
  ) {
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    this.maxKeys = maxKeys;
    this.sweeper = setInterval(() => this.sweep(), Math.max(windowMs, 30_000));
    this.sweeper.unref();
  }

  hit(key: string): RateLimitResult {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((oldest + this.windowMs - now) / 1000),
        ),
      };
    }

    recent.push(now);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.sweep(true);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  private sweep(force = false): void {
    const cutoff = this.now() - this.windowMs;
    for (const [key, times] of this.hits) {
      const last = times[times.length - 1];
      if (last === undefined || last <= cutoff) this.hits.delete(key);
    }
    if (force && this.hits.size >= this.maxKeys) {
      // still full of live keys: drop the oldest quarter rather than grow without bound
      let drop = Math.ceil(this.maxKeys / 4);
      for (const key of this.hits.keys()) {
        this.hits.delete(key);
        if (--drop <= 0) break;
      }
    }
  }
}

/**
 * Brute-force protection for sign-in: after `maxFailures` wrong attempts inside the window the
 * key (username + IP) is locked until the oldest failure ages out. A success clears it.
 */
export class LoginGuard {
  private readonly attempts = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly now: Clock;
  private readonly maxKeys: number;

  constructor(
    windowMs: number,
    maxFailures: number,
    now: Clock = Date.now,
    maxKeys = 50_000,
  ) {
    this.windowMs = windowMs;
    this.maxFailures = maxFailures;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  /** Seconds the caller must wait, or 0 when sign-in may proceed. */
  lockedFor(key: string): number {
    const recent = this.recent(key);
    if (recent.length < this.maxFailures) return 0;
    const oldest = recent[0] ?? this.now();
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    const recent = this.recent(key);
    recent.push(this.now());
    if (!this.attempts.has(key) && this.attempts.size >= this.maxKeys) {
      const oldestKey = this.attempts.keys().next().value;
      if (oldestKey !== undefined) this.attempts.delete(oldestKey);
    }
    this.attempts.set(key, recent);
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length === 0) this.attempts.delete(key);
    return recent;
  }
}
