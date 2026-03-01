import {
  BacktestRecord,
  BacktestStats,
  SignalCorrelation,
  QuartileGroup,
  ThresholdAnalysis,
} from './types';

export function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  const denom = Math.sqrt(denomX * denomY);
  if (denom === 0) return 0;
  return numerator / denom;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function getReturns(
  record: BacktestRecord,
  useOutcomes: boolean,
): { h1: number | null; h24: number | null } {
  if (useOutcomes) {
    return {
      h1: record.outcomes?.priceChangeH1 ?? null,
      h24: record.outcomes?.priceChangeH24 ?? null,
    };
  }
  return {
    h1: record.priceAtScore.priceChangeH1,
    h24: record.priceAtScore.priceChangeH24,
  };
}

export function computeStats(
  records: BacktestRecord[],
  useOutcomes: boolean,
): BacktestStats {
  // Filter to records that have usable return data
  const usable = records.filter(r => {
    const ret = getReturns(r, useOutcomes);
    return ret.h1 !== null || ret.h24 !== null;
  });

  const tokensWithOutcomes = useOutcomes
    ? records.filter(r => r.outcomes && (r.outcomes.priceChangeH1 != null || r.outcomes.priceChangeH24 != null)).length
    : usable.length;

  // --- Composite correlations ---
  const composites = usable.map(r => r.compositeScore);
  const h1Returns = usable.map(r => getReturns(r, useOutcomes).h1 ?? 0);
  const h24Returns = usable.map(r => getReturns(r, useOutcomes).h24 ?? 0);

  const compositeVsH1 = pearsonCorrelation(composites, h1Returns);
  const compositeVsH24 = pearsonCorrelation(composites, h24Returns);

  // --- Per-signal correlations ---
  const signalNames: { key: keyof BacktestRecord; label: string }[] = [
    { key: 'socialCAMentions', label: 'Social/CA Mentions' },
    { key: 'pumpfunEngagement', label: 'Pumpfun Engagement' },
    { key: 'onchainHealth', label: 'Onchain Health' },
    { key: 'trendAlignment', label: 'Trend Alignment' },
    { key: 'safetyScore', label: 'Safety Score' },
    { key: 'smartMoneyScore', label: 'Smart Money' },
  ];

  const signalCorrelations: SignalCorrelation[] = signalNames.map(({ key, label }) => {
    const vals = usable.map(r => r[key] as number);
    return {
      signal: label,
      vsH1: pearsonCorrelation(vals, h1Returns),
      vsH24: pearsonCorrelation(vals, h24Returns),
      count: usable.length,
    };
  });

  // --- Quartile analysis ---
  const sorted = [...usable].sort((a, b) => a.compositeScore - b.compositeScore);
  const quartileSize = Math.ceil(sorted.length / 4);
  const quartiles: QuartileGroup[] = [];

  const quartileLabels = ['Q1 (lowest)', 'Q2', 'Q3', 'Q4 (highest)'];
  for (let q = 0; q < 4; q++) {
    const start = q * quartileSize;
    const slice = sorted.slice(start, start + quartileSize);
    if (slice.length === 0) continue;

    const scores = slice.map(r => r.compositeScore);
    const qH1 = slice.map(r => getReturns(r, useOutcomes).h1 ?? 0);
    const qH24 = slice.map(r => getReturns(r, useOutcomes).h24 ?? 0);

    quartiles.push({
      label: quartileLabels[q],
      scoreRange: `${Math.min(...scores).toFixed(1)}-${Math.max(...scores).toFixed(1)}`,
      count: slice.length,
      avgReturn1h: qH1.reduce((a, b) => a + b, 0) / qH1.length,
      medianReturn1h: median(qH1),
      avgReturn24h: qH24.reduce((a, b) => a + b, 0) / qH24.length,
      medianReturn24h: median(qH24),
      hitRate1h: (qH1.filter(v => v > 0).length / qH1.length) * 100,
      hitRate24h: (qH24.filter(v => v > 0).length / qH24.length) * 100,
    });
  }

  // --- Threshold analysis ---
  const thresholds = [50, 60, 70, 80];
  const thresholdAnalysis: ThresholdAnalysis[] = thresholds.map(threshold => {
    const above = usable.filter(r => r.compositeScore >= threshold);
    if (above.length === 0) {
      return { threshold, count: 0, avgReturn1h: 0, avgReturn24h: 0, hitRate1h: 0, hitRate24h: 0 };
    }
    const tH1 = above.map(r => getReturns(r, useOutcomes).h1 ?? 0);
    const tH24 = above.map(r => getReturns(r, useOutcomes).h24 ?? 0);
    return {
      threshold,
      count: above.length,
      avgReturn1h: tH1.reduce((a, b) => a + b, 0) / tH1.length,
      avgReturn24h: tH24.reduce((a, b) => a + b, 0) / tH24.length,
      hitRate1h: (tH1.filter(v => v > 0).length / tH1.length) * 100,
      hitRate24h: (tH24.filter(v => v > 0).length / tH24.length) * 100,
    };
  });

  return {
    totalTokens: records.length,
    tokensWithOutcomes,
    compositeVsH1Correlation: compositeVsH1,
    compositeVsH24Correlation: compositeVsH24,
    signalCorrelations,
    quartiles,
    thresholdAnalysis,
  };
}

