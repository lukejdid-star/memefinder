import axios from 'axios';
import { logger } from '../utils/logger';
import { rateLimiter } from '../safety/rateLimiter';

export interface RedditTrend {
  keyword: string;
  subreddit: string;
  title: string;
  score: number;
  upvoteRatio: number;
  numComments: number;
  createdUtc: number;
  velocity: number; // upvotes per hour
}

const SUBREDDITS = [
  'memes',
  'dankmemes',
  'MemeEconomy',
  'CryptoCurrency',
  'solana',
  'wallstreetbets',
];

const MEME_SUBREDDITS = ['memes', 'dankmemes', 'MemeEconomy'];

export async function scanRedditTrends(): Promise<RedditTrend[]> {
  const allTrends: RedditTrend[] = [];

  for (const sub of SUBREDDITS) {
    try {
      const trends = await scanSubreddit(sub);
      allTrends.push(...trends);
    } catch (error: any) {
      logger.error(`Reddit scan failed for r/${sub}`, { error: error.message });
    }
  }

  logger.info(`Reddit scanner found ${allTrends.length} potential trends`);
  return allTrends;
}

async function scanSubreddit(subreddit: string): Promise<RedditTrend[]> {
  await rateLimiter.waitForSlot('reddit');

  try {
    const response = await axios.get(
      `https://www.reddit.com/r/${subreddit}/hot.json`,
      {
        params: { limit: 25 },
        headers: { 'User-Agent': 'MemeBot/1.0' },
        timeout: 10_000,
      },
    );

    rateLimiter.reportSuccess('reddit');

    const posts = response.data?.data?.children || [];
    const trends: RedditTrend[] = [];

    for (const post of posts) {
      const data = post.data;
      if (!data) continue;

      // Skip stickied/pinned posts
      if (data.stickied) continue;

      const ageHours = (Date.now() / 1000 - data.created_utc) / 3600;

      // Only care about posts from last 6 hours with significant engagement
      if (ageHours > 6) continue;

      const velocity = data.score / Math.max(ageHours, 0.1);

      // For meme subreddits, need high velocity. For crypto subs, lower threshold.
      const isMeme = MEME_SUBREDDITS.includes(subreddit);
      const velocityThreshold = isMeme ? 500 : 100;

      if (velocity < velocityThreshold) continue;

      // Extract keyword from title
      const keyword = extractMemeKeyword(data.title);
      if (!keyword) continue;

      trends.push({
        keyword,
        subreddit,
        title: data.title,
        score: data.score,
        upvoteRatio: data.upvote_ratio,
        numComments: data.num_comments,
        createdUtc: data.created_utc,
        velocity,
      });
    }

    return trends;
  } catch (error: any) {
    rateLimiter.reportFailure('reddit', error?.response?.status);
    throw error;
  }
}

function extractMemeKeyword(title: string): string | null {
  // Remove common filler words and extract the core meme term
  const cleaned = title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(the|a|an|is|are|was|were|be|been|being|this|that|it|its|of|for|and|or|but|in|on|at|to|from|with|by|about|when|what|who|how|why|my|your|his|her|our|their|meme|template|format|oc|gif|video)\b/g, '')
    .trim()
    .replace(/\s+/g, ' ');

  // Take the first 1-3 meaningful words
  const words = cleaned.split(' ').filter(w => w.length > 2);
  if (words.length === 0) return null;

  return words.slice(0, 3).join(' ');
}
