import axios from 'axios';
import { logger } from '../utils/logger';
import { rateLimiter } from '../safety/rateLimiter';
import { config } from '../config';

export interface JupiterTrendingResult {
  mintAddress: string;
  name: string;
  symbol: string;
  organicScore: number;
}

export async function scanJupiterTrending(): Promise<JupiterTrendingResult[]> {
  try {
    await rateLimiter.waitForSlot('jupitertrending');

    const interval = config.JUPITER_TRENDING_INTERVAL;
    const response = await axios.get(
      `https://tokens.jup.ag/tokens/trending/${interval}`,
      { timeout: 10_000 },
    );

    rateLimiter.reportSuccess('jupitertrending');

    const tokens: any[] = Array.isArray(response.data) ? response.data : [];
    const results: JupiterTrendingResult[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token.address) continue;

      // Rank-based score: top tokens get higher scores
      const rankScore = Math.max(0, 100 - i * 3);

      results.push({
        mintAddress: token.address,
        name: token.name || token.symbol || '',
        symbol: token.symbol || '',
        organicScore: rankScore,
      });
    }

    logger.info(`Jupiter trending: ${results.length} tokens found`);
    return results;
  } catch (error: any) {
    rateLimiter.reportFailure('jupitertrending', error?.response?.status);
    logger.error('Jupiter trending scan failed', { error: error.message });
    return [];
  }
}