// --- Console table printer ---

function pad(str: string, len: number, align: 'left' | 'right' = 'right'): string {
  if (align === 'left') return str.padEnd(len);
  return str.padStart(len);
}

function fmtPct(val: number): string {
  const sign = val >= 0 ? '+' : '';
  return `${sign}${val.toFixed(1)}%`;
}

function fmtCorr(val: number): string {
  return val.toFixed(3);
}

export function printStats(stats: BacktestStats): void {
  console.log('\n' + '='.repeat(70));
  console.log('  BACKTEST RESULTS');
  console.log('='.repeat(70));
  console.log(`  Total tokens: ${stats.totalTokens}  |  With outcomes: ${stats.tokensWithOutcomes}`);

  // Correlations
  console.log('\n--- Composite Score Correlations ---');
  console.log(`  Composite vs 1h return:  ${fmtCorr(stats.compositeVsH1Correlation)}`);
  console.log(`  Composite vs 24h return: ${fmtCorr(stats.compositeVsH24Correlation)}`);

  // Per-signal correlations
  console.log('\n--- Per-Signal Correlations ---');
  const sigHeader = `  ${pad('Signal', 22, 'left')} ${pad('vs 1h', 8)} ${pad('vs 24h', 8)} ${pad('N', 5)}`;
  console.log(sigHeader);
  console.log('  ' + '-'.repeat(sigHeader.length - 2));
  for (const sc of stats.signalCorrelations) {
    console.log(
      `  ${pad(sc.signal, 22, 'left')} ${pad(fmtCorr(sc.vsH1), 8)} ${pad(fmtCorr(sc.vsH24), 8)} ${pad(String(sc.count), 5)}`,
    );
  }

  // Quartile analysis
  console.log('\n--- Quartile Analysis ---');
  const qHeader = `  ${pad('Quartile', 16, 'left')} ${pad('Range', 12, 'left')} ${pad('N', 4)} ${pad('Avg 1h', 9)} ${pad('Med 1h', 9)} ${pad('Avg 24h', 9)} ${pad('Med 24h', 9)} ${pad('Hit% 1h', 8)} ${pad('Hit% 24h', 9)}`;
  console.log(qHeader);
  console.log('  ' + '-'.repeat(qHeader.length - 2));
  for (const q of stats.quartiles) {
    console.log(
      `  ${pad(q.label, 16, 'left')} ${pad(q.scoreRange, 12, 'left')} ${pad(String(q.count), 4)} ${pad(fmtPct(q.avgReturn1h), 9)} ${pad(fmtPct(q.medianReturn1h), 9)} ${pad(fmtPct(q.avgReturn24h), 9)} ${pad(fmtPct(q.medianReturn24h), 9)} ${pad(fmtPct(q.hitRate1h), 8)} ${pad(fmtPct(q.hitRate24h), 9)}`,
    );
  }

  // Threshold analysis
  console.log('\n--- Threshold Analysis ---');
  const tHeader = `  ${pad('Threshold', 10, 'left')} ${pad('N', 5)} ${pad('Avg 1h', 9)} ${pad('Avg 24h', 9)} ${pad('Hit% 1h', 8)} ${pad('Hit% 24h', 9)}`;
  console.log(tHeader);
  console.log('  ' + '-'.repeat(tHeader.length - 2));
  for (const t of stats.thresholdAnalysis) {
    console.log(
      `  ${pad(`>= ${t.threshold}`, 10, 'left')} ${pad(String(t.count), 5)} ${pad(fmtPct(t.avgReturn1h), 9)} ${pad(fmtPct(t.avgReturn24h), 9)} ${pad(fmtPct(t.hitRate1h), 8)} ${pad(fmtPct(t.hitRate24h), 9)}`,
    );
  }

  console.log('\n' + '='.repeat(70) + '\n');
}
