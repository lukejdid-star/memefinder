import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../utils/solanaRpc';
import { config } from '../config';
import { logger } from '../utils/logger';
import { rateLimiter } from '../safety/rateLimiter';
import axios from 'axios';

export interface OnchainScore {
  holderCount: number;
  top10Concentration: number; // 0-1, fraction held by top 10
  buyRatio: number;           // buys / (buys + sells) over recent period
  liquidityUsd: number;
  creatorIsSerial: boolean;   // launched >3 tokens in 24h
  volumeToMcapRatio: number;  // 24h volume / FDV ratio
  composite: number;          // 0-100
}

export async function scoreOnchain(
  mintAddress: string,
  dexLiquidity?: number,
  dexBuySellH1?: { buys: number; sells: number },
  dexVolumeH24?: number,
  dexFdv?: number,
): Promise<OnchainScore> {
  const [holderData, creatorCheck] = await Promise.all([
    getHolderDistribution(mintAddress),
    checkCreatorHistory(mintAddress),
  ]);

  const holderCount = holderData.holderCount;
  const top10Concentration = holderData.top10Concentration;
  const creatorIsSerial = creatorCheck;

  // Buy/sell ratio from DEX data if available
  let buyRatio = 0.5;
  if (dexBuySellH1 && (dexBuySellH1.buys + dexBuySellH1.sells > 0)) {
    buyRatio = dexBuySellH1.buys / (dexBuySellH1.buys + dexBuySellH1.sells);
  }

  const liquidityUsd = dexLiquidity || 0;
  const volumeToMcapRatio = (dexVolumeH24 && dexFdv && dexFdv > 0)
    ? dexVolumeH24 / dexFdv
    : 0;

  // Compute composite
  const holderScore = scoreHolderCount(holderCount);
  const distributionScore = scoreDistribution(top10Concentration);
  const buyRatioScore = scoreBuyRatio(buyRatio);
  const liquidityScore = scoreLiquidity(liquidityUsd);
  const volMcapScore = scoreVolumeToMcapRatio(dexVolumeH24 || 0, dexFdv || 0);
  const creatorPenalty = creatorIsSerial ? -20 : 0;

  const composite = Math.max(0, Math.min(100,
    holderScore * 0.25 +
    distributionScore * 0.20 +
    buyRatioScore * 0.20 +
    liquidityScore * 0.15 +
    volMcapScore * 0.20 +
    creatorPenalty
  ));

  const result: OnchainScore = {
    holderCount,
    top10Concentration,
    buyRatio,
    liquidityUsd,
    creatorIsSerial,
    volumeToMcapRatio,
    composite,
  };

  logger.debug('On-chain score', { mint: mintAddress, ...result });

  return result;
}

async function getHolderDistribution(mintAddress: string): Promise<{
  holderCount: number;
  top10Concentration: number;
}> {
  try {
    await rateLimiter.waitForSlot('helius');
    const conn = getConnection();

    const largestAccounts = await conn.getTokenLargestAccounts(new PublicKey(mintAddress));
    rateLimiter.reportSuccess('helius');

    const accounts = largestAccounts.value || [];

    if (accounts.length === 0) {
      return { holderCount: 0, top10Concentration: 1 };
    }

    // Total supply from largest accounts (approximation)
    let totalFromLargest = 0;
    let top10Total = 0;

    for (let i = 0; i < accounts.length; i++) {
      const amount = Number(accounts[i].amount);
      totalFromLargest += amount;
      if (i < 10) {
        top10Total += amount;
      }
    }

    // Get a more accurate holder count via Helius if available
    let holderCount = accounts.length;

    if (config.HELIUS_API_KEY) {
      try {
        await rateLimiter.waitForSlot('helius');
        const response = await axios.post(
          `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'getTokenAccounts',
            params: { mint: mintAddress, limit: 1, page: 1 },
          },
          { timeout: 10_000 },
        );
        rateLimiter.reportSuccess('helius');

        holderCount = response.data?.result?.total || accounts.length;
      } catch {
        // Fallback to largest accounts count
      }
    }

    const top10Concentration = totalFromLargest > 0 ? top10Total / totalFromLargest : 1;

    return { holderCount, top10Concentration };
  } catch (error: any) {
    rateLimiter.reportFailure('helius');
    logger.error('Holder distribution fetch failed', { mint: mintAddress, error: error.message });
    return { holderCount: 0, top10Concentration: 1 };
  }
}

async function checkCreatorHistory(mintAddress: string): Promise<boolean> {
  // Check if the creator has launched many tokens recently (sign of a serial scammer)
  if (!config.HELIUS_API_KEY) return false;

  try {
    await rateLimiter.waitForSlot('helius');

    // First get the token's creator by looking at the first transaction
    const response = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [mintAddress, { limit: 1 }],
      },
      { timeout: 10_000 },
    );
    rateLimiter.reportSuccess('helius');

    // This is a simplified check. A full implementation would:
    // 1. Get the creator from the token metadata
    // 2. Check all tokens created by that address in the last 24h
    // 3. Flag if > 3 tokens created
    // For now, we return false (assume not serial) and let the rug detector handle deeper checks
    return false;
  } catch (error: any) {
    rateLimiter.reportFailure('helius');
    return false;
  }
}

function scoreHolderCount(count: number): number {
  if (count >= 500) return 100;
  if (count >= 200) return 75 + (count - 200) / 300 * 25;
  if (count >= 50) return 40 + (count - 50) / 150 * 35;
  if (count >= 10) return 10 + (count - 10) / 40 * 30;
  return count;
}

function scoreDistribution(top10Concentration: number): number {
  // Lower concentration = better distribution = higher score
  if (top10Concentration <= 0.3) return 100;
  if (top10Concentration <= 0.5) return 70 + (0.5 - top10Concentration) / 0.2 * 30;
  if (top10Concentration <= 0.7) return 40 + (0.7 - top10Concentration) / 0.2 * 30;
  if (top10Concentration <= 0.9) return 10 + (0.9 - top10Concentration) / 0.2 * 30;
  return 0;
}

function scoreBuyRatio(ratio: number): number {
  // Higher buy ratio = more bullish
  if (ratio >= 0.8) return 100;
  if (ratio >= 0.6) return 60 + (ratio - 0.6) / 0.2 * 40;
  if (ratio >= 0.5) return 40 + (ratio - 0.5) / 0.1 * 20;
  // Below 50% buys is bearish
  return Math.max(0, ratio * 80);
}

function scoreLiquidity(usd: number): number {
  if (usd >= 100000) return 100;
  if (usd >= 50000) return 75 + (usd - 50000) / 50000 * 25;
  if (usd >= 10000) return 40 + (usd - 10000) / 40000 * 35;
  if (usd >= 1000) return 10 + (usd - 1000) / 9000 * 30;
  return Math.min(10, usd / 100);
}

function scoreVolumeToMcapRatio(volumeH24: number, marketCap: number): number {
  if (marketCap <= 0 || volumeH24 <= 0) return 10;
  const ratio = volumeH24 / marketCap;
  if (ratio >= 2) return 100;
  if (ratio >= 1) return 80;
  if (ratio >= 0.5) return 60;
  if (ratio >= 0.1) return 30;
  return 10;
}
