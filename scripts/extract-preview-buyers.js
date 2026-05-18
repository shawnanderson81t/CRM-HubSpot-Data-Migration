/**
 * Extract Preview Buyers from GHL via the contacts API (cursor-based pagination).
 *
 * Strategy: scan all GHL contacts using the same cursor approach as Tier 3.
 * Include contacts that carry any preview buyer-tier tag. The pipeline-based
 * approach (opportunities search) is capped at ~10K results per status by
 * the GHL API, making it unsuitable for the 734K-opp Preview Registrants
 * pipeline. Cursor pagination has no such limit.
 *
 * Include filter — contact must have at least one of:
 *   phase-preview-buyer        Preview Buyer (paid)
 *   phase_preview-attendee     Preview Attendee
 *   phase_preview-reg          Preview Registrant
 *   phase_preview-non-attendee Preview Non-Attendee
 *   pna                        Preview Non-Attendee (short alias)
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
import { logger } from '../src/utils/logger.js';
import axios from 'axios';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR     = join(__dirname, '../data/samples');
const REPORTS_DIR     = join(__dirname, '../data/reports');
const CHECKPOINTS_DIR = join(__dirname, '../data/checkpoints');
const CP_POS_FILE     = join(CHECKPOINTS_DIR, 'extract-pb.json');
const CP_DATA_FILE    = join(CHECKPOINTS_DIR, 'extract-pb-contacts.ndjson');

const TARGET_COUNT     = parseInt(process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '900000');
const RESUME           = process.argv.includes('--resume');
const CHECKPOINT_EVERY = 500;

/** Tags that identify a contact as a Preview Buyer for Tier 2. */
const PREVIEW_TAGS = new Set([
  'phase-preview-buyer',
  'phase_preview-attendee',
  'phase_preview-reg',
  'phase_preview-non-attendee',
  'pna',
]);

const isPreviewContact = tags => (tags ?? []).some(t => PREVIEW_TAGS.has(t));

