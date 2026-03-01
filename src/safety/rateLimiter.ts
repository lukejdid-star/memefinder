import { logger } from '../utils/logger';

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  maxConcurrent: number;
  minDelayMs: number; // minimum time between consecutive requests
}

interface RateLimitState {
  timestamps: number[];
  backoffUntil: number;
  consecutiveFailures: number;
  inFlight: number;
  concurrencyQueue: (() => void)[];
  lastRequestTime: number;
  quotaExhausted: boolean;
}

const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  reddit: { maxRequests: 60, windowMs: 60_000, maxConcurrent: 10, minDelayMs: 0 },
  dexscreener: { maxRequests: 30, windowMs: 60_000, maxConcurrent: 5, minDelayMs: 0 },
  pumpfun: { maxRequests: 20, windowMs: 60_000, maxConcurrent: 5, minDelayMs: 0 },
  jupiter: { maxRequests: 30, windowMs: 60_000, maxConcurrent: 3, minDelayMs: 0 },
  helius: { maxRequests: 50, windowMs: 60_000, maxConcurrent: 1, minDelayMs: 350 },
  googletrends: { maxRequests: 10, windowMs: 60_000, maxConcurrent: 5, minDelayMs: 0 },
  goplus: { maxRequests: 30, windowMs: 60_000, maxConcurrent: 5, minDelayMs: 0 },
  heliusws: { maxRequests: 100, windowMs: 60_000, maxConcurrent: 10, minDelayMs: 0 },
  pumpfunlaunch: { maxRequests: 10, windowMs: 60_000, maxConcurrent: 5, minDelayMs: 0 },
  dexscreenertrending: { maxRequests: 30, windowMs: 60_000, maxConcurrent: 5, minDelayMs: 0 },
  jupitertrending: { maxRequests: 20, windowMs: 60_000, maxConcurrent: 5, minDelayMs: 0 },
  telegram: { maxRequests: 30, windowMs: 60_000, maxConcurrent: 5, minDelayMs: 0 },
};

// Consecutive failures after which we assume source is unavailable
const QUOTA_EXHAUSTED_THRESHOLD = 5;

class RateLimiter {
  private states = new Map<string, RateLimitState>();

  private getState(source: string): RateLimitState {
    let state = this.states.get(source);
    if (!state) {
      state = {
        timestamps: [],
        backoffUntil: 0,
        consecutiveFailures: 0,
        inFlight: 0,
        concurrencyQueue: [],
        lastRequestTime: 0,
        quotaExhausted: false,
      };
      this.states.set(source, state);
    }
    return state;
  }

  isQuotaExhausted(source: string): boolean {
    return this.getState(source).quotaExhausted;
  }

  async waitForSlot(source: string): Promise<void> {
    const limits = DEFAULT_LIMITS[source];
    if (!limits) return;

    const state = this.getState(source);

    // If quota is exhausted, throw immediately so callers can use fallback values
    if (state.quotaExhausted) {
      throw new Error(`${source} quota exhausted — skipping request`);
    }

    // Wait for concurrency slot (semaphore)
    while (state.inFlight >= limits.maxConcurrent) {
      await new Promise<void>(resolve => state.concurrencyQueue.push(resolve));
      // Re-check quota after waking (may have been set while we waited)
      if (state.quotaExhausted) {
        throw new Error(`${source} quota exhausted — skipping request`);
      }
    }
    state.inFlight++;

    // Respect backoff
    if (state.backoffUntil > Date.now()) {
      const waitMs = state.backoffUntil - Date.now();
      logger.warn(`Rate limiter: backing off ${source} for ${waitMs}ms`);
      await this.sleep(waitMs);
    }

    // Enforce minimum delay between requests
    if (limits.minDelayMs > 0 && state.lastRequestTime > 0) {
      const elapsed = Date.now() - state.lastRequestTime;
      if (elapsed < limits.minDelayMs) {
        await this.sleep(limits.minDelayMs - elapsed);
      }
    }

    // Prune old timestamps
    const cutoff = Date.now() - limits.windowMs;
    state.timestamps = state.timestamps.filter(t => t > cutoff);

    // Wait if at capacity
    if (state.timestamps.length >= limits.maxRequests) {
      const oldestInWindow = state.timestamps[0];
      const waitMs = oldestInWindow + limits.windowMs - Date.now() + 100;
      if (waitMs > 0) {
        logger.debug(`Rate limiter: waiting ${waitMs}ms for ${source}`);
        await this.sleep(waitMs);
        // Re-prune after wait
        const newCutoff = Date.now() - limits.windowMs;
        state.timestamps = state.timestamps.filter(t => t > newCutoff);
      }
    }

    state.timestamps.push(Date.now());
    state.lastRequestTime = Date.now();
  }

  private releaseConcurrencySlot(source: string): void {
    const state = this.getState(source);
    state.inFlight = Math.max(0, state.inFlight - 1);
    if (state.concurrencyQueue.length > 0) {
      const next = state.concurrencyQueue.shift()!;
      next();
    }
  }

  private drainConcurrencyQueue(source: string): void {
    const state = this.getState(source);
    // Wake all waiters so they can see the quota is exhausted
    while (state.concurrencyQueue.length > 0) {
      const next = state.concurrencyQueue.shift()!;
      next();
    }
  }

  reportSuccess(source: string): void {
    const state = this.getState(source);
    state.consecutiveFailures = 0;
    state.quotaExhausted = false;
    this.releaseConcurrencySlot(source);
  }

  reportFailure(source: string, statusCode?: number): void {
    const state = this.getState(source);

    // If quota is already exhausted, no real request was made — skip silently
    if (state.quotaExhausted) return;

    state.consecutiveFailures++;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 60s
    const backoffMs = Math.min(
      1000 * Math.pow(2, state.consecutiveFailures - 1),
      60_000,
    );

    // If it's a 429, use longer backoff
    if (statusCode === 429) {
      state.backoffUntil = Date.now() + backoffMs * 3;
    } else {
      state.backoffUntil = Date.now() + backoffMs;
    }

    // After many consecutive failures, assume source is unavailable
    // Reset automatically on any success via reportSuccess()
    if (state.consecutiveFailures >= QUOTA_EXHAUSTED_THRESHOLD && !state.quotaExhausted) {
      state.quotaExhausted = true;
      logger.error(`Rate limiter: ${source} appears unavailable after ${state.consecutiveFailures} consecutive failures — disabling requests`);
      // Wake all queued waiters so they can exit immediately
      this.drainConcurrencyQueue(source);
    }

    logger.warn(`Rate limiter: ${source} failure #${state.consecutiveFailures}, backoff ${backoffMs}ms`, {
      statusCode,
    });

    this.releaseConcurrencySlot(source);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const rateLimiter = new RateLimiter();
