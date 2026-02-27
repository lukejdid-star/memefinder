import { CandidateToken } from '../tokens/tokenMatcher';
import { scorePumpfunEngagement } from './pumpfunMetrics';
import { scoreSocialCA } from './socialMetrics';
import { scoreOnchain } from './onchainMetrics';
import { isSafe } from '../safety/rugDetector';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface TokenScore {
  mintAddress: string;
  name: string;
  symbol: string;
  trendKeyword: string;

  // Individual scores (0-100 each)
  socialCAMentions: number;
  pumpfunEngagement: number;
  onchainHealth: number;
  trendAlignment: number;
  safetyScore: number;
  smartMoneyScore: number;

  compositeScore: number;

  // Raw data for logging
  details: {
    caMentionCount: number;
    holderCount: number;
    top10Concentration: number;
    buyRatio: number;
    volumeToMcapRatio: number;
    bondingCurveProgress: number;
    replyCount: number;
    liquidityUsd: number;
    ageHours: number;
    timeMultiplier: number;
  };
}

export async function scoreAll(
  candidates: CandidateToken[],
): Promise<TokenScore[]> {
  if (candidates.length === 0) return [];

  logger.info(`Scoring ${candidates.length} candidates for trend "${candidates[0].trendKeyword}"`);

  const scored: TokenScore[] = [];

  // Score in batches to avoid overwhelming APIs
  const BATCH_SIZE = 5;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(candidate => scoreCandidate(candidate)),
    );
    scored.push(...batchResults.filter((s): s is TokenScore => s !== null));
  }

  // Sort by composite score descending
  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  if (scored.length > 0) {
    logger.info(`Top scored tokens for "${scored[0].trendKeyword}":`, {
      results: scored.slice(0, 5).map(s => ({
        symbol: s.symbol,
        mint: s.mintAddress.slice(0, 8) + '...',
        composite: s.compositeScore.toFixed(1),
        social: s.socialCAMentions.toFixed(1),
        pumpfun: s.pumpfunEngagement.toFixed(1),
        onchain: s.onchainHealth.toFixed(1),
        trend: s.trendAlignment.toFixed(1),
        safety: s.safetyScore.toFixed(1),
        smartMoney: s.smartMoneyScore.toFixed(1),
      })),
    });
  }

  return scored;
}

// --- Smart Money Signal Cache ---
const smartMoneySignalCache = new Map<string, number>();

export function registerSmartMoneySignal(mintAddress: string): void {
  const current = smartMoneySignalCache.get(mintAddress) || 0;
  smartMoneySignalCache.set(mintAddress, current + 1);
}

function scoreSmartMoney(mintAddress: string): number {
  const count = smartMoneySignalCache.get(mintAddress) || 0;
  if (count >= 3) return 100;
  if (count === 2) return 80;
  if (count === 1) return 60;
  return 0;
}

function getTimeDecayMultiplier(createdAt?: Date): number {
  if (!createdAt) return 1.0;
  const ageHours = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
  if (ageHours <= 1) return 1.2;
  if (ageHours <= 6) return 1.0;
  if (ageHours <= 24) return 0.7;
  return 0.4;
}

async function scoreCandidate(candidate: CandidateToken): Promise<TokenScore | null> {
  try {
    // Run all scoring in parallel
    const [socialResult, pumpfunResult, onchainResult, safetyResult] = await Promise.all([
      scoreSocialCA(candidate.mintAddress),
      scorePumpfunEngagement(candidate.mintAddress, candidate.pumpfunData),
      scoreOnchain(
        candidate.mintAddress,
        candidate.dexData?.liquidityUsd,
        candidate.dexData?.txCountH1,
        candidate.dexData?.volumeH24,
        candidate.dexData?.fdv,
      ),
      isSafe(candidate.mintAddress).catch(() => false),
    ]);

    const socialCAMentions = socialResult.composite;
    const pumpfunEngagement = pumpfunResult.composite;
    const onchainHealth = onchainResult.composite;
    // For proactive-flow tokens with no trend match, use neutral 50
    const trendAlignment = candidate.trendKeyword ? candidate.matchScore * 100 : 50;
    const safetyScore = safetyResult ? 100 : 0;
    const smartMoney = scoreSmartMoney(candidate.mintAddress);

    // Time decay based on token creation time
    const createdAt = candidate.pumpfunData?.createdAt || candidate.dexData?.pairCreatedAt;
    const timeMultiplier = getTimeDecayMultiplier(createdAt);
    const ageHours = createdAt ? (Date.now() - createdAt.getTime()) / (1000 * 60 * 60) : 0;

    // Weighted composite with time decay multiplier
    const rawComposite =
      socialCAMentions * config.SCORE_WEIGHT_SOCIAL_CA +
      pumpfunEngagement * config.SCORE_WEIGHT_PUMPFUN_ENGAGEMENT +
      onchainHealth * config.SCORE_WEIGHT_ONCHAIN_HEALTH +
      trendAlignment * config.SCORE_WEIGHT_TREND_ALIGNMENT +
      safetyScore * config.SCORE_WEIGHT_SAFETY +
      smartMoney * config.SCORE_WEIGHT_SMART_MONEY;

    const compositeScore = Math.min(100, rawComposite * timeMultiplier);

    return {
      mintAddress: candidate.mintAddress,
      name: candidate.name,
      symbol: candidate.symbol,
      trendKeyword: candidate.trendKeyword,
      socialCAMentions,
      pumpfunEngagement,
      onchainHealth,
      trendAlignment,
      safetyScore,
      smartMoneyScore: smartMoney,
      compositeScore,
      details: {
        caMentionCount: socialResult.caMentionCount,
        holderCount: onchainResult.holderCount,
        top10Concentration: onchainResult.top10Concentration,
        buyRatio: onchainResult.buyRatio,
        volumeToMcapRatio: onchainResult.volumeToMcapRatio,
        bondingCurveProgress: candidate.pumpfunData?.bondingCurveProgress || 0,
        replyCount: candidate.pumpfunData?.replyCount || 0,
        liquidityUsd: onchainResult.liquidityUsd,
        ageHours: Math.round(ageHours * 10) / 10,
        timeMultiplier,
      },
    };
  } catch (error: any) {
    logger.error(`Scoring failed for ${candidate.symbol} (${candidate.mintAddress})`, {
      error: error.message,
    });
    return null;
  }
}
