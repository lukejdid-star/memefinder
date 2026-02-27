import { config } from './config';
import { logger } from './utils/logger';
import { getMajorTrends, setCooldown, isInCooldown } from './trends/trendAggregator';
import * as pumpfunScanner from './tokens/pumpfunScanner';
import * as dexscreenerScanner from './tokens/dexscreenerScanner';
import { matchAndMerge, CandidateToken, AlertSource } from './tokens/tokenMatcher';
import { scoreAll } from './scoring/tokenScorer';
import { isSafe } from './safety/rugDetector';
import { sendAlert, getAlertedCount } from './alerts/alerter';
import { startBot } from './discord/bot';
import { startLaunchMonitor } from './monitors/launchMonitor';
import { startSmartMoneyTracker } from './monitors/smartMoneyTracker';
import { startTelegramMonitor } from './monitors/telegramMonitor';
import { getTokenByAddress } from './tokens/dexscreenerScanner';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCycle(): Promise<void> {
  const cycleStart = Date.now();

  // Step 1: Detect major trends
  logger.info('--- Scanning for major trends ---');
  const trends = await getMajorTrends();

  if (trends.length === 0) {
    logger.info('No major trends detected this cycle');
    return;
  }

  logger.info(`Found ${trends.length} major trend(s)`, {
    trends: trends.map(t => ({ keyword: t.keyword, directMints: t.directMints?.length || 0 })),
  });

  // Step 2: For each trend, find, score, and alert tokens
  for (const trend of trends) {
    if (isInCooldown(trend.keyword)) {
      logger.debug(`Trend "${trend.keyword}" is in cooldown, skipping`);
      continue;
    }

    logger.info(`Processing trend: "${trend.keyword}" (score: ${trend.trendScore}, sources: ${trend.sources.join(', ')})`);

    try {
      const candidates: CandidateToken[] = [];

      // --- Direct mints pipeline ---
      // For trends with directMints, build candidates directly from mint data
      if (trend.directMints && trend.directMints.length > 0) {
        logger.info(`Direct mints pipeline: ${trend.directMints.length} mint(s) for "${trend.keyword}"`);

        for (const mint of trend.directMints) {
          let dexData;
          try {
            dexData = await getTokenByAddress(mint) || undefined;
          } catch {
            // Token may not be on DexScreener yet
          }

          const alertSource: AlertSource = trend.sources.includes('jupiter')
            ? 'jupiter_trending'
            : 'dex_trending';

          candidates.push({
            mintAddress: mint,
            name: dexData?.name || mint.slice(0, 8),
            symbol: dexData?.symbol || '???',
            description: '',
            trendKeyword: trend.keyword,
            matchScore: 0.9, // High match since it's a direct mint
            dexData,
            alertSource,
          });
        }
      }

      // --- Keyword pipeline ---
      // For trends without directMints (or in addition to them), do keyword search
      if (!trend.directMints || trend.directMints.length === 0) {
        const [pumpTokens, dexTokens] = await Promise.all([
          pumpfunScanner.findTokens(trend),
          dexscreenerScanner.findTokens(trend),
        ]);

        const keywordCandidates = matchAndMerge(trend, pumpTokens, dexTokens);
        candidates.push(...keywordCandidates);
      }

      if (candidates.length === 0) {
        logger.info(`No matching tokens found for trend "${trend.keyword}"`);
        continue;
      }

      logger.info(`Found ${candidates.length} candidate tokens for "${trend.keyword}"`);

      // Step 3: Score all candidates
      const scored = await scoreAll(candidates);

      if (scored.length === 0) {
        logger.info(`No tokens passed scoring for "${trend.keyword}"`);
        continue;
      }

      // Step 4: Alert on tokens that pass the score threshold
      let alerted = false;
      for (const token of scored) {
        if (token.compositeScore < config.MIN_SCORE_THRESHOLD) break; // Sorted descending

        const safe = await isSafe(token.mintAddress);
        sendAlert(token, safe);
        alerted = true;
      }

      if (alerted) {
        setCooldown(trend.keyword);
      }
    } catch (error: any) {
      logger.error(`Error processing trend "${trend.keyword}"`, { error: error.message, stack: error.stack });
    }
  }

  const cycleMs = Date.now() - cycleStart;
  logger.info(`Cycle complete in ${(cycleMs / 1000).toFixed(1)}s`);
}

// Cleanup functions for graceful shutdown
let stopLaunchMonitor: (() => void) | null = null;
let stopSmartMoney: (() => void) | null = null;
let stopTelegram: (() => void) | null = null;

async function main(): Promise<void> {
  logger.info('===========================================');
  logger.info('  Meme Finder — Token Alert Scanner');
  logger.info('===========================================');
  logger.info('Configuration:', {
    minScore: config.MIN_SCORE_THRESHOLD,
    scanIntervalMs: config.SCAN_INTERVAL_MS,
    trendMinSources: config.TREND_MIN_SOURCES,
    trendCooldownMs: config.TREND_COOLDOWN_MS,
    launchMonitor: config.ENABLE_LAUNCH_MONITOR,
    smartMoney: config.ENABLE_SMART_MONEY,
    smartMoneyWallets: config.SMART_MONEY_WALLETS.length,
    dexscreenerTrending: config.ENABLE_DEXSCREENER_TRENDING,
    jupiterTrending: config.ENABLE_JUPITER_TRENDING,
    graduationDetection: config.ENABLE_GRADUATION_DETECTION,
    telegram: config.ENABLE_TELEGRAM,
  });

  logger.info('Scanner will alert you with token CAs when meme trends are detected.');
  logger.info('No wallet or trading functionality — alerts only.');

  // Connect Discord bot before starting scan loop
  logger.info('Connecting to Discord...');
  await startBot();

  // Start proactive monitors (if enabled)
  if (config.ENABLE_LAUNCH_MONITOR) {
    stopLaunchMonitor = await startLaunchMonitor();
  }

  if (config.ENABLE_SMART_MONEY) {
    stopSmartMoney = await startSmartMoneyTracker();
  }

  if (config.ENABLE_TELEGRAM) {
    stopTelegram = await startTelegramMonitor() as unknown as (() => void);
  }

  // Main trend-based loop
  while (true) {
    try {
      await runCycle();
    } catch (error: any) {
      logger.error('Cycle error (non-fatal)', { error: error.message, stack: error.stack });
    }

    logger.info(`Sleeping ${config.SCAN_INTERVAL_MS / 1000}s until next cycle... (${getAlertedCount()} tokens alerted this session)`);
    await sleep(config.SCAN_INTERVAL_MS);
  }
}

// Handle graceful shutdown
function shutdown(): void {
  logger.info('Shutting down gracefully...');
  if (stopLaunchMonitor) stopLaunchMonitor();
  if (stopSmartMoney) stopSmartMoney();
  if (stopTelegram) stopTelegram();
  process.exit(0);
}

process.on('SIGINT', () => {
  logger.info('Received SIGINT');
  shutdown();
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM');
  shutdown();
});

process.on('unhandledRejection', (error: any) => {
  logger.error('Unhandled rejection', { error: error?.message, stack: error?.stack });
});

main().catch(error => {
  logger.error('Fatal error', { error: error.message, stack: error.stack });
  process.exit(1);
});
