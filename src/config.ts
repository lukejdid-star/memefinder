import dotenv from 'dotenv';
dotenv.config();

function envOrDefault(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

const heliusKey = envOrDefault('HELIUS_API_KEY', '');

export const config = {
  // Solana RPC (needed for on-chain safety checks)
  SOLANA_RPC_URL: envOrDefault('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  HELIUS_API_KEY: heliusKey,

  // Alert thresholds
  MIN_SCORE_THRESHOLD: parseInt(envOrDefault('MIN_SCORE_THRESHOLD', '70'), 10),
  SCAN_INTERVAL_MS: parseInt(envOrDefault('SCAN_INTERVAL_MS', '30000'), 10),

  // Trend detection thresholds
  TREND_MIN_SOURCES: 2,
  TREND_SINGLE_SOURCE_VELOCITY_THRESHOLD: 10000,
  TREND_COOLDOWN_MS: 6 * 60 * 60 * 1000, // 6 hours cooldown per meme

  // Scoring weights (rebalanced for smart money)
  SCORE_WEIGHT_SOCIAL_CA: 0.25,
  SCORE_WEIGHT_PUMPFUN_ENGAGEMENT: 0.20,
  SCORE_WEIGHT_ONCHAIN_HEALTH: 0.20,
  SCORE_WEIGHT_TREND_ALIGNMENT: 0.10,
  SCORE_WEIGHT_SAFETY: 0.10,
  SCORE_WEIGHT_SMART_MONEY: 0.15,

  // Pump.fun program ID
  PUMPFUN_PROGRAM_ID: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  // PumpSwap program ID
  PUMPSWAP_PROGRAM_ID: envOrDefault('PUMPSWAP_PROGRAM_ID', 'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP'),

  // Jupiter API base (used for honeypot check in rug detector)
  JUPITER_API_BASE: 'https://quote-api.jup.ag/v6',

  // SOL mint (used for honeypot check)
  SOL_MINT: 'So11111111111111111111111111111111111111112',

  // Discord
  DISCORD_BOT_TOKEN: envOrDefault('DISCORD_BOT_TOKEN', ''),
  DISCORD_CHANNEL_ID: envOrDefault('DISCORD_CHANNEL_ID', ''),

  // Launch monitor (proactive pump.fun scanning)
  ENABLE_LAUNCH_MONITOR: envOrDefault('ENABLE_LAUNCH_MONITOR', 'false') === 'true',
  LAUNCH_MONITOR_POLL_MS: parseInt(envOrDefault('LAUNCH_MONITOR_POLL_MS', '12000'), 10),

  // Smart money tracking
  ENABLE_SMART_MONEY: envOrDefault('ENABLE_SMART_MONEY', 'false') === 'true',
  SMART_MONEY_WALLETS: envOrDefault('SMART_MONEY_WALLETS', '').split(',').map(s => s.trim()).filter(Boolean),
  SMART_MONEY_POLL_MS: parseInt(envOrDefault('SMART_MONEY_POLL_MS', '15000'), 10),

  // GoPlus security API
  ENABLE_GOPLUS: envOrDefault('ENABLE_GOPLUS', 'false') === 'true',

  // DexScreener trending
  ENABLE_DEXSCREENER_TRENDING: envOrDefault('ENABLE_DEXSCREENER_TRENDING', 'true') === 'true',
  DEXSCREENER_TRENDING_TIMEFRAME: envOrDefault('DEXSCREENER_TRENDING_TIMEFRAME', '1h'),

  // Jupiter trending
  ENABLE_JUPITER_TRENDING: envOrDefault('ENABLE_JUPITER_TRENDING', 'true') === 'true',
  JUPITER_TRENDING_INTERVAL: envOrDefault('JUPITER_TRENDING_INTERVAL', '1h'),

  // Graduation detection
  ENABLE_GRADUATION_DETECTION: envOrDefault('ENABLE_GRADUATION_DETECTION', 'true') === 'true',

  // Telegram monitoring
  ENABLE_TELEGRAM: envOrDefault('ENABLE_TELEGRAM', 'false') === 'true',
  TELEGRAM_API_ID: parseInt(envOrDefault('TELEGRAM_API_ID', '0'), 10),
  TELEGRAM_API_HASH: envOrDefault('TELEGRAM_API_HASH', ''),
  TELEGRAM_PHONE: envOrDefault('TELEGRAM_PHONE', ''),
  TELEGRAM_SESSION: envOrDefault('TELEGRAM_SESSION', ''),
  TELEGRAM_GROUP_IDS: envOrDefault('TELEGRAM_GROUP_IDS', '').split(',').map(s => s.trim()).filter(Boolean),

  // Helius WebSocket URL (derived from API key)
  HELIUS_WS_URL: heliusKey
    ? `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`
    : '',
} as const;
