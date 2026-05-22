/**
 * Generate a migration summary report from the tier checkpoint file.
 *
 * Reads data/checkpoints/tier-{N}-checkpoint.json and prints a clean
 * human-readable summary plus writes a timestamped JSON report.
 *
 * Usage:
 *   node scripts/migration-report.js --tier=3
 *   node scripts/migration-report.js --tier=1
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TIER = parseInt(
  process.argv.find(a => a.startsWith('--tier='))?.split('=')[1] || '3'
);

const CHECKPOINT_DIR = join(__dirname, '../data/checkpoints');
const REPORTS_DIR    = join(__dirname, '../data/reports');
const CP_FILE        = join(CHECKPOINT_DIR, `tier-${TIER}-checkpoint.json`);

if (!existsSync(CP_FILE)) {
  console.error(`No checkpoint found at ${CP_FILE}`);
  console.error(`Run npm run migrate:tier${TIER} first.`);
  process.exit(1);
}

const state = JSON.parse(readFileSync(CP_FILE, 'utf-8'));

// Support both old format (succeeded only) and new format (updated + inserted)
const updated  = state.updated  ?? '—';
const inserted = state.inserted ?? '—';
const succeeded = state.succeeded ?? ((state.updated ?? 0) + (state.inserted ?? 0));

const TIER_NAMES = { 1: 'Workshop Buyers', 2: 'Preview Buyers', 3: 'General Registrants' };
const tierName   = TIER_NAMES[TIER] ?? `Tier ${TIER}`;

// Duration
let duration = '—';
if (state.startedAt && state.completedAt) {
  const ms  = new Date(state.completedAt) - new Date(state.startedAt);
  const hrs = Math.floor(ms / 3600000);
  const min = Math.floor((ms % 3600000) / 60000);
  duration  = `${hrs}h ${min}m`;
}

const isComplete = !!state.completedAt;
const progress   = state.totalBatches
  ? `${state.lastBatch + 1} / ${state.totalBatches} batches (${(((state.lastBatch + 1) / state.totalBatches) * 100).toFixed(1)}%)`
  : '—';

console.log('');
console.log(`╔══════════════════════════════════════════════════════╗`);
console.log(`║   Tier ${TIER} Migration Report — ${tierName.padEnd(22)} ║`);
console.log(`╚══════════════════════════════════════════════════════╝`);
console.log('');
console.log(`  Status          : ${isComplete ? '✅ COMPLETE' : '⏳ IN PROGRESS'}`);
console.log(`  Progress        : ${progress}`);
console.log(`  Duration        : ${duration}`);
console.log(`  Started         : ${state.startedAt ?? '—'}`);
console.log(`  Completed       : ${state.completedAt ?? '(not yet)'}`);
console.log('');
console.log(`  ── Results ──────────────────────────────────────────`);
console.log(`  Contacts processed : ${(state.processed ?? succeeded + state.failed + state.skipped).toLocaleString()}`);
console.log(`  ✅ Succeeded        : ${succeeded.toLocaleString()}`);
if (state.updated  !== undefined) console.log(`     ↳ Updated       : ${updated.toLocaleString()}   (existing HubSpot contacts enriched)`);
if (state.inserted !== undefined) console.log(`     ↳ Created       : ${inserted.toLocaleString()}   (net-new contacts added to HubSpot)`);
console.log(`  ❌ Failed           : ${(state.failed ?? 0).toLocaleString()}`);
console.log(`  ⏭  Skipped          : ${(state.skipped ?? 0).toLocaleString()}   (no email/phone/HubSpot ID — unresolvable)`);
console.log('');

if (state.failedRecords?.length > 0) {
  console.log(`  ── Failed Records (first 10) ────────────────────────`);
  for (const r of state.failedRecords.slice(0, 10)) {
    console.log(`    Batch ${r.batchNumber}: ${r.email ?? r.engagerId ?? '(no identifier)'} — ${r.error ?? r.message ?? JSON.stringify(r)}`);
  }
  if (state.failedRecords.length > 10) {
    console.log(`    ... and ${state.failedRecords.length - 10} more (see checkpoint JSON for full list)`);
  }
  console.log('');
}

// Write JSON report
const report = {
  generatedAt: new Date().toISOString(),
  tier: TIER,
  tierName,
  status: isComplete ? 'complete' : 'in-progress',
  progress: { lastBatch: state.lastBatch, totalBatches: state.totalBatches },
  timing: { startedAt: state.startedAt, completedAt: state.completedAt, duration },
  results: {
    processed: state.processed ?? succeeded + (state.failed ?? 0) + (state.skipped ?? 0),
    succeeded,
    updated,
    inserted,
    failed:  state.failed  ?? 0,
    skipped: state.skipped ?? 0,
  },
  failedCount: state.failedRecords?.length ?? 0,
  failedRecords: state.failedRecords ?? [],
};

mkdirSync(REPORTS_DIR, { recursive: true });
const ts         = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = join(REPORTS_DIR, `migration-tier${TIER}-report-${ts}.json`);
writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(`  Report saved to: data/reports/migration-tier${TIER}-report-${ts}.json`);
console.log('');