const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep     = ms => new Promise(r => setTimeout(r, ms));

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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();

  console.log(`\n=== GHL Extract — Preview Buyers (contacts API cursor) ===`);
  console.log(`  Strategy : cursor-based contact pagination (no page cap)`);
  console.log(`  Include  : contacts with any preview buyer-tier tag`);
  console.log(`  Tags     : ${[...PREVIEW_TAGS].join(', ')}`);
  console.log(`  Resume   : ${RESUME ? 'YES — loading checkpoint' : 'no'}\n`);

  const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
  const GHL_VERSION  = process.env.GHL_VERSION  || '2021-07-28';

  const client = axios.create({
    baseURL: GHL_BASE_URL,
    headers: {
      Authorization: `Bearer ${config.ghl.apiKey}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
  });

  let collected    = [];
  let startAfterId = null;
  let page         = 1;
  let scanned      = 0;
  let skipped      = 0;
  let savedCount   = 0;

  if (RESUME) {
    const cp = loadCheckpoint();
    if (cp) {
      collected    = cp.collected;
      startAfterId = cp.startAfterId ?? null;
      page         = cp.page ?? 1;
      scanned      = cp.scanned ?? 0;
      skipped      = cp.skipped ?? 0;
      savedCount   = collected.length;
      console.log(`  Resumed: ${collected.length} contacts already saved. Continuing from page ${page} (cursor: ${startAfterId ?? 'start'})\n`);
    } else {
      console.log('  No checkpoint found — starting fresh\n');
    }
  }

  logger.info(`extract-pb: start — target=${TARGET_COUNT}, resume=${RESUME}, already=${collected.length}`);

  const startTime = Date.now();

  while (collected.length < TARGET_COUNT) {
    const params = { locationId: config.ghl.locationId, limit: 100 };
    if (startAfterId) params.startAfterId = startAfterId;

    let response;
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        response = await client.get('/contacts/', { params });
        break;
      } catch (err) {
        const status      = err.response?.status;
        const isRetryable = RETRYABLE.has(status) || !status;
        if (isRetryable && attempt <= 6) {
          const delay = 2000 * attempt;
          logger.warn(`GHL ${status ?? 'SSL/network'} error on page ${page} — retry ${attempt} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw new Error(`Contacts page ${page} failed: ${err.message}`);
      }
    }

    const contacts = response.data?.contacts ?? [];
    const meta     = response.data?.meta ?? {};
    scanned       += contacts.length;

    if (contacts.length === 0) break;

    for (const contact of contacts) {
      if (collected.length >= TARGET_COUNT) break;
      if (!isPreviewContact(contact.tags)) {
        skipped++;
        continue;
      }
      collected.push(contact);
    }

    process.stdout.write(
      `\r  Scanned: ${scanned} | Skipped: ${skipped} | Collected: ${collected.length} | Page: ${page}  `
    );

    if (collected.length - savedCount >= CHECKPOINT_EVERY) {
      appendContactsToCheckpoint(collected.slice(savedCount));
      savedCount = collected.length;
      saveCheckpoint({ startAfterId, page, scanned, skipped });
    }

    if (scanned % 10000 === 0) {
      logger.info(`extract-pb page ${page}: scanned=${scanned}, skipped=${skipped}, collected=${collected.length}`);
    }

    startAfterId = meta.startAfterId ?? null;
    if (!startAfterId || contacts.length < 100) break;
    page++;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n  Done in ${elapsed}s`);

  if (collected.length === 0) {
    console.log('  No preview contacts found. Check tag filter and API key.');
    process.exit(0);
  }

  const tagCounts = {};
  for (const contact of collected) {
    for (const tag of contact.tags ?? []) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  }
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([tag, count]) => ({ tag, count }));

  const sample = collected.slice(0, 5).map(c => ({
    id: c.id,
    name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
    tags: (c.tags ?? []).slice(0, 5),
  }));

  const unique = [...new Map(collected.map(c => [c.id, c])).values()];
  if (unique.length !== collected.length) {
    logger.warn(`Dedup: removed ${collected.length - unique.length} duplicate contacts before writing`);
    console.log(`  ⚠ Removed ${collected.length - unique.length} duplicates (cursor pagination overlap)`);
  }

  const report = {
    timestamp: new Date().toISOString(),
    strategy: 'contacts-api-cursor-pagination',
    includeFilter: [...PREVIEW_TAGS],
    config: { targetCount: TARGET_COUNT },
    results: {
      pagesScanned: page,
      contactsScanned: scanned,
      nonPreviewSkipped: skipped,
      contactsCollected: unique.length,
      duplicatesRemoved: collected.length - unique.length,
      elapsedSeconds: parseFloat(elapsed),
    },
    sample,
    topTags,
  };

  mkdirSync(SAMPLES_DIR, { recursive: true });
  writeFileSync(join(SAMPLES_DIR, 'preview-buyers.json'), JSON.stringify(unique, null, 2));

  mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `extract-pb-${timestamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  clearCheckpoint();

  console.log(`=== Summary ===`);
  console.log(`  Pages scanned        : ${page}`);
  console.log(`  Contacts scanned     : ${scanned}`);
  console.log(`  Non-preview skipped  : ${skipped}`);
  console.log(`  Contacts collected   : ${unique.length} (${collected.length - unique.length} duplicates removed)`);
  console.log(`  Elapsed              : ${elapsed}s`);
  console.log(`\n  Output : data/samples/preview-buyers.json`);
  console.log(`  Report : data/reports/extract-pb-${timestamp}.json`);

  if (sample.length > 0) {
    console.log(`\n  Sample (first 5):`);
    for (const s of sample) console.log(`    ${s.id}  ${s.name.padEnd(30)}  ${s.tags.join(', ')}`);
  }

  logger.info('extract-preview-buyers complete', { collected: unique.length, skipped, elapsed });
}

main().catch(err => {
  logger.error('extract-preview-buyers failed', { error: err.message });
  console.error('\nFatal:', err.message);
  console.error('Run with --resume to continue from last checkpoint.');
  process.exit(1);
});
