import axios from 'axios';
import { logger } from '../utils/logger';
import { rateLimiter } from '../safety/rateLimiter';
import { MajorTrend } from '../trends/trendAggregator';

export interface PumpfunToken {
  mintAddress: string;
  name: string;
  symbol: string;
  description: string;
  imageUri: string;
  creatorAddress: string;
  createdAt: Date;
  bondingCurveProgress: number; // 0-100%
  replyCount: number;
  marketCapSol: number;
  source: 'pumpfun';
}

const PUMPFUN_API_BASE = 'https://frontend-api.pump.fun';

export async function findTokens(trend: MajorTrend): Promise<PumpfunToken[]> {
  const allTokens: PumpfunToken[] = [];

  // Search with the main keyword and all aliases
  const searchTerms = [trend.keyword, ...trend.aliases].filter(
    (t, i, arr) => arr.indexOf(t) === i && !t.startsWith('$'),
  );

  for (const term of searchTerms.slice(0, 3)) { // Limit to 3 searches per trend
    try {
      const tokens = await searchPumpfun(term);
      allTokens.push(...tokens);
    } catch (error: any) {
      logger.error(`Pump.fun search failed for "${term}"`, { error: error.message });
    }
  }

  // Deduplicate by mint address
  const seen = new Set<string>();
  const unique = allTokens.filter(t => {
    if (seen.has(t.mintAddress)) return false;
    seen.add(t.mintAddress);
    return true;
  });

  logger.info(`Pump.fun scanner found ${unique.length} tokens for trend "${trend.keyword}"`);
  return unique;
}

async function searchPumpfun(query: string): Promise<PumpfunToken[]> {
  await rateLimiter.waitForSlot('pumpfun');

  try {
    // Try the search/coins endpoint
    const response = await axios.get(`${PUMPFUN_API_BASE}/coins`, {
      params: {
        offset: 0,
        limit: 50,
        sort: 'last_trade_timestamp',
        order: 'DESC',
        includeNsfw: false,
        searchTerm: query,
      },
      timeout: 10_000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
      },
    });

    rateLimiter.reportSuccess('pumpfun');

    const coins = Array.isArray(response.data) ? response.data : response.data?.coins || [];

    return coins.map((coin: any) => ({
      mintAddress: coin.mint || coin.address || '',
      name: coin.name || '',
      symbol: coin.symbol || '',
      description: coin.description || '',
      imageUri: coin.image_uri || coin.uri || '',
      creatorAddress: coin.creator || '',
      createdAt: new Date(coin.created_timestamp || Date.now()),
      bondingCurveProgress: parseBondingProgress(coin),
      replyCount: coin.reply_count || 0,
      marketCapSol: coin.market_cap_sol || coin.usd_market_cap / 100 || 0,
      source: 'pumpfun' as const,
    })).filter((t: PumpfunToken) => t.mintAddress);
  } catch (error: any) {
    rateLimiter.reportFailure('pumpfun', error?.response?.status);
    throw error;
  }
}

function parseBondingProgress(coin: any): number {
  // Bonding curve progress can come in different formats
  if (typeof coin.bonding_curve_progress === 'number') {
    return coin.bonding_curve_progress;
  }
  if (coin.complete === true) return 100;
  if (coin.market_cap_sol && coin.market_cap_sol > 0) {
    // Pump.fun bonding curve typically completes around 85 SOL market cap
    return Math.min(100, (coin.market_cap_sol / 85) * 100);
  }
  return 0;
}

export async function getTokenDetails(mintAddress: string): Promise<PumpfunToken | null> {
  await rateLimiter.waitForSlot('pumpfun');

  try {
    const response = await axios.get(`${PUMPFUN_API_BASE}/coins/${mintAddress}`, {
      timeout: 10_000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
      },
    });

    rateLimiter.reportSuccess('pumpfun');
    const coin = response.data;

    if (!coin || !coin.mint) return null;

    return {
      mintAddress: coin.mint,
      name: coin.name || '',
      symbol: coin.symbol || '',
      description: coin.description || '',
      imageUri: coin.image_uri || '',
      creatorAddress: coin.creator || '',
      createdAt: new Date(coin.created_timestamp || Date.now()),
      bondingCurveProgress: parseBondingProgress(coin),
      replyCount: coin.reply_count || 0,
      marketCapSol: coin.market_cap_sol || 0,
      source: 'pumpfun',
    };
  } catch (error: any) {
    rateLimiter.reportFailure('pumpfun', error?.response?.status);
    logger.error('Pump.fun token details fetch failed', { mint: mintAddress, error: error.message });
    return null;
  }
}
