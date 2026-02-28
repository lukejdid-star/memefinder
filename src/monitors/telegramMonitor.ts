import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { config } from '../config';
import { logger } from '../utils/logger';
import { incrementCAMentionCount, incrementTickerMentionTracked } from '../utils/telegramCounts';
import { CandidateToken } from '../tokens/tokenMatcher';
import { getTokenByAddress } from '../tokens/dexscreenerScanner';
import { scoreAll } from '../scoring/tokenScorer';
import { isSafe } from '../safety/rugDetector';
import { sendAlert } from '../alerts/alerter';
import { TTLCache } from '../utils/cache';

// Solana address regex: base58, 32-44 characters
const SOLANA_ADDRESS_RE = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;

// $TICKER regex
const TICKER_RE = /\$([A-Za-z]{2,10})\b/g;

// Don't reprocess the same CA within 10 minutes
const processedCAs = new TTLCache<boolean>(10 * 60 * 1000);

// Known non-token addresses to skip
const SKIP_ADDRESSES = new Set([
  'So11111111111111111111111111111111111111112',
  '11111111111111111111111111111111',
  config.PUMPFUN_PROGRAM_ID,
  config.PUMPSWAP_PROGRAM_ID,
]);

export async function startTelegramMonitor(): Promise<() => void> {
  if (!config.TELEGRAM_API_ID || !config.TELEGRAM_API_HASH || !config.TELEGRAM_SESSION) {
    logger.error('Telegram monitor: missing TELEGRAM_API_ID, TELEGRAM_API_HASH, or TELEGRAM_SESSION');
    return () => {};
  }

  const session = new StringSession(config.TELEGRAM_SESSION);
  const client = new TelegramClient(session, config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH, {
    connectionRetries: 5,
  });

  try {
    await client.connect();
    logger.info('Telegram monitor connected');
  } catch (error: any) {
    logger.error('Telegram monitor failed to connect', { error: error.message });
    return () => {};
  }

  // Build chat filter from configured group IDs
  const groupIds = config.TELEGRAM_GROUP_IDS;
  const chatFilter = groupIds.length > 0 ? groupIds.map(id => {
    const num = parseInt(id, 10);
    return isNaN(num) ? id : num;
  }) : undefined;

  const handler = async (event: NewMessageEvent) => {
    try {
      await handleMessage(event);
    } catch (error: any) {
      logger.error('Telegram message handler error', { error: error.message });
    }
  };

  client.addEventHandler(handler, new NewMessage({ chats: chatFilter }));

  logger.info('Telegram monitor listening', {
    groups: groupIds.length > 0 ? groupIds : 'all',
  });

  return () => {
    client.disconnect().then(() => {
      logger.info('Telegram monitor disconnected');
    }).catch(() => {
      // ignore disconnect errors
    });
  };
}

async function handleMessage(event: NewMessageEvent): Promise<void> {
  const text = event.message?.text || event.message?.message || '';
  if (!text) return;

  // Extract Solana addresses
  const addresses: string[] = [];
  let match: RegExpExecArray | null;

  SOLANA_ADDRESS_RE.lastIndex = 0;
  while ((match = SOLANA_ADDRESS_RE.exec(text)) !== null) {
    const addr = match[1];
    if (!SKIP_ADDRESSES.has(addr)) {
      addresses.push(addr);
    }
  }

  // Extract $TICKER mentions
  TICKER_RE.lastIndex = 0;
  while ((match = TICKER_RE.exec(text)) !== null) {
    const ticker = match[1].toUpperCase();
    // Skip common non-meme tickers
    if (!['SOL', 'BTC', 'ETH', 'USDC', 'USDT', 'USD', 'THE', 'FOR', 'AND'].includes(ticker)) {
      incrementTickerMentionTracked(ticker);
    }
  }

  // Process each CA
  for (const addr of addresses) {
    incrementCAMentionCount(addr);

    // Skip if recently processed
    if (processedCAs.has(addr)) continue;
    processedCAs.set(addr, true);

    logger.info(`Telegram: new CA detected — ${addr}`);

    // Try to get DexScreener data
    let dexData;
    try {
      dexData = await getTokenByAddress(addr) || undefined;
    } catch {
      // Token may not be listed yet
    }

    const candidate: CandidateToken = {
      mintAddress: addr,
      name: dexData?.name || addr.slice(0, 8),
      symbol: dexData?.symbol || '???',
      description: '',
      trendKeyword: '',
      matchScore: 0,
      dexData,
      alertSource: 'telegram',
    };

    // Score and alert
    const scored = await scoreAll([candidate]);
    for (const token of scored) {
      if (token.compositeScore < config.MIN_SCORE_THRESHOLD) continue;
      const safe = await isSafe(token.mintAddress);
      sendAlert(token, safe);
    }
  }
}
