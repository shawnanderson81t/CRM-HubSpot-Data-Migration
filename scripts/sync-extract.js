/**
 * sync-extract.js — pull the GHL contact delta (everything changed since a given
 * point) and stream it to an NDJSON file for the nightly sync to consume.
 *
 * This is the extraction half of the daily sync (Phase 2). It uses
 * GHLClient.getContactsChangedSince(), which filters POST /contacts/search on
 * `dateUpdated` and adaptively chunks the window to stay under GHL's 10K/query
 * cap — so the same script handles a 1-day nightly delta or a multi-week backfill.
 *
 * READ-ONLY against production: it only reads from GHL and writes LOCAL files.
 * It does NOT load anything into HubSpot, and it does NOT advance the sync
 * watermark — `lastSyncAt` is only ever moved forward by the end-to-end runner
 * after a successful upsert (Phase 4). Running this is always safe to repeat.
 *
 * Window resolution (first match wins):
 *   1. --since=<ISO>            explicit lower bound
 *   2. --hours=<N>              last N hours (from --until / now)
 *   3. data/sync-state.json     { "lastSyncAt": "<ISO>" } if present
 *   4. default                  last 24 hours
 * Upper bound is --until=<ISO> or now (captured once at start).
 *
 * Usage (on the US remote, after fetch/reset):
 *   node scripts/sync-extract.js                       # last 24h (or lastSyncAt)
 *   node scripts/sync-extract.js --hours=48
 *   node scripts/sync-extract.js --since=2026-05-23T00:00:00Z   # backfill window
 *   node scripts/sync-extract.js --dry-run             # count only, write nothing
 *   node scripts/sync-extract.js --exclude-tags=hs-to-hl,hs-transfer
 *
 * Output:
 *   data/sync/delta-[ts].ndjson              one changed contact per line
 *   data/reports/sync-extract-[ts].json      run summary (window, counts, sample)
 */

import dotenv from 'dotenv';
import { createWriteStream, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GHLClient } from '../src/extract/ghlClient.js';
import { loadConfig } from '../src/utils/config.js';
import { logger } from '../src/utils/logger.js';

dotenv.config();

const __dirname    = dirname(fileURLToPath(import.meta.url));
const SYNC_DIR     = join(__dirname, '../data/sync');
const REPORTS_DIR  = join(__dirname, '../data/reports');
const STATE_FILE   = join(__dirname, '../data/sync-state.json');

/** Reverse-sync loop guard — contacts written back into GHL from HubSpot carry these. */
const DEFAULT_EXCLUDE_TAGS = ['hs-to-hl', 'hs-transfer'];

/** Read a `--name=value` CLI arg. */
function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}
const flag = name => process.argv.includes(`--${name}`);

/** Read lastSyncAt from data/sync-state.json, or null if absent/unreadable. */
function readLastSyncAt() {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))?.lastSyncAt ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the [since, until] extraction window from CLI args / sync-state / defaults.
 * @returns {{ since: string, until: string, source: string }}
 */
function resolveWindow() {
  const until = arg('until') ? new Date(arg('until')).toISOString() : new Date().toISOString();

  const sinceArg = arg('since');
  if (sinceArg) return { since: new Date(sinceArg).toISOString(), until, source: '--since' };

  const hoursArg = arg('hours');
  if (hoursArg) {
    const h = Math.max(1, parseFloat(hoursArg));
    return { since: new Date(Date.parse(until) - h * 3600 * 1000).toISOString(), until, source: `--hours=${h}` };
  }

  const lastSyncAt = readLastSyncAt();
  if (lastSyncAt) return { since: new Date(lastSyncAt).toISOString(), until, source: 'sync-state.json lastSyncAt' };

  return { since: new Date(Date.parse(until) - 24 * 3600 * 1000).toISOString(), until, source: 'default last 24h' };
}

