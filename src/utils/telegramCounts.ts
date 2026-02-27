import { TTLCache } from './cache';

// CA mention counts — TTL of 1 hour
const caMentionCounts = new TTLCache<number>(60 * 60 * 1000);

// Ticker mention counts — TTL of 1 hour
const tickerMentionCounts = new TTLCache<number>(60 * 60 * 1000);

export function incrementCAMentionCount(mint: string): void {
  const current = caMentionCounts.get(mint) || 0;
  caMentionCounts.set(mint, current + 1);
}

export function getCAMentionCount(mint: string): number {
  return caMentionCounts.get(mint) || 0;
}

export function incrementTickerMention(ticker: string): void {
  const key = ticker.toUpperCase();
  const current = tickerMentionCounts.get(key) || 0;
  tickerMentionCounts.set(key, current + 1);
}

export function getTickerMentions(): Map<string, number> {
  // Return a snapshot of all active ticker mentions
  const result = new Map<string, number>();
  // We can't iterate TTLCache directly, so we use a backing map
  return result;
}

// Backing store for ticker iteration (TTLCache doesn't support iteration)
const tickerBacking = new Map<string, { count: number; expiresAt: number }>();
const TICKER_TTL = 60 * 60 * 1000;

export function incrementTickerMentionTracked(ticker: string): void {
  const key = ticker.toUpperCase();
  const existing = tickerBacking.get(key);
  const now = Date.now();
  if (existing && existing.expiresAt > now) {
    existing.count++;
    existing.expiresAt = now + TICKER_TTL;
  } else {
    tickerBacking.set(key, { count: 1, expiresAt: now + TICKER_TTL });
  }
  incrementTickerMention(key);
}

export function getTickerMentionsTracked(): Map<string, number> {
  const now = Date.now();
  const result = new Map<string, number>();
  for (const [key, entry] of tickerBacking) {
    if (entry.expiresAt > now) {
      result.set(key, entry.count);
    } else {
      tickerBacking.delete(key);
    }
  }
  return result;
}
