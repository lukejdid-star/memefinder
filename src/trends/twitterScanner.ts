import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { rateLimiter } from '../safety/rateLimiter';

export interface TwitterTrend {
  keyword: string;
  tweetVolume: number;
  velocity: number; // tweets per hour, estimated
  sampleTweets: string[];
}

const MEME_COIN_KEYWORDS = ['coin', 'token', 'solana', 'pump', 'moon', 'degen', 'ape', 'buy', '$'];
const EXCLUDE_CATEGORIES = [
  /\b(nfl|nba|mlb|nhl|premier league|champions league|world cup)\b/i,
  /\b(democrat|republican|trump|biden|congress|senate|election)\b/i,
  /\b(arrested|sentenced|indicted|verdict)\b/i,
];

export async function scanTwitterTrends(): Promise<TwitterTrend[]> {
  if (!config.TWITTER_BEARER_TOKEN) {
    logger.warn('Twitter bearer token not configured, skipping Twitter scan');
    return [];
  }

  try {
    await rateLimiter.waitForSlot('twitter');

    // Get trending topics (US)
    const trendsResponse = await axios.get(
      'https://api.twitter.com/2/trends/by/woeid/23424977', // US WOEID
      {
        headers: { Authorization: `Bearer ${config.TWITTER_BEARER_TOKEN}` },
        timeout: 10_000,
      },
    );

    rateLimiter.reportSuccess('twitter');

    const trends: TwitterTrend[] = [];

    for (const trend of trendsResponse.data?.data || []) {
      const name: string = trend.trend_name || trend.name || '';
      const volume: number = trend.tweet_count || trend.tweet_volume || 0;

      // Filter out non-meme categories
      if (EXCLUDE_CATEGORIES.some(re => re.test(name))) continue;

      // Estimate velocity (assume trending data covers ~4 hours)
      const velocity = volume / 4;

      trends.push({
        keyword: name.replace(/^#/, '').toLowerCase(),
        tweetVolume: volume,
        velocity,
        sampleTweets: [],
      });
    }

    // Also search for meme-coin-specific trending terms
    const memeSearchResults = await searchMemeRelatedTweets();
    trends.push(...memeSearchResults);

    logger.info(`Twitter scanner found ${trends.length} potential trends`);
    return trends;
  } catch (error: any) {
    rateLimiter.reportFailure('twitter', error?.response?.status);
    logger.error('Twitter scan failed', { error: error.message, status: error?.response?.status });
    return [];
  }
}

async function searchMemeRelatedTweets(): Promise<TwitterTrend[]> {
  if (!config.TWITTER_BEARER_TOKEN) return [];

  try {
    await rateLimiter.waitForSlot('twitter');

    // Search for tweets with meme coin indicators
    const query = '(solana OR $SOL OR pump.fun) (coin OR token OR launch OR moon) -is:retweet lang:en';
    const response = await axios.get(
      'https://api.twitter.com/2/tweets/search/recent',
      {
        params: {
          query,
          max_results: 100,
          'tweet.fields': 'created_at,public_metrics',
        },
        headers: { Authorization: `Bearer ${config.TWITTER_BEARER_TOKEN}` },
        timeout: 10_000,
      },
    );

    rateLimiter.reportSuccess('twitter');

    // Extract frequently mentioned keywords from these tweets
    const keywordCounts = new Map<string, number>();
    for (const tweet of response.data?.data || []) {
      const text: string = tweet.text || '';
      // Extract potential meme names: $TICKER patterns and capitalized words
      const tickers = text.match(/\$[A-Z]{2,10}/g) || [];
      for (const ticker of tickers) {
        const clean = ticker.replace('$', '').toLowerCase();
        keywordCounts.set(clean, (keywordCounts.get(clean) || 0) + 1);
      }
    }

    // Only return keywords with significant mentions
    const trends: TwitterTrend[] = [];
    for (const [keyword, count] of keywordCounts) {
      if (count >= 5 && !['sol', 'btc', 'eth', 'usdc', 'usdt'].includes(keyword)) {
        trends.push({
          keyword,
          tweetVolume: count * 50, // rough estimate of broader volume
          velocity: count * 12,     // rough extrapolation to hourly
          sampleTweets: [],
        });
      }
    }

    return trends;
  } catch (error: any) {
    rateLimiter.reportFailure('twitter', error?.response?.status);
    logger.error('Twitter meme search failed', { error: error.message });
    return [];
  }
}

export async function searchCAMentions(contractAddress: string): Promise<{ count: number; uniqueAuthors: number; qualityRatio: number }> {
  if (!config.TWITTER_BEARER_TOKEN) {
    return { count: 0, uniqueAuthors: 0, qualityRatio: 0 };
  }

  try {
    await rateLimiter.waitForSlot('twitter');

    const response = await axios.get(
      'https://api.twitter.com/2/tweets/search/recent',
      {
        params: {
          query: `"${contractAddress}" -is:retweet`,
          max_results: 100,
          'tweet.fields': 'created_at,public_metrics,author_id',
          'user.fields': 'public_metrics',
          expansions: 'author_id',
        },
        headers: { Authorization: `Bearer ${config.TWITTER_BEARER_TOKEN}` },
        timeout: 10_000,
      },
    );

    rateLimiter.reportSuccess('twitter');

    const tweets = response.data?.data || [];
    const users = response.data?.includes?.users || [];

    const uniqueAuthors = new Set(tweets.map((t: any) => t.author_id)).size;

    // Quality ratio: what fraction of authors have >10 followers
    let qualityCount = 0;
    for (const user of users) {
      if ((user.public_metrics?.followers_count || 0) > 10) {
        qualityCount++;
      }
    }
    const qualityRatio = users.length > 0 ? qualityCount / users.length : 0;

    return {
      count: tweets.length,
      uniqueAuthors,
      qualityRatio,
    };
  } catch (error: any) {
    rateLimiter.reportFailure('twitter', error?.response?.status);
    logger.error('CA mention search failed', { error: error.message, ca: contractAddress });
    return { count: 0, uniqueAuthors: 0, qualityRatio: 0 };
  }
}
