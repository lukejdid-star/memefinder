import { searchCAMentions } from '../trends/twitterScanner';
import { logger } from '../utils/logger';

export interface SocialScore {
  caMentionCount: number;
  uniqueAuthors: number;
  qualityRatio: number; // fraction of mentions from non-bot accounts
  composite: number;    // 0-100
}

export async function scoreSocialCA(mintAddress: string): Promise<SocialScore> {
  // Search Twitter for the exact contract address
  const twitterResult = await searchCAMentions(mintAddress);

  const caMentionCount = twitterResult.count;
  const uniqueAuthors = twitterResult.uniqueAuthors;
  const qualityRatio = twitterResult.qualityRatio;

  // Compute composite score
  // CA mentions are THE most powerful signal
  let mentionScore: number;
  if (caMentionCount >= 50) mentionScore = 100;
  else if (caMentionCount >= 30) mentionScore = 80 + (caMentionCount - 30) / 20 * 20;
  else if (caMentionCount >= 15) mentionScore = 60 + (caMentionCount - 15) / 15 * 20;
  else if (caMentionCount >= 5) mentionScore = 30 + (caMentionCount - 5) / 10 * 30;
  else mentionScore = caMentionCount * 6;

  // Unique authors bonus: if many unique people are sharing, stronger signal
  let authorBonus: number;
  if (uniqueAuthors >= 20) authorBonus = 20;
  else if (uniqueAuthors >= 10) authorBonus = 10 + (uniqueAuthors - 10) / 10 * 10;
  else authorBonus = uniqueAuthors;

  // Quality penalty: if most mentions are from bot-like accounts, discount
  const qualityMultiplier = 0.5 + qualityRatio * 0.5; // Range 0.5-1.0

  const rawScore = mentionScore + authorBonus;
  const composite = Math.min(100, rawScore * qualityMultiplier);

  const result: SocialScore = {
    caMentionCount,
    uniqueAuthors,
    qualityRatio,
    composite,
  };

  logger.debug('Social CA score', { mint: mintAddress, ...result });

  return result;
}
