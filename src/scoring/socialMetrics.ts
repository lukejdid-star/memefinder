import { DexToken } from '../tokens/dexscreenerScanner';
import { getCAMentionCount } from '../utils/telegramCounts';
import { logger } from '../utils/logger';

export interface SocialScore {
  buyerCount: number;        // 1h buyer count from DexScreener
  telegramMentions: number;  // CA mentions from Telegram
  ratioBonus: number;        // buy/sell ratio bonus
  composite: number;         // 0-100
}

export async function scoreSocialCA(mintAddress: string, dexData?: DexToken): Promise<SocialScore> {
  // --- Buyer velocity from DexScreener txCountH1 ---
  const buys = dexData?.txCountH1?.buys || 0;
  const sells = dexData?.txCountH1?.sells || 0;

  // Scale buyer count: 0-100
  // 0 buys = 0, 50 buys = 50, 100+ buys = 100
  let buyerScore: number;
  if (buys >= 100) buyerScore = 100;
  else if (buys >= 50) buyerScore = 50 + (buys - 50) / 50 * 50;
  else buyerScore = buys;

  // --- Buy/sell ratio bonus (up to +20) ---
  let ratioBonus = 0;
  const totalTxns = buys + sells;
  if (totalTxns > 0) {
    const buyRatio = buys / totalTxns;
    // >70% buys = full bonus, 50% = no bonus, <50% = 0
    if (buyRatio > 0.5) {
      ratioBonus = Math.min(20, (buyRatio - 0.5) * 100);
    }
  }

  // --- Telegram CA mention bonus (up to +20) ---
  const telegramMentions = getCAMentionCount(mintAddress);
  const telegramBonus = Math.min(20, telegramMentions * 4); // 5 mentions = max bonus

  const composite = Math.min(100, buyerScore + ratioBonus + telegramBonus);

  const result: SocialScore = {
    buyerCount: buys,
    telegramMentions,
    ratioBonus: Math.round(ratioBonus),
    composite,
  };

  logger.debug('Social score (buyers)', {
    mint: mintAddress,
    buys,
    sells,
    buyerScore: buyerScore.toFixed(1),
    ratioBonus: ratioBonus.toFixed(1),
    telegramMentions,
    telegramBonus: telegramBonus.toFixed(1),
    composite: composite.toFixed(1),
  });

  return result;
}
