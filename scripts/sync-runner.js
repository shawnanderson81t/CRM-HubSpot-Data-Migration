/**
 * sync-runner.js — the nightly GHL→HubSpot sync orchestrator (Phase 4).
 *
 * One run does: acquire lock → extract delta since the watermark → transform +
 * conflict-resolve + upsert (reusing the migration pipeline) → report → advance
 * the watermark ONLY on success → release lock.
 *
 * Design choices:
 *   - Single-shot by default: it runs once and exits, so an OS scheduler
 *     (Windows Task Scheduler / cron) can invoke it nightly at 2:00 AM MST. That
 *     survives reboots and crashes far better than a long-lived in-process timer.
 *     A zero-dependency `--schedule` loop is provided for convenience/testing.
 *   - Idempotent: the watermark (data/sync-state.json) only moves forward after a
 *     successful run, so a failed/crashed run re-pulls the same window next time.
 *     The upsert itself is idempotent, so a re-pulled window is harmless.
 *   - Overlap-safe: a PID lock means a second run exits immediately if one is live.
 *
 * Usage:
 *   node scripts/sync-runner.js                 # run once, exit (for the OS scheduler)
 *   node scripts/sync-runner.js --dry-run       # extract + report only; touches nothing
 *   node scripts/sync-runner.js --since=2026-05-23T00:00:00Z   # force a window (backfill)
 *   node scripts/sync-runner.js --schedule      # stay resident, run daily (convenience)
 *
 * Exit code: 0 on success (or intentional overlap-skip), 1 on failure/crash — so a
 * wrapping scheduler can detect a bad run.
 */

import 'dotenv/config';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { pathToFileURL } from 'url';
import { loadConfig } from '../src/utils/config.js';
import { logger } from '../src/utils/logger.js';
import { GHLClient } from '../src/extract/ghlClient.js';
import { HubSpotClient } from '../src/load/hubspotClient.js';
import { Checkpoint } from '../src/load/checkpoint.js';
import { BatchUpserter } from '../src/load/batchUpserter.js';
import { ConflictResolver } from '../src/transform/conflictResolver.js';
import { SyncState } from '../src/load/syncState.js';
import { Mailer } from '../src/utils/mailer.js';
import { acquireLock, releaseLock } from '../src/utils/pidLock.js';

/**
 * Resolve the [since, until] window for a run. `until` is captured once at run
 * start and is also the value the watermark advances to on success.
 *
 * @param {Object} config
 * @param {SyncState} syncState
 * @param {string} until - ISO upper bound (run start time).
 * @param {string|null} sinceOverride - Explicit --since, if any.
 * @returns {{ since: string, source: string }}
 */
export function resolveWindow(config, syncState, until, sinceOverride) {
  if (sinceOverride) return { since: new Date(sinceOverride).toISOString(), source: '--since override' };
  const last = syncState.getLastSyncAt();
  if (last) return { since: new Date(last).toISOString(), source: 'sync-state lastSyncAt' };
  const since = new Date(Date.parse(until) - config.sync.defaultLookbackHours * 3600 * 1000).toISOString();
  return { since, source: `first run — default ${config.sync.defaultLookbackHours}h lookback` };
}

/** Load the GHL-user → HubSpot-owner map if present (optional). */
function loadOwnerMap() {
  try {
    const m = JSON.parse(readFileSync('./data/owner-map.json', 'utf-8'));
    logger.info(`Owner map loaded: ${Object.keys(m).length} entries`);
    return m;
  } catch {
    logger.warn('No owner map at data/owner-map.json — new contacts will be unassigned');
    return {};
  }
}

/**
 * Execute exactly one sync run.
 *
 * @param {Object} config - loadConfig() output.
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false]
 * @param {string|null} [options.sinceOverride=null]
 * @param {Object} [options.deps] - Injectable factories for testing.
 * @returns {Promise<Object>} run summary (includes `ok`).
 */
