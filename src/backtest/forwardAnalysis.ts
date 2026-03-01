/**
 * Forward Analysis Report
 *
 * Reads the forward-tracker JSONL file, filters to records with outcomes,
 * computes stats, and prints tables + per-alert-source breakdown.
 *
 * Usage: npm run backtest-report
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { BacktestRecord } from './types';
import { computeStats, printStats } from './stats';
import { AlertSource } from '../tokens/tokenMatcher';

const JSONL_PATH = path.join(process.cwd(), 'data', 'forward-tracker.jsonl');

function readAllRecords(): BacktestRecord[] {
  if (!fs.existsSync(JSONL_PATH)) {
    console.error(`No forward tracker data found at: ${JSONL_PATH}`);
    console.error('Run the bot with ENABLE_FORWARD_TRACKER=true first.');
    process.exit(1);
  }

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

function main(): void {
  console.log('='.repeat(60));
  console.log('  Forward Tracker Analysis Report');
  console.log('='.repeat(60));

  const all = readAllRecords();
  console.log(`\n  Total records: ${all.length}`);

  const withOutcomes = all.filter(
    r => r.outcomes && (r.outcomes.priceChangeH1 != null || r.outcomes.priceChangeH24 != null),
  );
  console.log(`  Records with outcomes: ${withOutcomes.length}`);

  const with1h = all.filter(r => r.outcomes?.priceChangeH1 != null);
  const with24h = all.filter(r => r.outcomes?.priceChangeH24 != null);
  console.log(`  With 1h outcome: ${with1h.length}`);
  console.log(`  With 24h outcome: ${with24h.length}`);

  if (withOutcomes.length < 5) {
    console.log('\n  Not enough outcome data yet. Wait for the outcome checker to run.');
    console.log('  Tokens need to be at least 1h old for 1h outcomes, 24h for 24h outcomes.');
    process.exit(0);
  }

  // Overall stats (forward mode: use outcomes)
  console.log('\n\n--- OVERALL RESULTS (Forward Outcomes) ---');
  const stats = computeStats(withOutcomes, true);
  printStats(stats);

  // Per-alert-source breakdown
  const sources = new Set(withOutcomes.map(r => r.alertSource));
  if (sources.size > 1) {
    console.log('\n--- PER-SOURCE BREAKDOWN ---\n');

    for (const source of sources) {
      const sourceRecords = withOutcomes.filter(r => r.alertSource === source);
      if (sourceRecords.length < 3) {
        console.log(`  ${source}: only ${sourceRecords.length} records, skipping\n`);
        continue;
      }

      console.log(`  Source: ${source} (${sourceRecords.length} tokens)`);
      const sourceStats = computeStats(sourceRecords, true);

      // Print compact summary instead of full tables
      console.log(`    Composite vs 1h:  ${sourceStats.compositeVsH1Correlation.toFixed(3)}`);
      console.log(`    Composite vs 24h: ${sourceStats.compositeVsH24Correlation.toFixed(3)}`);

      if (sourceStats.thresholdAnalysis.length > 0) {
        const t70 = sourceStats.thresholdAnalysis.find(t => t.threshold === 70);
        if (t70 && t70.count > 0) {
          console.log(`    Score >= 70: ${t70.count} tokens, avg 1h: ${t70.avgReturn1h.toFixed(1)}%, hit rate: ${t70.hitRate1h.toFixed(0)}%`);
        }
      }
      console.log('');
    }
  }

  // Time range info
  const oldest = Math.min(...all.map(r => r.scoredAt));
  const newest = Math.max(...all.map(r => r.scoredAt));
  const rangeHours = (newest - oldest) / (60 * 60 * 1000);
  console.log('--- Data Range ---');
  console.log(`  Oldest record: ${new Date(oldest).toISOString()}`);
  console.log(`  Newest record: ${new Date(newest).toISOString()}`);
  console.log(`  Span: ${rangeHours.toFixed(1)} hours`);
  console.log('');
}

main();
