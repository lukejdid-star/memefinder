/**
 * Forward Tracker
 *
 * - logScoredTokens(): appends scored tokens as JSONL for later analysis
 * - startOutcomeChecker(): periodically checks prices at 1h/6h/24h after scoring
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TTLCache } from '../utils/cache';
import { TokenScore } from '../scoring/tokenScorer';
import { CandidateToken } from '../tokens/tokenMatcher';
import { getTokenByAddress } from '../tokens/dexscreenerScanner';
import { BacktestRecord } from './types';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const JSONL_PATH = path.join(DATA_DIR, 'forward-tracker.jsonl');

// Dedup cache: don't log the same mint within 1 hour
const recentlyLogged = new TTLCache<boolean>(60 * 60 * 1000);

const ONE_HOUR = 60 * 60 * 1000;
const SIX_HOURS = 6 * ONE_HOUR;
const TWENTY_FOUR_HOURS = 24 * ONE_HOUR;
const FORTY_EIGHT_HOURS = 48 * ONE_HOUR;
const MAX_TOKENS_PER_POLL = 20;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Log scored tokens to JSONL. Called after scoreAll() in the main loop.
 * Lightweight — no API calls, just file append.
 * Pass candidates to capture dexData (FDV, price changes) at score time.
 */
export function logScoredTokens(scored: TokenScore[], candidates?: CandidateToken[]): void {
  if (!config.ENABLE_FORWARD_TRACKER) return;
  if (scored.length === 0) return;

  ensureDataDir();

  // Build a lookup from mint -> candidate dexData for fast access
  const candidateMap = new Map<string, CandidateToken>();
  if (candidates) {
    for (const c of candidates) {
      candidateMap.set(c.mintAddress, c);
    }
  }

  const now = Date.now();
  let logged = 0;

  for (const token of scored) {
    if (recentlyLogged.has(token.mintAddress)) continue;
    recentlyLogged.set(token.mintAddress, true);

    const candidate = candidateMap.get(token.mintAddress);
    const dex = candidate?.dexData;

    const record: BacktestRecord = {
      mintAddress: token.mintAddress,
      symbol: token.symbol,
      name: token.name,
      alertSource: token.alertSource,
      trendKeyword: token.trendKeyword,
      scoredAt: now,
      tokenCreatedAt: candidate?.pumpfunData?.createdAt?.getTime(),
      socialCAMentions: token.socialCAMentions,
      pumpfunEngagement: token.pumpfunEngagement,
      onchainHealth: token.onchainHealth,
      trendAlignment: token.trendAlignment,
      safetyScore: token.safetyScore,
      smartMoneyScore: token.smartMoneyScore,
      compositeScore: token.compositeScore,
      buyerCount: token.details.caMentionCount,
      holderCount: token.details.holderCount,
      top10Concentration: token.details.top10Concentration,
      buyRatio: token.details.buyRatio,
      volumeToMcapRatio: token.details.volumeToMcapRatio,
      bondingCurveProgress: token.details.bondingCurveProgress,
      replyCount: token.details.replyCount ?? 0,
      liquidityUsd: token.details.liquidityUsd,
      ageHours: token.details.ageHours,
      priceAtScore: {
        priceChangeH1: dex?.priceChangeH1 || 0,
        priceChangeH24: dex?.priceChangeH24 || 0,
        fdv: dex?.fdv || 0,
        liquidityUsd: dex?.liquidityUsd || token.details.liquidityUsd,
        volumeH24: dex?.volumeH24 || 0,
      },
    };

    fs.appendFileSync(JSONL_PATH, JSON.stringify(record) + '\n');
    logged++;
  }

  if (logged > 0) {
    logger.debug(`Forward tracker: logged ${logged} token(s)`);
  }
}

function readAllRecords(): BacktestRecord[] {
  if (!fs.existsSync(JSONL_PATH)) return [];

  const lines = fs.readFileSync(JSONL_PATH, 'utf-8')
    .split('\n')
    .filter(line => line.trim());

  const records: BacktestRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

function writeAllRecords(records: BacktestRecord[]): void {
  ensureDataDir();
  const content = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(JSONL_PATH, content);
}

function needsCheck(record: BacktestRecord, now: number): '1h' | '6h' | '24h' | null {
  const age = now - record.scoredAt;

  // Stop checking after 48 hours
  if (age > FORTY_EIGHT_HOURS) return null;

  const outcomes = record.outcomes || {};

  // Check in order: 1h first, then 6h, then 24h
  if (age >= ONE_HOUR && outcomes.checkedAt1h == null) return '1h';
  if (age >= SIX_HOURS && outcomes.checkedAt6h == null) return '6h';
  if (age >= TWENTY_FOUR_HOURS && outcomes.checkedAt24h == null) return '24h';

  return null;
}

async function checkOutcomes(): Promise<void> {
  const records = readAllRecords();
  if (records.length === 0) return;

  const now = Date.now();
  let checked = 0;
  let updated = false;

  for (const record of records) {
    if (checked >= MAX_TOKENS_PER_POLL) break;

    const checkType = needsCheck(record, now);
    if (!checkType) continue;

    try {
      const dexData = await getTokenByAddress(record.mintAddress);
      if (!dexData) continue;

      const currentFdv = dexData.fdv || 0;
      const scoreFdv = record.priceAtScore.fdv || 0;
      const fdvDelta = scoreFdv > 0
        ? ((currentFdv - scoreFdv) / scoreFdv) * 100
        : 0;

      if (!record.outcomes) {
        record.outcomes = {};
      }

      if (checkType === '1h') {
        record.outcomes.checkedAt1h = now;
        record.outcomes.fdvAt1h = currentFdv;
        record.outcomes.priceChangeH1 = fdvDelta;
      } else if (checkType === '6h') {
        record.outcomes.checkedAt6h = now;
        record.outcomes.fdvAt6h = currentFdv;
        record.outcomes.priceChangeH6 = fdvDelta;
      } else if (checkType === '24h') {
        record.outcomes.checkedAt24h = now;
        record.outcomes.fdvAt24h = currentFdv;
        record.outcomes.priceChangeH24 = fdvDelta;
      }

      checked++;
      updated = true;
    } catch (error: any) {
      logger.debug(`Forward tracker: failed to check ${record.symbol}: ${error.message}`);
    }
  }

  if (updated) {
    writeAllRecords(records);
    logger.info(`Forward tracker: checked outcomes for ${checked} token(s)`);
  }
}

/**
 * Start the outcome checker that polls periodically.
 * Returns a stop function.
 */
export function startOutcomeChecker(): () => void {
  if (!config.ENABLE_FORWARD_TRACKER) {
    return () => {};
  }

  logger.info('Forward tracker outcome checker started', {
    intervalMs: config.FORWARD_TRACKER_CHECK_INTERVAL_MS,
  });

  const interval = setInterval(async () => {
    try {
      await checkOutcomes();
    } catch (error: any) {
      logger.error('Forward tracker outcome check error', { error: error.message });
    }
  }, config.FORWARD_TRACKER_CHECK_INTERVAL_MS);

  return () => {
    clearInterval(interval);
    logger.info('Forward tracker outcome checker stopped');
  };
}
