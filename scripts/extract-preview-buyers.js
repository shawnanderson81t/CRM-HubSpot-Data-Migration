/**
 * Extract Preview Buyers from GHL via the Preview Registrants pipeline.
 *
 * Strategy: same as extract-workshop-buyers — paginate the Preview pipeline
 * opportunities across all statuses (open/won/lost/abandoned), collect unique
 * contact IDs, fetch each contact individually. No tag filter — all contacts
 * in the pipeline are included per Andy's instruction.
 *
 * Preview pipeline ID: yZ49CJBYdHhC0IEIe9Cs ("1 - Preview Registrants")
 *
 * Resilience:
 *   - Retries 429, 502, 503, 504, SSL/network errors with exponential backoff
 *   - Checkpoints every 500 contacts to data/checkpoints/extract-pb.*
 *   - --resume flag resumes from last checkpoint — no data lost on crash
 *
 * Usage:
 *   node scripts/extract-preview-buyers.js
 *   node scripts/extract-preview-buyers.js --resume
 *   npm run extract:pb
 *   npm run extract:pb:resume
 *
 * Output:
 *   data/samples/preview-buyers.json        — contact records
 *   data/reports/extract-pb-[ts].json       — run report
 */

import dotenv from 'dotenv';
import { writeFileSync, readFileSync, mkdirSync, appendFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../src/utils/config.js';
import { GHLClient } from '../src/extract/ghlClient.js';
import { logger } from '../src/utils/logger.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR     = join(__dirname, '../data/samples');
const REPORTS_DIR     = join(__dirname, '../data/reports');
const CHECKPOINTS_DIR = join(__dirname, '../data/checkpoints');
const CP_POS_FILE     = join(CHECKPOINTS_DIR, 'extract-pb.json');
const CP_DATA_FILE    = join(CHECKPOINTS_DIR, 'extract-pb-contacts.ndjson');

const PREVIEW_PIPELINE_ID = 'yZ49CJBYdHhC0IEIe9Cs';
const OPP_STATUSES        = ['open', 'won', 'lost', 'abandoned'];
const TARGET_COUNT        = parseInt(process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '50000');
const RESUME              = process.argv.includes('--resume');
const CHECKPOINT_EVERY    = 500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Checkpoint helpers ────────────────────────────────────────────────────────

function saveCheckpoint(pos) {
  mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  writeFileSync(CP_POS_FILE, JSON.stringify(pos));
}

function appendContactsToCheckpoint(contacts) {
  mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  appendFileSync(CP_DATA_FILE, contacts.map(c => JSON.stringify(c)).join('\n') + '\n');
}

function loadCheckpoint() {
  if (!existsSync(CP_POS_FILE)) return null;
  try {
    const pos       = JSON.parse(readFileSync(CP_POS_FILE, 'utf-8'));
    const collected = existsSync(CP_DATA_FILE)
      ? readFileSync(CP_DATA_FILE, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    return { ...pos, collected };
  } catch {
    return null;
  }
}

function clearCheckpoint() {
  try { unlinkSync(CP_POS_FILE); } catch {}
  try { unlinkSync(CP_DATA_FILE); } catch {}
}

// ── Retry helpers ─────────────────────────────────────────────────────────────

const RETRYABLE = new Set([429, 502, 503, 504]);

async function fetchOppsPage(client, params, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await client.get('/opportunities/search', { params });
    } catch (err) {
      const status = err.response?.status;
      if (status === 400) return { data: { opportunities: [] } };
      const isRetryable = RETRYABLE.has(status) || !status;
      if (isRetryable && attempt < retries) {
        const delay = 2000 * attempt;
        logger.warn(`GHL ${status ?? 'SSL/network'} error on opps page ${params.page} [${params.status}] — retry ${attempt}/${retries - 1} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Opportunities page ${params.page} [${params.status}] failed: ${err.message}`);
    }
  }
}

async function fetchContactWithRetry(ghl, id, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await ghl.getContact(id);
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = RETRYABLE.has(status) || !status;
      if (isRetryable && attempt < retries) {
        const delay = 2000 * attempt;
        logger.warn(`GHL ${status ?? 'SSL/network'} fetching contact ${id} — retry ${attempt}/${retries - 1} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const config = loadConfig();
  const ghl    = new GHLClient(config.ghl);
  const client = ghl._getClient();

  console.log(`\n=== GHL Extract — Preview Buyers via Pipeline (all statuses) ===`);
  console.log(`  Pipeline : ${PREVIEW_PIPELINE_ID} (1 - Preview Registrants)`);
  console.log(`  Statuses : ${OPP_STATUSES.join(', ')}`);
  console.log(`  Filter   : none (all pipeline contacts)`);
  console.log(`  Target   : up to ${TARGET_COUNT} contacts`);
  console.log(`  Resume   : ${RESUME ? 'YES — loading checkpoint' : 'no'}\n`);

  let contacts        = [];
  let seenIds         = new Set();
  let startStatusIdx  = 0;
  let startPage       = 1;
  let oppScanned      = 0;
  let contactsFetched = 0;
  let fetchErrors     = 0;
  let savedCount      = 0;

  if (RESUME) {
    const cp = loadCheckpoint();
    if (cp) {
      contacts        = cp.collected;
      seenIds         = new Set(cp.seenIds ?? []);
      startStatusIdx  = cp.statusIndex ?? 0;
      startPage       = cp.page ?? 1;
      oppScanned      = cp.oppScanned ?? 0;
      contactsFetched = cp.contactsFetched ?? contacts.length;
      fetchErrors     = cp.fetchErrors ?? 0;
      savedCount      = contacts.length;
      console.log(`  Resumed: ${contacts.length} contacts already saved. Continuing from [${OPP_STATUSES[startStatusIdx]}] page ${startPage}\n`);
    } else {
      console.log('  No checkpoint found — starting fresh\n');
    }
  }

  logger.info(`extract-pb: start — target=${TARGET_COUNT}, resume=${RESUME}, already=${contacts.length}`);

  const startTime = Date.now();

  for (let si = startStatusIdx; si < OPP_STATUSES.length; si++) {
    const status = OPP_STATUSES[si];
    if (contacts.length >= TARGET_COUNT) break;

    console.log(`\n  [status: ${status}]`);
    let page = (si === startStatusIdx && RESUME) ? startPage : 1;

    while (contacts.length < TARGET_COUNT) {
      const params = {
        location_id: config.ghl.locationId,
        pipeline_id: PREVIEW_PIPELINE_ID,
        status,
        limit: 100,
        page,
      };

      const response      = await fetchOppsPage(client, params);
      const opportunities = response.data?.opportunities ?? [];
      oppScanned          += opportunities.length;

      if (opportunities.length === 0) break;

      const ids = opportunities
        .map(o => o.contactId)
        .filter(id => id && !seenIds.has(id));
      ids.forEach(id => seenIds.add(id));

      for (const id of ids) {
        if (contacts.length >= TARGET_COUNT) break;
        try {
          const contact = await fetchContactWithRetry(ghl, id);
          contactsFetched++;
          contacts.push(contact);
        } catch (err) {
          logger.warn(`skip contact ${id}: ${err.message}`);
          fetchErrors++;
        }

        process.stdout.write(
          `\r  Opps scanned: ${oppScanned} | Fetched: ${contactsFetched} | Collected: ${contacts.length} | Page: ${page} [${status}]  `
        );

        if (contacts.length - savedCount >= CHECKPOINT_EVERY) {
          appendContactsToCheckpoint(contacts.slice(savedCount));
          savedCount = contacts.length;
          saveCheckpoint({ statusIndex: si, page, oppScanned, contactsFetched, fetchErrors, seenIds: [...seenIds] });
        }

        await sleep(150);
      }

      logger.info(`extract-pb [${status}] page ${page}: opps=${oppScanned}, fetched=${contactsFetched}, collected=${contacts.length}`);

      if (opportunities.length < 100) break;
      page++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n  Done in ${elapsed}s`);

  if (contacts.length === 0) {
    console.log('  No contacts found. Check pipeline ID.');
    process.exit(0);
  }

  const tagCounts = {};
  for (const contact of contacts) {
    for (const tag of contact.tags ?? []) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  }
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([tag, count]) => ({ tag, count }));

  const fieldCoverage = {};
  for (const contact of contacts) {
    for (const key of Object.keys(contact)) {
      if (contact[key] !== null && contact[key] !== undefined && contact[key] !== '') {
        fieldCoverage[key] = (fieldCoverage[key] ?? 0) + 1;
      }
    }
  }
  const coveragePct = Object.fromEntries(
    Object.entries(fieldCoverage).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, `${Math.round((v / contacts.length) * 100)}%`])
  );

  const sample = contacts.slice(0, 5).map(c => ({
    id: c.id,
    name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
    tags: (c.tags ?? []).slice(0, 5),
  }));

  const report = {
    timestamp: new Date().toISOString(),
    strategy: 'pipeline-opportunities-all-statuses',
    pipelineId: PREVIEW_PIPELINE_ID,
    statuses: OPP_STATUSES,
    config: { targetCount: TARGET_COUNT },
    results: { opportunitiesScanned: oppScanned, contactsFetched, contactsCollected: unique.length, duplicatesRemoved: contacts.length - unique.length, fetchErrors, elapsedSeconds: parseFloat(elapsed) },
    sample,
    fieldCoverage: coveragePct,
    topTags,
  };

  const unique = [...new Map(contacts.map(c => [c.id, c])).values()];
  if (unique.length !== contacts.length) {
    logger.warn(`Dedup: removed ${contacts.length - unique.length} duplicate contacts before writing`);
    console.log(`  ⚠ Removed ${contacts.length - unique.length} duplicates (GHL pagination overlap)`);
  }

  mkdirSync(SAMPLES_DIR, { recursive: true });
  writeFileSync(join(SAMPLES_DIR, 'preview-buyers.json'), JSON.stringify(unique, null, 2));

  mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `extract-pb-${timestamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  clearCheckpoint();

  console.log(`=== Summary ===`);
  console.log(`  Opportunities scanned : ${oppScanned}`);
  console.log(`  Contacts fetched      : ${contactsFetched}`);
  console.log(`  Contacts collected    : ${unique.length} (${contacts.length - unique.length} duplicates removed)`);
  console.log(`  Fetch errors          : ${fetchErrors}`);
  console.log(`  Elapsed               : ${elapsed}s`);
  console.log(`\n  Contacts : data/samples/preview-buyers.json`);
  console.log(`  Report   : data/reports/extract-pb-${timestamp}.json`);

  if (sample.length > 0) {
    console.log(`\n  Sample (first 5):`);
    for (const s of sample) console.log(`    ${s.id}  ${s.name.padEnd(30)}  ${s.tags.join(', ')}`);
  }

  logger.info('extract-preview-buyers complete', { collected: contacts.length, fetchErrors, elapsed });
}

run().catch(err => {
  logger.error('extract-preview-buyers failed', { error: err.message });
  console.error('\nFatal:', err.message);
  console.error('Run with --resume to continue from last checkpoint.');
  process.exit(1);
});
