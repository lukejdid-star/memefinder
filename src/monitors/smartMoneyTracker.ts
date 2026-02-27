import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { rateLimiter } from '../safety/rateLimiter';
import { TTLCache } from '../utils/cache';
import { CandidateToken } from '../tokens/tokenMatcher';
import { getTokenDetails } from '../tokens/pumpfunScanner';
import { getTokenByAddress } from '../tokens/dexscreenerScanner';
import { scoreAll, registerSmartMoneySignal } from '../scoring/tokenScorer';
import { isSafe } from '../safety/rugDetector';
import { sendAlert } from '../alerts/alerter';
import { recordSmartMoneyWallet } from '../scoring/smartMoneySignals';

// Track the last-seen transaction signature per wallet to avoid reprocessing
const lastSeenSignature = new Map<string, string>();

// Track recently-processed wallet+mint combos (1 hour cooldown)
const processedMints = new TTLCache<boolean>(60 * 60 * 1000);

const KNOWN_STABLECOINS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

let running = false;

export async function startSmartMoneyTracker(): Promise<() => void> {
  if (config.SMART_MONEY_WALLETS.length === 0) {
    logger.warn('Smart money tracker: no wallets configured, not starting');
    return () => {};
  }

  if (!config.HELIUS_API_KEY) {
    logger.warn('Smart money tracker: HELIUS_API_KEY required, not starting');
    return () => {};
  }

  running = true;
  logger.info('Smart money tracker started', {
    wallets: config.SMART_MONEY_WALLETS.length,
    pollMs: config.SMART_MONEY_POLL_MS,
  });

  const loop = async () => {
    while (running) {
      try {
        await pollAllWallets();
      } catch (error: any) {
        logger.error('Smart money tracker cycle error', { error: error.message, stack: error.stack });
      }
      await sleep(config.SMART_MONEY_POLL_MS);
    }
    logger.info('Smart money tracker stopped');
  };

  loop();

  return () => { running = false; };
}

async function pollAllWallets(): Promise<void> {
  for (const wallet of config.SMART_MONEY_WALLETS) {
    if (!running) break;
    try {
      await pollWallet(wallet);
    } catch (error: any) {
      logger.error(`Smart money: error polling wallet ${wallet.slice(0, 8)}...`, {
        error: error.message,
      });
    }
  }
}

async function pollWallet(walletAddress: string): Promise<void> {
  await rateLimiter.waitForSlot('helius');

  let txs: any[];
  try {
    const response = await axios.get(
      `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions`,
      {
        params: {
          'api-key': config.HELIUS_API_KEY,
          limit: 20,
        },
        timeout: 15_000,
      },
    );
    rateLimiter.reportSuccess('helius');
    txs = response.data || [];
  } catch (error: any) {
    rateLimiter.reportFailure('helius', error?.response?.status);
    throw error;
  }

  if (txs.length === 0) return;

  // First poll: just record the latest signature, don't process
  if (!lastSeenSignature.has(walletAddress)) {
    lastSeenSignature.set(walletAddress, txs[0].signature);
    logger.info(`Smart money: initialized tracking for wallet ${walletAddress.slice(0, 8)}...`);
    return;
  }

  const lastSeen = lastSeenSignature.get(walletAddress);
  const newTxs: any[] = [];

  for (const tx of txs) {
    if (tx.signature === lastSeen) break;
    newTxs.push(tx);
  }

  if (newTxs.length === 0) return;

  // Update last-seen to the most recent signature
  lastSeenSignature.set(walletAddress, txs[0].signature);

  // Extract token buy transactions
  const tokenBuys = extractTokenBuys(newTxs, walletAddress);

  if (tokenBuys.length === 0) return;

  logger.info(`Smart money: wallet ${walletAddress.slice(0, 8)}... made ${tokenBuys.length} token buy(s)`, {
    mints: tokenBuys.map(m => m.slice(0, 8) + '...'),
  });

  // Process each bought token
  for (const mintAddress of tokenBuys) {
    const dedupKey = `${walletAddress}:${mintAddress}`;
    if (processedMints.has(dedupKey)) continue;
    processedMints.set(dedupKey, true);

    // Register signals
    registerSmartMoneySignal(mintAddress);
    recordSmartMoneyWallet(mintAddress, walletAddress);

    // Look up token details
    try {
      const [pumpfunData, dexData] = await Promise.all([
        getTokenDetails(mintAddress),
        getTokenByAddress(mintAddress),
      ]);

      if (!pumpfunData && !dexData) {
        logger.debug(`Smart money: could not find token details for ${mintAddress.slice(0, 8)}...`);
        continue;
      }

      const candidate: CandidateToken = {
        mintAddress,
        name: pumpfunData?.name || dexData?.name || 'Unknown',
        symbol: pumpfunData?.symbol || dexData?.symbol || '???',
        description: pumpfunData?.description || '',
        trendKeyword: '',
        matchScore: 0,
        pumpfunData: pumpfunData || undefined,
        dexData: dexData || undefined,
        alertSource: 'smart_money',
      };

      const scored = await scoreAll([candidate]);

      for (const token of scored) {
        if (token.compositeScore < config.MIN_SCORE_THRESHOLD) continue;
        const safe = await isSafe(token.mintAddress);
        sendAlert(token, safe);
      }
    } catch (error: any) {
      logger.error(`Smart money: failed to process token ${mintAddress.slice(0, 8)}...`, {
        error: error.message,
      });
    }
  }
}

function extractTokenBuys(txs: any[], walletAddress: string): string[] {
  const mints = new Set<string>();

  for (const tx of txs) {
    const txType: string = tx.type || '';
    const isBuyLike = txType === 'SWAP' || txType === 'TRANSFER' ||
      tx.description?.toLowerCase().includes('swap') ||
      tx.description?.toLowerCase().includes('buy');

    if (!isBuyLike) continue;

    // Check tokenTransfers for tokens received by the wallet
    const tokenTransfers: any[] = tx.tokenTransfers || [];
    for (const transfer of tokenTransfers) {
      if (transfer.toUserAccount === walletAddress && transfer.mint) {
        const mint: string = transfer.mint;
        if (mint === config.SOL_MINT) continue;
        if (KNOWN_STABLECOINS.has(mint)) continue;
        mints.add(mint);
      }
    }
  }

  return [...mints];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