async function main() {
  const config  = loadConfig();
  const dryRun  = flag('dry-run');
  const { since, until, source } = resolveWindow();
  const excludeTags = (arg('exclude-tags') ?? DEFAULT_EXCLUDE_TAGS.join(','))
    .split(',').map(t => t.trim()).filter(Boolean);

  console.log('\n=== GHL Sync Extract (delta by dateUpdated) ===');
  console.log(`  Window      : ${since}  →  ${until}`);
  console.log(`  Window src  : ${source}`);
  console.log(`  Exclude tags: [${excludeTags.join(', ')}]`);
  console.log(`  Mode        : ${dryRun ? 'DRY RUN (no files written)' : 'write NDJSON + report'}\n`);

  const ghl = new GHLClient({ apiKey: config.ghl.apiKey, locationId: config.ghl.locationId });

  const ts       = new Date().toISOString().replace(/[:.]/g, '-');
  const deltaPath = join(SYNC_DIR, `delta-${ts}.ndjson`);

  let stream = null;
  let written = 0;
  if (!dryRun) {
    mkdirSync(SYNC_DIR, { recursive: true });
    stream = createWriteStream(deltaPath, { encoding: 'utf-8' });
  }

  const sample = [];
  const startedAt = Date.now();

  // Stream each page straight to disk — memory stays flat even for a big backfill.
  const onBatch = async (contacts) => {
    for (const c of contacts) {
      if (stream) stream.write(JSON.stringify(c) + '\n');
      if (sample.length < 5) {
        sample.push({
          id: c.id,
          name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
          dateAdded: c.dateAdded ?? null,
          dateUpdated: c.dateUpdated ?? null,
        });
      }
      written++;
    }
  };

  const onProgress = ({ collected, scanned }) => {
    process.stdout.write(`\r  collected ${collected} changed contacts (scanned ${scanned} rows)   `);
  };

  let total;
  try {
    const changed = await ghl.getContactsChangedSince(since, { until, excludeTags, onBatch, onProgress });
    total = changed.length;
  } catch (err) {
    if (stream) stream.end();
    logger.error('sync-extract failed', { error: err.message, since, until });
    console.error(`\n\nFatal: ${err.message}`);
    process.exit(1);
  }

  if (stream) await new Promise(res => stream.end(res));

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write('\n');

  const report = {
    timestamp: new Date().toISOString(),
    window: { since, until, source },
    excludeTags,
    dryRun,
    results: { changedContacts: total, rowsWritten: written, elapsedSeconds: parseFloat(elapsed) },
    // The watermark a successful end-to-end run would advance lastSyncAt to.
    // NOT written to sync-state.json here — extraction must not move the watermark.
    proposedNextSyncAt: until,
    deltaFile: dryRun ? null : deltaPath,
    sample,
  };

  if (!dryRun) {
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(join(REPORTS_DIR, `sync-extract-${ts}.json`), JSON.stringify(report, null, 2));
  }

  console.log('\n=== Summary ===');
  console.log(`  Changed contacts : ${total}`);
  console.log(`  Elapsed          : ${elapsed}s`);
  if (!dryRun) {
    console.log(`  Delta NDJSON     : ${deltaPath}`);
    console.log(`  Report           : ${join(REPORTS_DIR, `sync-extract-${ts}.json`)}`);
  }
  console.log(`  Proposed lastSyncAt (NOT committed): ${until}`);
  if (sample.length) {
    console.log('\n  Sample (first 5):');
    for (const s of sample) {
      console.log(`    ${String(s.id).padEnd(26)} ${(s.name || '(no name)').padEnd(28)} updated=${s.dateUpdated}`);
    }
  }
  console.log('');

  logger.info('sync-extract complete', { changed: total, elapsed, since, until, dryRun });
}

main().catch(err => {
  logger.error('sync-extract crashed', { error: err.message });
  console.error('\nFatal:', err.message);
  process.exit(1);
});
