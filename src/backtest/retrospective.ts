/**
 * Retrospective Backtest
 *
 * Fetches tokens from DexScreener (trending profiles, boosted tokens,
 * and keyword searches), scores them using the existing scoring pipeline,
 * and correlates scores with DexScreener price performance.
 *
 * Falls back to pump.fun if available, but DexScreener is the primary source
 * since pump.fun frequently blocks automated requests.
 *
 * Usage: npm run backtest
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { rateLimiter } from '../safety/rateLimiter';
import { getTokenByAddress, DexToken } from '../tokens/dexscreenerScanner';
import { CandidateToken } from '../tokens/tokenMatcher';
import { scoreAll, TokenScore } from '../scoring/tokenScorer';
import { BacktestRecord } from './types';
import { computeStats, printStats } from './stats';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DEX_API = 'https://api.dexscreener.com';

// Meme-adjacent search terms for diverse token discovery
const SEARCH_TERMS = ['pepe', 'doge', 'cat', 'ai', 'trump', 'meme', 'sol', 'pump'];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface TokenEntry {
  mintAddress: string;
  source: string;
  dexData?: DexToken;
}

async function fetchDexProfiles(): Promise<TokenEntry[]> {
  await rateLimiter.waitForSlot('dexscreenertrending');
  try {
    const response = await axios.get(`${DEX_API}/token-profiles/latest/v1`, { timeout: 10_000 });
    rateLimiter.reportSuccess('dexscreenertrending');
    const tokens: any[] = Array.isArray(response.data) ? response.data : [];
    return tokens
      .filter((t: any) => t.chainId === 'solana' && t.tokenAddress?.length >= 32)
      .map((t: any) => ({ mintAddress: t.tokenAddress, source: 'dex_profiles' }));
  } catch (error: any) {
    rateLimiter.reportFailure('dexscreenertrending', error?.response?.status);
    console.error(`  DexScreener profiles failed: ${error.message}`);
    return [];
  }
}

async function fetchDexBoosted(): Promise<TokenEntry[]> {
  await rateLimiter.waitForSlot('dexscreenertrending');
  try {
    const response = await axios.get(`${DEX_API}/token-boosts/latest/v1`, { timeout: 10_000 });
    rateLimiter.reportSuccess('dexscreenertrending');
    const tokens: any[] = Array.isArray(response.data) ? response.data : [];
    return tokens
      .filter((t: any) => t.chainId === 'solana' && t.tokenAddress?.length >= 32)
      .map((t: any) => ({ mintAddress: t.tokenAddress, source: 'dex_boosted' }));
  } catch (error: any) {
    rateLimiter.reportFailure('dexscreenertrending', error?.response?.status);
    console.error(`  DexScreener boosted failed: ${error.message}`);
    return [];
  }
}

async function fetchDexSearch(query: string): Promise<TokenEntry[]> {
  await rateLimiter.waitForSlot('dexscreener');
  try {
    const response = await axios.get(`${DEX_API}/latest/dex/search`, {
      params: { q: query },
      timeout: 10_000,
    });
    rateLimiter.reportSuccess('dexscreener');
    const pairs: any[] = response.data?.pairs || [];
    return pairs
      .filter((p: any) => p.chainId === 'solana' && p.baseToken?.address?.length >= 32)
      .map((p: any) => ({ mintAddress: p.baseToken.address, source: `search:${query}` }));
  } catch (error: any) {
    rateLimiter.reportFailure('dexscreener', error?.response?.status);
    console.error(`  DexScreener search "${query}" failed: ${error.message}`);
    return [];
  }
}

function buildCandidate(mint: string, dexData: DexToken | null): CandidateToken {
  return {
    mintAddress: mint,
    name: dexData?.name || mint.slice(0, 8),
    symbol: dexData?.symbol || '???',
    description: '',
    trendKeyword: '',
    matchScore: 0,
    dexData: dexData || undefined,
    alertSource: 'dex_trending',
  };
}

function buildRecord(score: TokenScore, dexData: DexToken | null): BacktestRecord {
  return {
    mintAddress: score.mintAddress,
    symbol: score.symbol,
    name: score.name,
    alertSource: score.alertSource,
    trendKeyword: score.trendKeyword,
    scoredAt: Date.now(),
    tokenCreatedAt: dexData?.pairCreatedAt?.getTime(),
    socialCAMentions: score.socialCAMentions,
    pumpfunEngagement: score.pumpfunEngagement,
    onchainHealth: score.onchainHealth,
    trendAlignment: score.trendAlignment,
    safetyScore: score.safetyScore,
    smartMoneyScore: score.smartMoneyScore,
    compositeScore: score.compositeScore,
    buyerCount: score.details.caMentionCount,
    holderCount: score.details.holderCount,
    top10Concentration: score.details.top10Concentration,
    buyRatio: score.details.buyRatio,
    volumeToMcapRatio: score.details.volumeToMcapRatio,
    bondingCurveProgress: score.details.bondingCurveProgress,
    replyCount: score.details.replyCount ?? 0,
    liquidityUsd: score.details.liquidityUsd,
    ageHours: score.details.ageHours,
    priceAtScore: {
      priceChangeH1: dexData?.priceChangeH1 || 0,
      priceChangeH24: dexData?.priceChangeH24 || 0,
      fdv: dexData?.fdv || 0,
      liquidityUsd: dexData?.liquidityUsd || 0,
      volumeH24: dexData?.volumeH24 || 0,
    },
  };
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  Retrospective Backtest — Meme Finder');
  console.log('='.repeat(60));

  // Step 1: Discover token mint addresses from multiple DexScreener sources
  console.log('\n[1/5] Discovering tokens from DexScreener...');
  const seenMints = new Set<string>();
  const allEntries: TokenEntry[] = [];

  const addUnique = (entries: TokenEntry[], label: string) => {
    let added = 0;
    for (const e of entries) {
      if (!seenMints.has(e.mintAddress)) {
        seenMints.add(e.mintAddress);
        allEntries.push(e);
        added++;
      }
    }
    console.log(`  ${label}: ${entries.length} found, ${added} new (${allEntries.length} total)`);
  };

  // Trending profiles
  const profiles = await fetchDexProfiles();
  addUnique(profiles, 'Token profiles');
  await sleep(1000);

  // Boosted tokens
  const boosted = await fetchDexBoosted();
  addUnique(boosted, 'Boosted tokens');
  await sleep(1000);

  // Keyword searches for diversity
  for (const term of SEARCH_TERMS) {
    const results = await fetchDexSearch(term);
    addUnique(results, `Search "${term}"`);
    await sleep(1500);
  }

  console.log(`\n  Total unique tokens: ${allEntries.length}`);

  if (allEntries.length === 0) {
    console.error('\n  No tokens discovered. Check network connectivity.');
    process.exit(1);
  }

  // Step 2: Enrich each with full DexScreener token data
  console.log('\n[2/5] Enriching with full DexScreener data...');
  const enriched: { mint: string; dexData: DexToken | null }[] = [];

  for (let i = 0; i < allEntries.length; i++) {
    const { mintAddress } = allEntries[i];
    let dexData: DexToken | null = null;
    try {
      dexData = await getTokenByAddress(mintAddress);
    } catch {
      // Token may have been delisted
    }

    enriched.push({ mint: mintAddress, dexData });

    if ((i + 1) % 10 === 0 || i + 1 === allEntries.length) {
      console.log(`  Progress: ${i + 1}/${allEntries.length} (${((i + 1) / allEntries.length * 100).toFixed(0)}%)`);
    }
  }

  const withDex = enriched.filter(e => e.dexData !== null);
  console.log(`  Enriched: ${withDex.length}/${allEntries.length} have full data`);

  // Step 3: Score all tokens
  console.log('\n[3/5] Scoring tokens...');
  const SCORE_BATCH_SIZE = 10;
  const allScored: { score: TokenScore; dexData: DexToken | null }[] = [];

  for (let i = 0; i < enriched.length; i += SCORE_BATCH_SIZE) {
    const batch = enriched.slice(i, i + SCORE_BATCH_SIZE);
    const candidates = batch.map(e => buildCandidate(e.mint, e.dexData));

    const scored = await scoreAll(candidates);

    for (const s of scored) {
      const match = batch.find(e => e.mint === s.mintAddress);
      if (match) {
        allScored.push({ score: s, dexData: match.dexData });
      }
    }

    const progress = Math.min(i + SCORE_BATCH_SIZE, enriched.length);
    if (progress % 20 === 0 || progress === enriched.length) {
      console.log(`  Scored: ${progress}/${enriched.length}`);
    }
  }

  console.log(`  Successfully scored: ${allScored.length} tokens`);

  // Step 4: Build backtest records
  console.log('\n[4/5] Building backtest records...');
  const records: BacktestRecord[] = allScored.map(({ score, dexData }) =>
    buildRecord(score, dexData),
  );

  // Step 5: Compute and print stats
  console.log('\n[5/5] Computing statistics...');
  const stats = computeStats(records, false); // retrospective: use priceAtScore data
  printStats(stats);

  // Save results
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(DATA_DIR, `backtest-${timestamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ stats, records }, null, 2));
  console.log(`Results saved to: ${outPath}`);

  // Quick summary
  console.log('\n--- Quick Summary ---');
  const aboveThreshold = records.filter(r => r.compositeScore >= 70);
  const belowThreshold = records.filter(r => r.compositeScore < 70);
  if (aboveThreshold.length > 0 && belowThreshold.length > 0) {
    const avgAbove1h = aboveThreshold.reduce((a, r) => a + r.priceAtScore.priceChangeH1, 0) / aboveThreshold.length;
    const avgBelow1h = belowThreshold.reduce((a, r) => a + r.priceAtScore.priceChangeH1, 0) / belowThreshold.length;
    const avgAbove24h = aboveThreshold.reduce((a, r) => a + r.priceAtScore.priceChangeH24, 0) / aboveThreshold.length;
    const avgBelow24h = belowThreshold.reduce((a, r) => a + r.priceAtScore.priceChangeH24, 0) / belowThreshold.length;
    console.log(`  Score >= 70: ${aboveThreshold.length} tokens, avg 1h return: ${avgAbove1h.toFixed(1)}%, avg 24h return: ${avgAbove24h.toFixed(1)}%`);
    console.log(`  Score <  70: ${belowThreshold.length} tokens, avg 1h return: ${avgBelow1h.toFixed(1)}%, avg 24h return: ${avgBelow24h.toFixed(1)}%`);
  }
}

main().catch(error => {
  console.error('Backtest failed:', error.message);
  process.exit(1);
});
