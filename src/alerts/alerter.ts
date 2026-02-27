import { TokenScore } from '../scoring/tokenScorer';
import { logger } from '../utils/logger';
import { sendTokenAlert as sendDiscordAlert } from '../discord/bot';

interface AlertedToken {
  mintAddress: string;
  timestamp: number;
}

// Track already-alerted tokens to avoid spamming (keyed by mint, 1hr cooldown)
const alertedTokens = new Map<string, number>();
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

function wasRecentlyAlerted(mintAddress: string): boolean {
  const lastAlert = alertedTokens.get(mintAddress);
  if (!lastAlert) return false;
  return Date.now() - lastAlert < ALERT_COOLDOWN_MS;
}

function markAlerted(mintAddress: string): void {
  alertedTokens.set(mintAddress, Date.now());

  // Prune old entries
  for (const [mint, ts] of alertedTokens) {
    if (Date.now() - ts > ALERT_COOLDOWN_MS * 2) {
      alertedTokens.delete(mint);
    }
  }
}

export function sendAlert(token: TokenScore, safe: boolean): void {
  if (wasRecentlyAlerted(token.mintAddress)) {
    logger.debug(`Already alerted ${token.symbol}, skipping`);
    return;
  }

  markAlerted(token.mintAddress);

  const safetyTag = safe ? 'PASSED' : 'WARNING';
  const pumpfunUrl = `https://pump.fun/coin/${token.mintAddress}`;
  const dexscreenerUrl = `https://dexscreener.com/solana/${token.mintAddress}`;

  const sourceLabels: Record<string, string> = {
    trend: 'Trend Scanner',
    launch_monitor: 'Launch Monitor',
    smart_money: 'Smart Money',
    dex_trending: 'DexScreener Trending',
    jupiter_trending: 'Jupiter Trending',
    telegram: 'Telegram Monitor',
    graduation: 'Graduation Detected',
  };
  const sourceLabel = sourceLabels[token.alertSource] || 'Unknown';

  const alertLines = [
    '',
    '============================================',
    `  MEME TOKEN ALERT  —  $${token.symbol}`,
    '============================================',
    `  Name:      ${token.name}`,
    `  Symbol:    $${token.symbol}`,
    `  Source:    ${sourceLabel}`,
    `  Trend:     "${token.trendKeyword || 'N/A'}"`,
    '',
    `  CA: ${token.mintAddress}`,
    '',
    `  Score:     ${token.compositeScore.toFixed(1)} / 100`,
    `  Safety:    ${safetyTag}`,
    '',
    '  --- Score Breakdown ---',
    `  Buyers (1h):         ${token.socialCAMentions.toFixed(1)}`,
    `  Pump.fun Engagement: ${token.pumpfunEngagement.toFixed(1)}`,
    `  On-chain Health:     ${token.onchainHealth.toFixed(1)}`,
    `  Trend Alignment:     ${token.trendAlignment.toFixed(1)}`,
    `  Safety Score:        ${token.safetyScore.toFixed(1)}`,
    `  Smart Money:         ${token.smartMoneyScore.toFixed(1)}`,
    '',
    '  --- Details ---',
    `  Buyers (1h):     ${token.details.caMentionCount}`,
    `  Holders:         ${token.details.holderCount}`,
    `  Top 10 Conc:     ${(token.details.top10Concentration * 100).toFixed(1)}%`,
    `  Buy Ratio:       ${(token.details.buyRatio * 100).toFixed(1)}%`,
    `  Bonding Curve:   ${(token.details.bondingCurveProgress * 100).toFixed(1)}%`,
    `  Replies:         ${token.details.replyCount}`,
    `  Liquidity:       $${token.details.liquidityUsd.toLocaleString()}`,
    token.details.smartMoneyWallets?.length
      ? `  SM Wallets:    ${token.details.smartMoneyWallets.map(w => w.slice(0, 8) + '...').join(', ')}`
      : '',
    '',
    `  Pump.fun:      ${pumpfunUrl}`,
    `  DexScreener:   ${dexscreenerUrl}`,
    '============================================',
    '',
  ].filter(Boolean);

  // Print to console with color
  const alertText = alertLines.join('\n');
  console.log('\x1b[36m%s\x1b[0m', alertText); // Cyan

  // Also log structured data
  logger.info('TOKEN ALERT', {
    symbol: token.symbol,
    name: token.name,
    mintAddress: token.mintAddress,
    source: token.alertSource,
    trend: token.trendKeyword,
    compositeScore: token.compositeScore,
    safe,
    scores: {
      social: token.socialCAMentions,
      pumpfun: token.pumpfunEngagement,
      onchain: token.onchainHealth,
      trend: token.trendAlignment,
      safety: token.safetyScore,
      smartMoney: token.smartMoneyScore,
    },
    links: { pumpfun: pumpfunUrl, dexscreener: dexscreenerUrl },
  });

  // Send Discord embed (fire-and-forget, errors logged inside)
  sendDiscordAlert(token, safe);
}

export function getAlertedCount(): number {
  return alertedTokens.size;
}