export async function runOnce(config, { dryRun = false, sinceOverride = null, deps = {} } = {}) {
  const makeGhl      = deps.makeGhl      || (() => new GHLClient({ apiKey: config.ghl.apiKey, locationId: config.ghl.locationId }));
  const makeHubspot  = deps.makeHubspot  || (() => new HubSpotClient(config));
  const makeUpserter = deps.makeUpserter || ((hs, cp, om, cr) => new BatchUpserter(hs, cp, config, om, cr));

  const lock = acquireLock(config.sync.lockPath);
  if (!lock.ok) {
    logger.warn(`Another sync run is active (pid ${lock.heldBy?.pid}, since ${lock.heldBy?.startedAt}) — skipping`);
    return { ok: true, skippedOverlap: true };
  }

  const startedAt = new Date();
  const until = startedAt.toISOString();
  const syncState = new SyncState(config.sync.statePath);
  const mailer = deps.mailer || new Mailer(config.mail);
  // Mail is a side-channel — a mail failure must never fail the sync run itself.
  const notify = async fn => { try { await fn(); } catch (e) { logger.error('Mailer error (non-fatal)', { error: e.message }); } };

  try {
    const { since, source } = resolveWindow(config, syncState, until, sinceOverride);
    logger.info('=== Sync run start ===', { since, until, source, dryRun });
    console.log(`\n=== Daily Sync ${dryRun ? '(DRY RUN)' : ''} ===`);
    console.log(`  Window : ${since} -> ${until}  (${source})`);

    // 1. Extract delta -------------------------------------------------------
    const ghl = makeGhl();
    const delta = await ghl.getContactsChangedSince(since, {
      until,
      excludeTags: config.sync.excludeTags,
      onProgress: ({ collected, scanned }) =>
        process.stdout.write(`\r  extracting... ${collected} changed (scanned ${scanned})   `),
    });
    process.stdout.write('\n');
    logger.info(`Sync extract: ${delta.length} changed contacts`);

    // Dry run: report only, never touch HubSpot, never move the watermark -----
    if (dryRun) {
      const summary = { startedAt: until, finishedAt: new Date().toISOString(), ok: true,
        dryRun: true, window: { since, until }, changed: delta.length,
        updated: 0, inserted: 0, failed: 0, skipped: 0 };
      await notify(() => mailer.sendRunSummary(summary));
      console.log(`  DRY RUN — ${delta.length} contacts would be processed. Nothing written; watermark unchanged.`);
      return summary;
    }

    // Nothing changed: safe to advance the watermark -------------------------
    if (delta.length === 0) {
      const summary = { startedAt: until, finishedAt: new Date().toISOString(), ok: true,
        window: { since, until }, changed: 0, updated: 0, inserted: 0, failed: 0, skipped: 0 };
      syncState.recordRun(summary, { advanceTo: until });
      await notify(() => mailer.sendRunSummary(summary));
      console.log('  Nothing changed in the window. Watermark advanced.');
      return summary;
    }

    // 2. Transform + conflict-resolve + upsert (reuses migration pipeline) ----
    const hubspotClient = makeHubspot();
    const ownerMap = loadOwnerMap();
    const resolver = new ConflictResolver();

    const checkpoint = new Checkpoint('sync', config.paths.checkpointDir);
    if (existsSync(checkpoint.filePath)) unlinkSync(checkpoint.filePath); // fresh per run

    const upserter = makeUpserter(hubspotClient, checkpoint, ownerMap, resolver);
    const state = await upserter.run(delta, 'sync');

    // 3. Judge success + advance watermark -----------------------------------
    const processed = state.updated + state.inserted + state.failed + state.skipped;
    const failureRate = processed > 0 ? state.failed / processed : 0;
    const ok = failureRate <= config.sync.maxFailureRate;

    const summary = {
      startedAt: until, finishedAt: new Date().toISOString(), ok,
      window: { since, until }, changed: delta.length,
      updated: state.updated, inserted: state.inserted, failed: state.failed,
      skipped: state.skipped, failureRate: Number(failureRate.toFixed(4)),
    };
    syncState.recordRun(summary, { advanceTo: ok ? until : null });

    console.log(`\n=== Sync ${ok ? 'OK' : 'FAILED (failure rate too high)'} ===`);
    console.log(`  changed=${delta.length} updated=${state.updated} inserted=${state.inserted} failed=${state.failed} skipped=${state.skipped}`);
    console.log(`  watermark ${ok ? 'advanced to ' + until : 'HELD — window retried next run'}`);
    if (!ok) {
      logger.error(`Sync failure rate ${(failureRate * 100).toFixed(1)}% exceeded ${config.sync.maxFailureRate * 100}% — watermark held`);
    }
    await notify(() => mailer.sendRunSummary(summary));
    if (!ok) await notify(() => mailer.sendFailureAlert({ ...summary, error: 'failure rate exceeded threshold' }));
    return summary;
  } catch (err) {
    logger.error('Sync run crashed — watermark NOT advanced', { error: err.message, stack: err.stack });
    syncState.recordRun(
      { startedAt: until, finishedAt: new Date().toISOString(), ok: false, error: err.message },
      { advanceTo: null }
    );
    await notify(() => mailer.sendFailureAlert({ startedAt: until, error: err.message, window: { until } }));
    console.error(`\nFatal: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    releaseLock(config.sync.lockPath);
  }
}

/** Milliseconds until the next occurrence of `hour`:00 UTC. */
export function msUntilNextUtcHour(hour) {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function main() {
  const flag = name => process.argv.includes(`--${name}`);
  const arg = (name, fb = null) => {
    const h = process.argv.find(a => a.startsWith(`--${name}=`));
    return h ? h.split('=').slice(1).join('=') : fb;
  };

  const config = loadConfig();
  const opts = { dryRun: flag('dry-run'), sinceOverride: arg('since') };

  if (!flag('schedule')) {
    const res = await runOnce(config, opts);
    process.exit(res.ok ? 0 : 1);
  }

  // --schedule: resident loop. Production should prefer the OS scheduler invoking
  // this script once nightly — that survives reboots; this timer does not.
  const hour = config.sync.scheduleUtcHour;
  logger.info(`Sync scheduler started — daily at ${String(hour).padStart(2, '0')}:00 UTC (= 2:00 AM MST)`);
  console.log(`Scheduler active. Next run in ${(msUntilNextUtcHour(hour) / 3600000).toFixed(1)}h. Ctrl+C to stop.`);
  for (;;) {
    await new Promise(r => setTimeout(r, msUntilNextUtcHour(hour)));
    try { await runOnce(config, opts); }
    catch (e) { logger.error('Scheduled run threw', { error: e.message }); }
  }
}

// Only auto-run when invoked directly (so tests can import runOnce/resolveWindow).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(err => {
    logger.error('sync-runner fatal', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}
