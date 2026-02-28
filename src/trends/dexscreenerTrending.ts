import axios from 'axios';
import { logger } from '../utils/logger';
import { rateLimiter } from '../safety/rateLimiter';

export interface DexScreenerTrendingResult {
  mintAddress: string;
  name: string;
  symbol: string;
  volume24h: number;
  trendScore: number;
  source: 'dexscreener_trending' | 'dexscreener_boosted';
}

export async function scanDexScreenerTrending(): Promise<DexScreenerTrendingResult[]> {
  const results: DexScreenerTrendingResult[] = [];

  // Fetch trending Solana tokens
  try {
    await rateLimiter.waitForSlot('dexscreenertrending');

    const response = await axios.get(
      'https://api.dexscreener.com/token-profiles/latest/v1',
      { timeout: 10_000 },
    );

    rateLimiter.reportSuccess('dexscreenertrending');

    const tokens: any[] = Array.isArray(response.data) ? response.data : [];

    for (const token of tokens) {
      if (token.chainId !== 'solana') continue;

      results.push({
        mintAddress: token.tokenAddress || '',
        name: token.description || token.tokenAddress || '',
        symbol: token.tokenAddress?.slice(0, 6) || '',
        volume24h: 0,
        trendScore: 60, // Base score for appearing in profiles
        source: 'dexscreener_trending',
      });
    }
  } catch (error: any) {
    rateLimiter.reportFailure('dexscreenertrending', error?.response?.status);
    logger.error('DexScreener trending scan failed', { error: error.message });
  }

  // Fetch boosted tokens
  try {
    await rateLimiter.waitForSlot('dexscreenertrending');

    const response = await axios.get(
      'https://api.dexscreener.com/token-boosts/latest/v1',
      { timeout: 10_000 },
    );

    rateLimiter.reportSuccess('dexscreenertrending');

    const tokens: any[] = Array.isArray(response.data) ? response.data : [];

    for (const token of tokens) {
      if (token.chainId !== 'solana') continue;

      const existing = results.find(r => r.mintAddress === token.tokenAddress);
      if (existing) {
        existing.trendScore = Math.min(100, existing.trendScore + 20);
        continue;
      }

      results.push({
        mintAddress: token.tokenAddress || '',
        name: token.description || token.tokenAddress || '',
        symbol: token.tokenAddress?.slice(0, 6) || '',
        volume24h: 0,
        trendScore: Math.min(100, 50 + (token.amount || 0)), // More boosts = higher score, capped at 100
        source: 'dexscreener_boosted',
      });
    }
  } catch (error: any) {
    rateLimiter.reportFailure('dexscreenertrending', error?.response?.status);
    logger.error('DexScreener boost scan failed', { error: error.message });
  }

  // Filter to valid mint addresses only
  const valid = results.filter(r => r.mintAddress.length >= 32);

  logger.info(`DexScreener trending: ${valid.length} Solana tokens found`);
  return valid;
}
