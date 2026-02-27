import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { rateLimiter } from '../safety/rateLimiter';
import { TTLCache } from '../utils/cache';
import { CandidateToken } from '../tokens/tokenMatcher';
import { PumpfunToken, parseBondingProgress } from '../tokens/pumpfunScanner';
import { getTokenByAddress } from '../tokens/dexscreenerScanner';
import { scoreAll } from '../scoring/tokenScorer';
import { isSafe } from '../safety/rugDetector';
import { sendAlert } from '../alerts/alerter';

const PUMPFUN_LATEST_URL = 'https://frontend-api.pump.fun/coins';

// Tokens seen in the last 30 minutes won't be reprocessed
const seenTokens = new TTLCache<boolean>(30 * 60 * 1000);
const seenGraduated = new TTLCache<boolean>(60 * 60 * 1000);

let running = false;

export async function startLaunchMonitor(): Promise<() => void> {
  running = true;
  logger.info('Launch monitor started', { pollMs: config.LAUNCH_MONITOR_POLL_MS });

  const loop = async () => {
    while (running) {
      try {
        await pollLatestLaunches();
      } catch (error: any) {
        logger.error('Launch monitor cycle error', { error: error.message, stack: error.stack });
      }

      // Graduation detection
      if (config.ENABLE_GRADUATION_DETECTION) {
        try {
          await pollGraduatedTokens();
        } catch (error: any) {
          logger.error('Graduation detection cycle error', { error: error.message, stack: error.stack });
        }
      }

      await sleep(config.LAUNCH_MONITOR_POLL_MS);
    }
    logger.info('Launch monitor stopped');
  };

  loop();

  return () => { running = false; };
}

async function pollLatestLaunches(): Promise<void> {
  await rateLimiter.waitForSlot('pumpfunlaunch');

  let response;
  try {
    response = await axios.get(PUMPFUN_LATEST_URL, {
      params: {
        offset: 0,
        limit: 50,
        sort: 'created_timestamp',
        order: 'DESC',
        includeNsfw: false,
      },
      timeout: 10_000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
      },
    });
    rateLimiter.reportSuccess('pumpfunlaunch');
  } catch (error: any) {
    rateLimiter.reportFailure('pumpfunlaunch', error?.response?.status);
    throw error;
  }

  const coins: any[] = Array.isArray(response.data)
    ? response.data
    : response.data?.coins || [];

  // Filter to only unseen tokens
  const newCoins = coins.filter((coin: any) => {
    const mint = coin.mint || coin.address || '';
    if (!mint || seenTokens.has(mint)) return false;
    seenTokens.set(mint, true);
    return true;
  });

  if (newCoins.length === 0) return;

  logger.info(`Launch monitor: ${newCoins.length} new token(s) detected`);

  // Build CandidateToken objects
  const candidates: CandidateToken[] = [];

  for (const coin of newCoins) {
    const mint = coin.mint || coin.address || '';

    const pumpfunData: PumpfunToken = {
      mintAddress: mint,
      name: coin.name || '',
      symbol: coin.symbol || '',
      description: coin.description || '',
      imageUri: coin.image_uri || '',
      creatorAddress: coin.creator || '',
      createdAt: new Date(coin.created_timestamp || Date.now()),
      bondingCurveProgress: parseBondingProgress(coin),
      replyCount: coin.reply_count || 0,
      marketCapSol: coin.market_cap_sol || 0,
      source: 'pumpfun',
    };

    // Try to enrich with DexScreener data (very new tokens may not be listed yet)
    let dexData;
    try {
      dexData = await getTokenByAddress(mint) || undefined;
    } catch {
      // DexScreener may not have this token yet — that's fine
    }

    candidates.push({
      mintAddress: mint,
      name: pumpfunData.name,
      symbol: pumpfunData.symbol,
      description: pumpfunData.description,
      trendKeyword: '',
      matchScore: 0,
      pumpfunData,
      dexData,
      alertSource: 'launch_monitor',
    });
  }

  // Run through scoring pipeline
  const scored = await scoreAll(candidates);

  for (const token of scored) {
    if (token.compositeScore < config.MIN_SCORE_THRESHOLD) break; // sorted descending
    const safe = await isSafe(token.mintAddress);
    sendAlert(token, safe);
  }
}

async function pollGraduatedTokens(): Promise<void> {
  await rateLimiter.waitForSlot('pumpfunlaunch');

  let response;
  try {
    response = await axios.get(PUMPFUN_LATEST_URL, {
      params: {
        offset: 0,
        limit: 50,
        sort: 'market_cap',
        order: 'DESC',
        includeNsfw: false,
      },
      timeout: 10_000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'application/json',
      },
    });
    rateLimiter.reportSuccess('pumpfunlaunch');
  } catch (error: any) {
    rateLimiter.reportFailure('pumpfunlaunch', error?.response?.status);
    throw error;
  }

  const coins: any[] = Array.isArray(response.data)
    ? response.data
    : response.data?.coins || [];

  // Filter for graduated tokens (complete === true) that we haven't seen
  const graduated = coins.filter((coin: any) => {
    if (!coin.complete) return false;
    const mint = coin.mint || coin.address || '';
    if (!mint || seenGraduated.has(mint)) return false;
    seenGraduated.set(mint, true);
    return true;
  });

  if (graduated.length === 0) return;

  logger.info(`Graduation detection: ${graduated.length} graduated token(s) found`);

  const candidates: CandidateToken[] = [];

  for (const coin of graduated) {
    const mint = coin.mint || coin.address || '';

    const pumpfunData: PumpfunToken = {
      mintAddress: mint,
      name: coin.name || '',
      symbol: coin.symbol || '',
      description: coin.description || '',
      imageUri: coin.image_uri || '',
      creatorAddress: coin.creator || '',
      createdAt: new Date(coin.created_timestamp || Date.now()),
      bondingCurveProgress: 1.0, // Graduated = 100% bonding curve
      replyCount: coin.reply_count || 0,
      marketCapSol: coin.market_cap_sol || 0,
      source: 'pumpfun',
    };

    let dexData;
    try {
      dexData = await getTokenByAddress(mint) || undefined;
    } catch {
      // fine
    }

    candidates.push({
      mintAddress: mint,
      name: pumpfunData.name,
      symbol: pumpfunData.symbol,
      description: pumpfunData.description,
      trendKeyword: '',
      matchScore: 0,
      pumpfunData,
      dexData,
      alertSource: 'graduation',
    });
  }

  const scored = await scoreAll(candidates);

  for (const token of scored) {
    if (token.compositeScore < config.MIN_SCORE_THRESHOLD) break;
    const safe = await isSafe(token.mintAddress);
    sendAlert(token, safe);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
