import { logger } from '../utils/logger';

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

interface RateLimitState {
  timestamps: number[];
  backoffUntil: number;
  consecutiveFailures: number;
}

const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  twitter: { maxRequests: 15, windowMs: 15 * 60 * 1000 },      // 15 per 15min
  reddit: { maxRequests: 60, windowMs: 60 * 1000 },             // 60 per min
  dexscreener: { maxRequests: 30, windowMs: 60 * 1000 },        // 30 per min
  pumpfun: { maxRequests: 20, windowMs: 60 * 1000 },            // 20 per min
  jupiter: { maxRequests: 30, windowMs: 60 * 1000 },            // 30 per min
  helius: { maxRequests: 50, windowMs: 60 * 1000 },             // 50 per min
  googletrends: { maxRequests: 10, windowMs: 60 * 1000 },       // 10 per min
  goplus: { maxRequests: 30, windowMs: 60 * 1000 },             // 30 per min
  heliusws: { maxRequests: 100, windowMs: 60 * 1000 },          // 100 per min
  pumpfunlaunch: { maxRequests: 10, windowMs: 60 * 1000 },      // 10 per min
};

class RateLimiter {
  private states = new Map<string, RateLimitState>();

  private getState(source: string): RateLimitState {
    let state = this.states.get(source);
    if (!state) {
      state = { timestamps: [], backoffUntil: 0, consecutiveFailures: 0 };
      this.states.set(source, state);
    }
    return state;
  }

  async waitForSlot(source: string): Promise<void> {
    const limits = DEFAULT_LIMITS[source];
    if (!limits) return; // No rate limit configured for this source

    const state = this.getState(source);

    // Respect backoff
    if (state.backoffUntil > Date.now()) {
      const waitMs = state.backoffUntil - Date.now();
      logger.warn(`Rate limiter: backing off ${source} for ${waitMs}ms`);
      await this.sleep(waitMs);
    }

    // Prune old timestamps
    const cutoff = Date.now() - limits.windowMs;
    state.timestamps = state.timestamps.filter(t => t > cutoff);

    // Wait if at capacity
    if (state.timestamps.length >= limits.maxRequests) {
      const oldestInWindow = state.timestamps[0];
      const waitMs = oldestInWindow + limits.windowMs - Date.now() + 100; // +100ms buffer
      if (waitMs > 0) {
        logger.debug(`Rate limiter: waiting ${waitMs}ms for ${source}`);
        await this.sleep(waitMs);
        // Re-prune after wait
        const newCutoff = Date.now() - limits.windowMs;
        state.timestamps = state.timestamps.filter(t => t > newCutoff);
      }
    }

    state.timestamps.push(Date.now());
  }

  reportSuccess(source: string): void {
    const state = this.getState(source);
    state.consecutiveFailures = 0;
  }

  reportFailure(source: string, statusCode?: number): void {
    const state = this.getState(source);
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

    logger.warn(`Rate limiter: ${source} failure #${state.consecutiveFailures}, backoff ${backoffMs}ms`, {
      statusCode,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const rateLimiter = new RateLimiter();
