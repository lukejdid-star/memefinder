import { scanTwitterTrends, TwitterTrend } from './twitterScanner';
import { scanRedditTrends, RedditTrend } from './redditScanner';
import { scanGoogleTrends, GoogleTrend } from './googleTrends';
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
  // Scan all sources in parallel
  const [twitterTrends, redditTrends, googleTrends] = await Promise.all([
    scanTwitterTrends().catch(e => { logger.error('Twitter scan error', { error: e.message }); return [] as TwitterTrend[]; }),
    scanRedditTrends().catch(e => { logger.error('Reddit scan error', { error: e.message }); return [] as RedditTrend[]; }),
    scanGoogleTrends().catch(e => { logger.error('Google Trends error', { error: e.message }); return [] as GoogleTrend[]; }),
  ]);

  // Normalize all trends into a common format
  interface NormalizedTrend {
    keyword: string;
    source: string;
    velocity: number;
    rawScore: number; // 0-100 per source
  }

  const normalized: NormalizedTrend[] = [];

  // Twitter trends
  for (const t of twitterTrends) {
    const rawScore = Math.min(100, (t.velocity / 1000) * 10);
    normalized.push({
      keyword: t.keyword,
      source: 'twitter',
      velocity: t.velocity,
      rawScore,
    });
  }

  // Reddit trends
  for (const t of redditTrends) {
    const rawScore = Math.min(100, (t.velocity / 500) * 30 + (t.numComments / 100) * 20);
    normalized.push({
      keyword: t.keyword,
      source: 'reddit',
      velocity: t.velocity,
      rawScore,
    });
  }

  // Google trends
  for (const t of googleTrends) {
    const rawScore = t.isBreakout ? 80 : Math.min(60, t.trafficVolume / 5000);
    normalized.push({
      keyword: t.keyword,
      source: 'google',
      velocity: t.trafficVolume,
      rawScore,
    });
  }

  // Group by keyword (fuzzy merge)
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

  // Evaluate each group against qualification criteria
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

    // Compute composite trend score
    const sourceBonus = sources.length * 15; // bonus for appearing on multiple platforms
    const trendScore = Math.min(100, avgScore + sourceBonus);

    majorTrends.push({
      keyword,
      aliases: generateAliases(keyword),
      trendScore,
      detectedAt: new Date(),
      sources,
      velocity: maxVelocity,
    });
  }

  // Sort by score descending
  majorTrends.sort((a, b) => b.trendScore - a.trendScore);

  logger.info(`Trend aggregator: ${majorTrends.length} MAJOR trends qualified`, {
    trends: majorTrends.map(t => ({ keyword: t.keyword, score: t.trendScore, sources: t.sources })),
  });

  return majorTrends;
}

export function setCooldown(keyword: string): void {
  cooldownCache.set(normalize(keyword), Date.now());
}

export function isInCooldown(keyword: string): boolean {
  return cooldownCache.has(normalize(keyword));
}
