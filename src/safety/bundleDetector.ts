import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { rateLimiter } from './rateLimiter';

export interface BundleCheckResult {
  isBundled: boolean;
  bundledSlots: number;
  totalBundledSigners: number;
  reasons: string[];
}

export async function checkBundleBuys(mintAddress: string): Promise<BundleCheckResult> {
  if (!config.HELIUS_API_KEY) {
    return { isBundled: false, bundledSlots: 0, totalBundledSigners: 0, reasons: [] };
  }

  try {
    await rateLimiter.waitForSlot('helius');

    // Fetch the first 30 transactions for this token
    const response = await axios.get(
      `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions`,
      {
        params: {
          'api-key': config.HELIUS_API_KEY,
          limit: 30,
        },
        timeout: 15_000,
      },
    );

    rateLimiter.reportSuccess('helius');

    const txs: any[] = response.data || [];
    if (txs.length === 0) {
      return { isBundled: false, bundledSlots: 0, totalBundledSigners: 0, reasons: [] };
    }

    // Group transactions by slot (same block)
    const slotGroups = new Map<number, Set<string>>();

    for (const tx of txs) {
      const slot = tx.slot;
      const signer = tx.feePayer;
      if (!slot || !signer) continue;

      // Only look at buy-like transactions (SWAP or TRANSFER type)
      const isBuyLike = tx.type === 'SWAP' || tx.type === 'TRANSFER' ||
        tx.description?.toLowerCase().includes('swap') ||
        tx.description?.toLowerCase().includes('buy');

      if (!isBuyLike) continue;

      if (!slotGroups.has(slot)) {
        slotGroups.set(slot, new Set());
      }
      slotGroups.get(slot)!.add(signer);
    }

    // Flag if 3+ unique signers buy in same slot, across 2+ slot groups
    let bundledSlotCount = 0;
    let totalBundledSigners = 0;

    for (const [, signers] of slotGroups) {
      if (signers.size >= 3) {
        bundledSlotCount++;
        totalBundledSigners += signers.size;
      }
    }

    const isBundled = bundledSlotCount >= 2;
    const reasons: string[] = [];

    if (isBundled) {
      reasons.push(
        `Bundle detected: ${bundledSlotCount} slots with 3+ coordinated buyers (${totalBundledSigners} total signers)`,
      );
    }

    if (isBundled) {
      logger.warn('Bundle buy detection FLAGGED', { mint: mintAddress, bundledSlotCount, totalBundledSigners });
    }

    return { isBundled, bundledSlots: bundledSlotCount, totalBundledSigners, reasons };
  } catch (error: any) {
    rateLimiter.reportFailure('helius');
    if (!error.message?.includes('quota exhausted')) {
      logger.error('Bundle buy check failed', { mint: mintAddress, error: error.message });
    }
    // Graceful fallback — don't block on failure
    return { isBundled: false, bundledSlots: 0, totalBundledSigners: 0, reasons: [] };
  }
}
