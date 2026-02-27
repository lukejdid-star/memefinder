import { scanRedditTrends, RedditTrend } from './redditScanner';
import { scanGoogleTrends, GoogleTrend } from './googleTrends';
import { scanDexScreenerTrending, DexScreenerTrendingResult } from './dexscreenerTrending';
import { scanJupiterTrending, JupiterTrendingResult } from './jupiterTrending';
import { TTLCache } from '../utils/cache';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface MajorTrend {
  keyword: string;
  aliases: string[];
  trendScore: number; // 0-100
  detectedAt: Date;
  sources: string[];
  velocity: number;
  directMints?: string[];
}

// Cooldown cache to prevent re-triggering on the same meme
const cooldownCache = new TTLCache<number>(config.TREND_COOLDOWN_MS);

// Normalize a keyword for comparison
function normalize(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// Generate aliases for a keyword
function generateAliases(keyword: string): string[] {
  const base = keyword.toLowerCase().trim();
  const noSpaces = base.replace(/\s+/g, '');
  const dashed = base.replace(/\s+/g, '-');
  const ticker = `$${noSpaces.toUpperCase()}`;

  const aliases = new Set<string>([base, noSpaces, dashed, ticker]);

  // Also add individual words if multi-word
  const words = base.split(/\s+/);
  if (words.length > 1) {
    words.forEach(w => aliases.add(w));
  }

  return [...aliases];
}

// Check if two keywords refer to the same meme
function isSameKeyword(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

export async function getMajorTrends(): Promise<MajorTrend[]> {
  // Build parallel scan list
  const scanPromises: Promise<any>[] = [
    scanRedditTrends().catch(e => { logger.error('Reddit scan error', { error: e.message }); return [] as RedditTrend[]; }),
    scanGoogleTrends().catch(e => { logger.error('Google Trends error', { error: e.message }); return [] as GoogleTrend[]; }),
  ];

  // DexScreener trending (enabled by default)
  if (config.ENABLE_DEXSCREENER_TRENDING) {
    scanPromises.push(
      scanDexScreenerTrending().catch(e => { logger.error('DexScreener trending error', { error: e.message }); return [] as DexScreenerTrendingResult[]; }),
    );
  } else {
    scanPromises.push(Promise.resolve([] as DexScreenerTrendingResult[]));
  }

  // Jupiter trending (enabled by default)
  if (config.ENABLE_JUPITER_TRENDING) {
    scanPromises.push(
      scanJupiterTrending().catch(e => { logger.error('Jupiter trending error', { error: e.message }); return [] as JupiterTrendingResult[]; }),
    );
  } else {
    scanPromises.push(Promise.resolve([] as JupiterTrendingResult[]));
  }

  const [redditTrends, googleTrends, dexTrending, jupiterTrending] = await Promise.all(scanPromises);

  // Normalize keyword-based trends into a common format
  interface NormalizedTrend {
    keyword: string;
    source: string;
    velocity: number;
    rawScore: number; // 0-100 per source
  }

  const normalized: NormalizedTrend[] = [];

  // Reddit trends
  for (const t of redditTrends as RedditTrend[]) {
    const rawScore = Math.min(100, (t.velocity / 500) * 30 + (t.numComments / 100) * 20);
    normalized.push({
      keyword: t.keyword,
      source: 'reddit',
      velocity: t.velocity,
      rawScore,
    });
  }

  // Google trends
  for (const t of googleTrends as GoogleTrend[]) {
    const rawScore = t.isBreakout ? 80 : Math.min(60, t.trafficVolume / 5000);
    normalized.push({
      keyword: t.keyword,
      source: 'google',
      velocity: t.trafficVolume,
      rawScore,
    });
  }

  // --- Direct mint tokens from DexScreener/Jupiter trending ---
  // These don't go through keyword matching — they provide mint addresses directly
  const directMintMap = new Map<string, { name: string; symbol: string; score: number; sources: string[] }>();

  for (const t of dexTrending as DexScreenerTrendingResult[]) {
    const existing = directMintMap.get(t.mintAddress);
    if (existing) {
      existing.score = Math.max(existing.score, t.trendScore);
      if (!existing.sources.includes('dexscreener')) existing.sources.push('dexscreener');
    } else {
      directMintMap.set(t.mintAddress, {
        name: t.name,
        symbol: t.symbol,
        score: t.trendScore,
        sources: ['dexscreener'],
      });
    }
  }

  for (const t of jupiterTrending as JupiterTrendingResult[]) {
    const existing = directMintMap.get(t.mintAddress);
    if (existing) {
      existing.score = Math.max(existing.score, t.organicScore);
      if (!existing.sources.includes('jupiter')) existing.sources.push('jupiter');
      // Update name/symbol if we have better data from Jupiter
      if (t.name) existing.name = t.name;
      if (t.symbol) existing.symbol = t.symbol;
    } else {
      directMintMap.set(t.mintAddress, {
        name: t.name,
        symbol: t.symbol,
        score: t.organicScore,
        sources: ['jupiter'],
      });
    }
  }

  // Group keyword-based trends by keyword (fuzzy merge)
  const groups = new Map<string, NormalizedTrend[]>();

  for (const trend of normalized) {
    let matched = false;
    for (const [key, group] of groups) {
      if (isSameKeyword(trend.keyword, key)) {
        group.push(trend);
        matched = true;
        break;
      }
    }
    if (!matched) {
      groups.set(trend.keyword, [trend]);
    }
  }

  // Evaluate each keyword group against qualification criteria
  const majorTrends: MajorTrend[] = [];

  for (const [keyword, group] of groups) {
    const sources = [...new Set(group.map(g => g.source))];
    const maxVelocity = Math.max(...group.map(g => g.velocity));
    const avgScore = group.reduce((sum, g) => sum + g.rawScore, 0) / group.length;

    // Qualification: 2+ sources OR extreme velocity on single source
    const multiSource = sources.length >= config.TREND_MIN_SOURCES;
    const extremeVelocity = maxVelocity >= config.TREND_SINGLE_SOURCE_VELOCITY_THRESHOLD;

    if (!multiSource && !extremeVelocity) continue;

    // Check cooldown
    if (cooldownCache.has(normalize(keyword))) {
      logger.debug(`Trend "${keyword}" is in cooldown, skipping`);
      continue;
    }

    // Cross-reference: if a keyword trend matches a direct token's name/symbol, attach the mint
    const matchedMints: string[] = [];
    for (const [mint, data] of directMintMap) {
      const normalizedName = normalize(data.name);
      const normalizedSymbol = normalize(data.symbol);
      const normalizedKeyword = normalize(keyword);
      if (
        normalizedName.includes(normalizedKeyword) ||
        normalizedSymbol.includes(normalizedKeyword) ||
        normalizedKeyword.includes(normalizedName) ||
        normalizedKeyword.includes(normalizedSymbol)
      ) {
        matchedMints.push(mint);
      }
    }

    // Compute composite trend score
    const sourceBonus = sources.length * 15;
    const trendScore = Math.min(100, avgScore + sourceBonus);

    majorTrends.push({
      keyword,
      aliases: generateAliases(keyword),
      trendScore,
      detectedAt: new Date(),
      sources,
      velocity: maxVelocity,
      directMints: matchedMints.length > 0 ? matchedMints : undefined,
    });
  }

  // Create direct-mint trends for tokens found on DexScreener/Jupiter but not matched to keywords
  // These become their own "trends" with directMints
  const usedMints = new Set<string>();
  for (const trend of majorTrends) {
    if (trend.directMints) {
      trend.directMints.forEach(m => usedMints.add(m));
    }
  }

  // Group direct mints by source combination and batch them
  const unmatched: string[] = [];
  for (const [mint] of directMintMap) {
    if (!usedMints.has(mint)) {
      unmatched.push(mint);
    }
  }

  if (unmatched.length > 0) {
    // Check cooldown for direct mint "trend"
    const cooldownKey = 'direct_trending';
    if (!cooldownCache.has(cooldownKey)) {
      // Compute average score across unmatched direct tokens
      let totalScore = 0;
      const allSources = new Set<string>();
      for (const mint of unmatched) {
        const data = directMintMap.get(mint)!;
        totalScore += data.score;
        data.sources.forEach(s => allSources.add(s));
      }
      const avgScore = totalScore / unmatched.length;

      majorTrends.push({
        keyword: 'Trending Tokens',
        aliases: [],
        trendScore: Math.min(100, avgScore),
        detectedAt: new Date(),
        sources: [...allSources],
        velocity: unmatched.length * 100,
        directMints: unmatched,
      });
    }
  }

  // Sort by score descending
  majorTrends.sort((a, b) => b.trendScore - a.trendScore);

  logger.info(`Trend aggregator: ${majorTrends.length} MAJOR trends qualified`, {
    trends: majorTrends.map(t => ({
      keyword: t.keyword,
      score: t.trendScore,
      sources: t.sources,
      directMints: t.directMints?.length || 0,
    })),
  });

  return majorTrends;
}

export function setCooldown(keyword: string): void {
  cooldownCache.set(normalize(keyword), Date.now());
}

export function isInCooldown(keyword: string): boolean {
  return cooldownCache.has(normalize(keyword));
}
