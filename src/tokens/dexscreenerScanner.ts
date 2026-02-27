import axios from 'axios';
import { logger } from '../utils/logger';
import { rateLimiter } from '../safety/rateLimiter';
import { MajorTrend } from '../trends/trendAggregator';

export interface DexToken {
  mintAddress: string;
  pairAddress: string;
  name: string;
  symbol: string;
  liquidityUsd: number;
  volumeH1: number;
  volumeH24: number;
  priceChangeH1: number;
  priceChangeH24: number;
  pairCreatedAt: Date;
  txCountH1: { buys: number; sells: number };
  fdv: number;
  source: 'dexscreener';
}

const DEX_API_BASE = 'https://api.dexscreener.com';

export async function findTokens(trend: MajorTrend): Promise<DexToken[]> {
  const allTokens: DexToken[] = [];

  // Search with keyword and top aliases
  const searchTerms = [trend.keyword, ...trend.aliases].filter(
    (t, i, arr) => arr.indexOf(t) === i && !t.startsWith('$'),
  );

  for (const term of searchTerms.slice(0, 3)) {
    try {
      const tokens = await searchDexScreener(term);
      allTokens.push(...tokens);
    } catch (error: any) {
      logger.error(`DexScreener search failed for "${term}"`, { error: error.message });
    }
  }

  // Deduplicate by mint address
  const seen = new Set<string>();
  const unique = allTokens.filter(t => {
    if (seen.has(t.mintAddress)) return false;
    seen.add(t.mintAddress);
    return true;
  });

  logger.info(`DexScreener scanner found ${unique.length} tokens for trend "${trend.keyword}"`);
  return unique;
}

async function searchDexScreener(query: string): Promise<DexToken[]> {
  await rateLimiter.waitForSlot('dexscreener');

  try {
    const response = await axios.get(`${DEX_API_BASE}/latest/dex/search`, {
      params: { q: query },
      timeout: 10_000,
    });

    rateLimiter.reportSuccess('dexscreener');

    const pairs = response.data?.pairs || [];

    // Filter for Solana pairs created in the last 12 hours
    const recentCutoff = Date.now() - 12 * 60 * 60 * 1000;

    return pairs
      .filter((pair: any) => {
        return (
          pair.chainId === 'solana' &&
          pair.pairCreatedAt &&
          pair.pairCreatedAt > recentCutoff
        );
      })
      .map((pair: any) => ({
        mintAddress: pair.baseToken?.address || '',
        pairAddress: pair.pairAddress || '',
        name: pair.baseToken?.name || '',
        symbol: pair.baseToken?.symbol || '',
        liquidityUsd: pair.liquidity?.usd || 0,
        volumeH1: pair.volume?.h1 || 0,
        volumeH24: pair.volume?.h24 || 0,
        priceChangeH1: pair.priceChange?.h1 || 0,
        priceChangeH24: pair.priceChange?.h24 || 0,
        pairCreatedAt: new Date(pair.pairCreatedAt),
        txCountH1: {
          buys: pair.txns?.h1?.buys || 0,
          sells: pair.txns?.h1?.sells || 0,
        },
        fdv: pair.fdv || 0,
        source: 'dexscreener' as const,
      }))
      .filter((t: DexToken) => t.mintAddress);
  } catch (error: any) {
    rateLimiter.reportFailure('dexscreener', error?.response?.status);
    throw error;
  }
}

export async function getTokenByAddress(mintAddress: string): Promise<DexToken | null> {
  await rateLimiter.waitForSlot('dexscreener');

  try {
    const response = await axios.get(
      `${DEX_API_BASE}/latest/dex/tokens/${mintAddress}`,
      { timeout: 10_000 },
    );

    rateLimiter.reportSuccess('dexscreener');

    const pairs = response.data?.pairs || [];
    if (pairs.length === 0) return null;

    // Return the highest liquidity pair
    const best = pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    return {
      mintAddress: best.baseToken?.address || mintAddress,
      pairAddress: best.pairAddress || '',
      name: best.baseToken?.name || '',
      symbol: best.baseToken?.symbol || '',
      liquidityUsd: best.liquidity?.usd || 0,
      volumeH1: best.volume?.h1 || 0,
      volumeH24: best.volume?.h24 || 0,
      priceChangeH1: best.priceChange?.h1 || 0,
      priceChangeH24: best.priceChange?.h24 || 0,
      pairCreatedAt: new Date(best.pairCreatedAt || Date.now()),
      txCountH1: {
        buys: best.txns?.h1?.buys || 0,
        sells: best.txns?.h1?.sells || 0,
      },
      fdv: best.fdv || 0,
      source: 'dexscreener',
    };
  } catch (error: any) {
    rateLimiter.reportFailure('dexscreener', error?.response?.status);
    logger.error('DexScreener token fetch failed', { mint: mintAddress, error: error.message });
    return null;
  }
}
