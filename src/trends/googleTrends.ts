import { logger } from '../utils/logger';
import { rateLimiter } from '../safety/rateLimiter';

// google-trends-api uses a different import pattern
let googleTrendsApi: any;
try {
  googleTrendsApi = require('google-trends-api');
} catch {
  logger.warn('google-trends-api not available');
}

export interface GoogleTrend {
  keyword: string;
  trafficVolume: number;
  isBreakout: boolean;
  relatedQueries: string[];
}

export async function scanGoogleTrends(): Promise<GoogleTrend[]> {
  if (!googleTrendsApi) {
    logger.warn('Google Trends API not loaded, skipping');
    return [];
  }

  const trends: GoogleTrend[] = [];

  try {
    // Get daily trending searches
    await rateLimiter.waitForSlot('googletrends');
    const dailyTrends = await googleTrendsApi.dailyTrends({
      geo: 'US',
    });

    rateLimiter.reportSuccess('googletrends');

    const parsed = JSON.parse(dailyTrends);
    const trendingDays = parsed?.default?.trendingSearchesDays || [];

    for (const day of trendingDays) {
      for (const search of day.trendingSearches || []) {
        const title = search.title?.query || '';
        const traffic = parseInt((search.formattedTraffic || '0').replace(/[^0-9]/g, ''), 10);

        // Filter: only interested in potential meme content
        if (isMemeRelated(title)) {
          trends.push({
            keyword: title.toLowerCase(),
            trafficVolume: traffic,
            isBreakout: traffic > 100000 || (search.formattedTraffic || '').includes('+'),
            relatedQueries: (search.relatedQueries || []).map((q: any) => q.query?.toLowerCase() || ''),
          });
        }
      }
    }

    // Also check real-time trends
    try {
      await rateLimiter.waitForSlot('googletrends');
      const realtime = await googleTrendsApi.realTimeTrends({
        geo: 'US',
        category: 'all',
      });

      rateLimiter.reportSuccess('googletrends');

      const realtimeParsed = JSON.parse(realtime);
      const stories = realtimeParsed?.storySummaries?.trendingStories || [];

      for (const story of stories) {
        const title = story.title || '';
        const articles = story.articles?.length || 0;

        if (isMemeRelated(title) && articles > 5) {
          trends.push({
            keyword: title.toLowerCase(),
            trafficVolume: articles * 1000, // rough proxy
            isBreakout: articles > 20,
            relatedQueries: (story.entityNames || []).map((e: string) => e.toLowerCase()),
          });
        }
      }
    } catch (e: any) {
      logger.debug('Real-time trends fetch failed (non-critical)', { error: e.message });
    }

    // Check interest for specific meme-related keywords using interestOverTime
    const memeKeywordsToCheck = trends.map(t => t.keyword).slice(0, 5);
    if (memeKeywordsToCheck.length > 0) {
      try {
        await rateLimiter.waitForSlot('googletrends');
        const interest = await googleTrendsApi.interestOverTime({
          keyword: memeKeywordsToCheck,
          startTime: new Date(Date.now() - 4 * 60 * 60 * 1000), // last 4 hours
          geo: 'US',
        });
        rateLimiter.reportSuccess('googletrends');

        const interestParsed = JSON.parse(interest);
        const timelineData = interestParsed?.default?.timelineData || [];

        // Check for spike pattern: last value >> first values
        if (timelineData.length >= 2) {
          const lastValue = timelineData[timelineData.length - 1]?.value?.[0] || 0;
          const firstValue = timelineData[0]?.value?.[0] || 1;
          const spikeRatio = lastValue / Math.max(firstValue, 1);

          // Update trends with spike data
          for (const trend of trends) {
            if (spikeRatio > 5) {
              trend.isBreakout = true;
              trend.trafficVolume = Math.max(trend.trafficVolume, spikeRatio * 1000);
            }
          }
        }
      } catch (e: any) {
        logger.debug('Interest over time check failed (non-critical)', { error: e.message });
      }
    }

    logger.info(`Google Trends scanner found ${trends.length} potential trends`);
    return trends;
  } catch (error: any) {
    rateLimiter.reportFailure('googletrends');
    logger.error('Google Trends scan failed', { error: error.message });
    return [];
  }
}

function isMemeRelated(text: string): boolean {
  const lower = text.toLowerCase();
  // Exclude political, sports, serious news
  const excludePatterns = [
    /\b(election|congress|senate|president|democrat|republican)\b/,
    /\b(nfl|nba|mlb|nhl|playoff|championship|super bowl)\b/,
    /\b(murder|killed|shooting|trial|sentenced|arrested)\b/,
    /\b(war|bombing|invasion|military)\b/,
    /\b(stock market|s&p 500|dow jones|nasdaq|earnings)\b/,
  ];

  if (excludePatterns.some(p => p.test(lower))) return false;

  // Include if it looks meme-related (broad for Google Trends)
  // Most Google Trends items are potentially meme-worthy if they're viral enough
  return true;
}
