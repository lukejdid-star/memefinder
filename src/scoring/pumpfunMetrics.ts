import { PumpfunToken, getTokenDetails } from '../tokens/pumpfunScanner';
import { logger } from '../utils/logger';

export interface PumpfunEngagementScore {
  replyScore: number;           // 0-100 based on thread replies
  bondingCurveScore: number;    // 0-100, peaks at 20-70% progress
  activityScore: number;        // 0-100 based on overall activity signals
  graduationSpeedScore: number; // 0-100 based on projected graduation time
  composite: number;            // 0-100 weighted average
}

export async function scorePumpfunEngagement(
  mintAddress: string,
  existingData?: PumpfunToken,
): Promise<PumpfunEngagementScore> {
  let token = existingData;

  if (!token) {
    token = await getTokenDetails(mintAddress) || undefined;
  }

  if (!token) {
    return { replyScore: 0, bondingCurveScore: 0, activityScore: 0, graduationSpeedScore: 0, composite: 0 };
  }

  // Reply score: more replies = more engagement
  // Scale: 0 replies = 0, 10 = 30, 50 = 60, 100+ = 80, 500+ = 100
  const replyScore = scoreReplyCount(token.replyCount);

  // Bonding curve score: peak at 20-70%
  const bondingCurveScore = scoreBondingCurve(token.bondingCurveProgress);

  // Activity score based on market cap (proxy for buy activity)
  const activityScore = scoreActivity(token.marketCapSol);

  // Graduation speed score: projects time to 100% based on current velocity
  const graduationSpeedScore = scoreGraduationSpeed(token.createdAt, token.bondingCurveProgress);

  // Composite: replies + graduation speed are key engagement signals
  const composite = replyScore * 0.35 + bondingCurveScore * 0.25 + activityScore * 0.15 + graduationSpeedScore * 0.25;

  const result = { replyScore, bondingCurveScore, activityScore, graduationSpeedScore, composite };

  logger.debug('Pump.fun engagement score', {
    mint: mintAddress,
    symbol: token.symbol,
    ...result,
    replyCount: token.replyCount,
    bondingCurve: token.bondingCurveProgress,
    marketCapSol: token.marketCapSol,
  });

  return result;
}

function scoreReplyCount(count: number): number {
  if (count >= 500) return 100;
  if (count >= 100) return 80 + (count - 100) / 400 * 20;
  if (count >= 50) return 60 + (count - 50) / 50 * 20;
  if (count >= 10) return 30 + (count - 10) / 40 * 30;
  return count * 3;
}

function scoreBondingCurve(progress: number): number {
  // Sweet spot is 20-70%
  if (progress >= 20 && progress <= 70) {
    // Peak score at ~45%
    const distFromCenter = Math.abs(progress - 45);
    return 100 - distFromCenter;
  }
  if (progress < 20) {
    // Too early — might not have enough traction
    return progress * 3;
  }
  // > 70%: about to graduate to PumpSwap, dynamics change
  return Math.max(0, 100 - (progress - 70) * 3);
}

function scoreActivity(marketCapSol: number): number {
  // Higher market cap on pump.fun = more buying activity
  if (marketCapSol >= 50) return 100;
  if (marketCapSol >= 20) return 70 + (marketCapSol - 20) / 30 * 30;
  if (marketCapSol >= 5) return 40 + (marketCapSol - 5) / 15 * 30;
  if (marketCapSol >= 1) return 10 + (marketCapSol - 1) / 4 * 30;
  return marketCapSol * 10;
}

function scoreGraduationSpeed(createdAt: Date, bondingCurveProgress: number): number {
  // Project graduation time from current progress rate
  if (bondingCurveProgress <= 0) return 10;

  const ageMinutes = (Date.now() - createdAt.getTime()) / (1000 * 60);
  if (ageMinutes <= 0) return 50;

  // Rate: percent per minute
  const ratePerMinute = bondingCurveProgress / ageMinutes;
  if (ratePerMinute <= 0) return 10;

  // Project time to reach 100%
  const remainingProgress = 100 - bondingCurveProgress;
  const projectedMinutesTotal = ageMinutes + (remainingProgress / ratePerMinute);

  // Sweet spot: 5-30 minutes to graduate
  if (projectedMinutesTotal < 5) return 60;   // Too fast — possibly manipulated
  if (projectedMinutesTotal <= 30) return 100; // Sweet spot
  if (projectedMinutesTotal <= 120) return 70; // Decent pace
  return 30;                                   // Slow — may not graduate
}
