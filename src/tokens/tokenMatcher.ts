import Fuse from 'fuse.js';
import { PumpfunToken } from './pumpfunScanner';
import { DexToken } from './dexscreenerScanner';
import { MajorTrend } from '../trends/trendAggregator';
import { logger } from '../utils/logger';

export type AlertSource = 'trend' | 'launch_monitor' | 'smart_money' | 'dex_trending' | 'jupiter_trending' | 'telegram' | 'graduation';

export interface CandidateToken {
  mintAddress: string;
  name: string;
  symbol: string;
  description: string;
  trendKeyword: string;
  matchScore: number; // 0-1, how closely it matches the trend
  pumpfunData?: PumpfunToken;
  dexData?: DexToken;
  alertSource?: AlertSource;
}

interface FuseItem {
  mintAddress: string;
  name: string;
  symbol: string;
  description: string;
  pumpfunData?: PumpfunToken;
  dexData?: DexToken;
}

export function matchAndMerge(
  trend: MajorTrend,
  pumpTokens: PumpfunToken[],
  dexTokens: DexToken[],
): CandidateToken[] {
  // Build a unified list for fuzzy matching
  const items: FuseItem[] = [];

  for (const pt of pumpTokens) {
    items.push({
      mintAddress: pt.mintAddress,
      name: pt.name,
      symbol: pt.symbol,
      description: pt.description,
      pumpfunData: pt,
    });
  }

  for (const dt of dexTokens) {
    // Check if already in items (from pumpfun)
    const existing = items.find(i => i.mintAddress === dt.mintAddress);
    if (existing) {
      existing.dexData = dt;
    } else {
      items.push({
        mintAddress: dt.mintAddress,
        name: dt.name,
        symbol: dt.symbol,
        description: '',
        dexData: dt,
      });
    }
  }

  if (items.length === 0) return [];

  // Fuzzy match against the trend keyword and aliases
  const fuse = new Fuse(items, {
    keys: [
      { name: 'name', weight: 0.4 },
      { name: 'symbol', weight: 0.35 },
      { name: 'description', weight: 0.25 },
    ],
    threshold: 0.4, // 0 = perfect match, 1 = match anything
    includeScore: true,
    shouldSort: true,
  });

  const candidates: CandidateToken[] = [];
  const seenMints = new Set<string>();

  // Search with keyword and all aliases
  const searchTerms = [trend.keyword, ...trend.aliases];

  for (const term of searchTerms) {
    const results = fuse.search(term);

    for (const result of results) {
      if (seenMints.has(result.item.mintAddress)) continue;
      seenMints.add(result.item.mintAddress);

      // Fuse score is 0 (perfect) to 1 (no match) — invert
      const matchScore = 1 - (result.score || 1);

      candidates.push({
        mintAddress: result.item.mintAddress,
        name: result.item.name,
        symbol: result.item.symbol,
        description: result.item.description,
        trendKeyword: trend.keyword,
        matchScore,
        pumpfunData: result.item.pumpfunData,
        dexData: result.item.dexData,
      });
    }
  }

  // Also do exact substring matching for cases fuse might miss
  for (const item of items) {
    if (seenMints.has(item.mintAddress)) continue;

    const lowerName = item.name.toLowerCase();
    const lowerSymbol = item.symbol.toLowerCase();

    for (const term of searchTerms) {
      const lowerTerm = term.toLowerCase().replace(/[^a-z0-9]/g, '');
      const lowerNameClean = lowerName.replace(/[^a-z0-9]/g, '');
      const lowerSymbolClean = lowerSymbol.replace(/[^a-z0-9]/g, '');

      if (lowerNameClean.includes(lowerTerm) || lowerSymbolClean.includes(lowerTerm) || lowerTerm.includes(lowerNameClean)) {
        seenMints.add(item.mintAddress);
        candidates.push({
          mintAddress: item.mintAddress,
          name: item.name,
          symbol: item.symbol,
          description: item.description,
          trendKeyword: trend.keyword,
          matchScore: 0.8, // Strong match for exact substring
          pumpfunData: item.pumpfunData,
          dexData: item.dexData,
        });
        break;
      }
    }
  }

  // Sort by match score descending
  candidates.sort((a, b) => b.matchScore - a.matchScore);

  logger.info(`Token matcher: ${candidates.length} candidates for trend "${trend.keyword}"`, {
    top3: candidates.slice(0, 3).map(c => ({ name: c.name, symbol: c.symbol, matchScore: c.matchScore.toFixed(3) })),
  });

  return candidates;
}
