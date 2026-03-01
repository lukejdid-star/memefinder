import { AlertSource } from '../tokens/tokenMatcher';

export interface PriceAtScore {
  priceChangeH1: number;
  priceChangeH24: number;
  fdv: number;
  liquidityUsd: number;
  volumeH24: number;
}

export interface OutcomeData {
  checkedAt1h?: number;
  fdvAt1h?: number;
  priceChangeH1?: number;   // FDV delta % from score time to 1h later

  checkedAt6h?: number;
  fdvAt6h?: number;
  priceChangeH6?: number;

  checkedAt24h?: number;
  fdvAt24h?: number;
  priceChangeH24?: number;
}

export interface BacktestRecord {
  // Identity
  mintAddress: string;
  symbol: string;
  name: string;
  alertSource: AlertSource;
  trendKeyword: string;

  // Timestamps
  scoredAt: number;
  tokenCreatedAt?: number;

  // Sub-scores (0-100)
  socialCAMentions: number;
  pumpfunEngagement: number;
  onchainHealth: number;
  trendAlignment: number;
  safetyScore: number;
  smartMoneyScore: number;
  compositeScore: number;

  // Key details
  buyerCount: number;
  holderCount: number;
  top10Concentration: number;
  buyRatio: number;
  volumeToMcapRatio: number;
  bondingCurveProgress: number;
  replyCount: number;
  liquidityUsd: number;
  ageHours: number;

  // Price snapshot at score time
  priceAtScore: PriceAtScore;

  // Forward outcomes (filled in later by outcome checker)
  outcomes?: OutcomeData;
}

export interface SignalCorrelation {
  signal: string;
  vsH1: number;
  vsH24: number;
  count: number;
}

export interface QuartileGroup {
  label: string;
  scoreRange: string;
  count: number;
  avgReturn1h: number;
  medianReturn1h: number;
  avgReturn24h: number;
  medianReturn24h: number;
  hitRate1h: number;   // % of tokens with positive return
  hitRate24h: number;
}

export interface ThresholdAnalysis {
  threshold: number;
  count: number;
  avgReturn1h: number;
  avgReturn24h: number;
  hitRate1h: number;
  hitRate24h: number;
}

export interface BacktestStats {
  totalTokens: number;
  tokensWithOutcomes: number;

  compositeVsH1Correlation: number;
  compositeVsH24Correlation: number;

  signalCorrelations: SignalCorrelation[];
  quartiles: QuartileGroup[];
  thresholdAnalysis: ThresholdAnalysis[];
}
