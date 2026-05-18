/**
 * Extract Preview Buyers from GHL via POST /contacts/search (tag filter).
 *
 * Strategy: use GHL's search endpoint to fetch contacts by tag directly,
 * avoiding the two known GHL API limitations:
 *   - GET /contacts/ cursor caps at ~100K records
 *   - GET /opportunities/search caps at ~10K results per status
 *
 * POST /contacts/search supports tag filtering with page-based pagination.
 * Multiple filters are ANDed — so we run one search per preview tag and
 * merge results (dedup by contact ID).
 *
 * Preview tags searched (OR across separate calls):
 *   pna                        Preview Non-Attendee (short alias)
 *   phase_preview-non-attendee Preview Non-Attendee
 *   phase_preview-reg          Preview Registrant
 *   phase_preview-attendee     Preview Attendee
 *   phase-preview-buyer        Preview Buyer (paid)
 *
 * Resilience:
 *   - Retries 429, 502, 503, 504, SSL/network errors with exponential backoff
 *   - Checkpoints after each tag completes
 *   - --resume flag skips already-completed tags
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
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
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
const CP_FILE         = join(CHECKPOINTS_DIR, 'extract-pb.json');

const RESUME = process.argv.includes('--resume');

/**
 * Preview tags — searched individually (GHL AND-s multiple filters).
 * Order: most common first to collect the bulk quickly.
 */
const PREVIEW_TAGS = [
  'pna',
  'phase_preview-non-attendee',
  'phase_preview-reg',
  'phase_preview-attendee',
  'phase-preview-buyer',
];

const PAGE_LIMIT  = 100;
const RETRYABLE   = new Set([429, 502, 503, 504]);
const sleep       = ms => new Promise(r => setTimeout(r, ms));

// ── Checkpoint helpers ────────────────────────────────────────────────────────

function saveCheckpoint(state) {
  mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  writeFileSync(CP_FILE, JSON.stringify(state));
}

function loadCheckpoint() {
  if (!existsSync(CP_FILE)) return null;
  try { return JSON.parse(readFileSync(CP_FILE, 'utf-8')); } catch { return null; }
}

function clearCheckpoint() {
  try { unlinkSync(CP_FILE); } catch {}
}

// ── Search with retry ─────────────────────────────────────────────────────────

/**
 * @param {Object} client - axios instance
 * @param {string} locationId
 * @param {string} tag - single tag to search for
 * @param {number} page - 1-based page number
 * @returns {Promise<{ contacts: Array, total: number }>}
 */
async function searchByTag(client, locationId, tag, page, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await client.post('/contacts/search', {
        locationId,
        filters: [{ field: 'tags', operator: 'contains', value: tag }],
        pageLimit: PAGE_LIMIT,
        page,
      });
      return { contacts: res.data?.contacts ?? [], total: res.data?.total ?? 0 };
    } catch (err) {
      const status      = err.response?.status;
      const isRetryable = RETRYABLE.has(status) || !status;
      if (isRetryable && attempt < retries) {
        const delay = 2000 * attempt;
        logger.warn(`GHL ${status ?? 'SSL/network'} on tag=${tag} page=${page} — retry ${attempt}/${retries - 1} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`search tag=${tag} page=${page} failed: ${err.message}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();

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

  console.log(`\n=== GHL Extract — Preview Buyers (POST /contacts/search) ===`);
  console.log(`  Strategy : per-tag search with page pagination`);
  console.log(`  Tags     : ${PREVIEW_TAGS.join(', ')}`);
  console.log(`  Resume   : ${RESUME ? 'YES — loading checkpoint' : 'no'}\n`);

  // contactMap: id → contact (dedup across tags)
  const contactMap    = new Map();
  let completedTags   = [];
  let tagStats        = {};

  if (RESUME) {
    const cp = loadCheckpoint();
    if (cp) {
      for (const [id, contact] of Object.entries(cp.contacts ?? {})) contactMap.set(id, contact);
      completedTags = cp.completedTags ?? [];
      tagStats      = cp.tagStats ?? {};
      console.log(`  Resumed: ${contactMap.size} contacts loaded, tags done: [${completedTags.join(', ')}]\n`);
    } else {
      console.log('  No checkpoint found — starting fresh\n');
    }
  }

  logger.info(`extract-pb: start — resume=${RESUME}, already=${contactMap.size}`);

  const startTime = Date.now();

  for (const tag of PREVIEW_TAGS) {
    if (completedTags.includes(tag)) {
      console.log(`  [${tag}] — skipped (already done)`);
      continue;
    }

    process.stdout.write(`  [${tag}] fetching...`);
    let page         = 1;
    let tagCollected = 0;
    let total        = null;

    while (true) {
      const { contacts, total: t } = await searchByTag(client, config.ghl.locationId, tag, page);

      if (total === null) {
        total = t;
        process.stdout.write(` total=${total}\n`);
      }

      for (const contact of contacts) {
        if (!contactMap.has(contact.id)) contactMap.set(contact.id, contact);
        tagCollected++;
      }

      process.stdout.write(
        `\r  [${tag}] page ${page} — tag contacts: ${tagCollected}/${total} | unique total: ${contactMap.size}  `
      );

      if (contacts.length < PAGE_LIMIT) break;
      page++;

      await sleep(200);
    }

    console.log();
    tagStats[tag] = { total, collected: tagCollected };
    completedTags.push(tag);

    saveCheckpoint({
      completedTags,
      tagStats,
      contacts: Object.fromEntries(contactMap),
    });

    logger.info(`extract-pb tag=${tag}: total=${total}, collected=${tagCollected}, unique=${contactMap.size}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const contacts = [...contactMap.values()];

  console.log(`\n  Done in ${elapsed}s`);
  console.log(`  Unique contacts collected: ${contacts.length}`);

  if (contacts.length === 0) {
    console.log('  No contacts found. Check tag names and API key.');
    process.exit(0);
  }

  const tagCounts = {};
  for (const c of contacts) {
    for (const t of c.tags ?? []) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  }
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([tag, count]) => ({ tag, count }));

  const sample = contacts.slice(0, 5).map(c => ({
    id: c.id,
    name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
    tags: (c.tags ?? []).slice(0, 5),
  }));

  const report = {
    timestamp: new Date().toISOString(),
    strategy: 'contacts-search-api-per-tag',
    tags: PREVIEW_TAGS,
    tagStats,
    results: { contactsCollected: contacts.length, elapsedSeconds: parseFloat(elapsed) },
    sample,
    topTags,
  };

  mkdirSync(SAMPLES_DIR, { recursive: true });
  writeFileSync(join(SAMPLES_DIR, 'preview-buyers.json'), JSON.stringify(contacts, null, 2));

  mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(REPORTS_DIR, `extract-pb-${timestamp}.json`), JSON.stringify(report, null, 2));

  clearCheckpoint();

  console.log(`\n=== Summary ===`);
  console.log(`  Tag breakdown:`);
  for (const [t, s] of Object.entries(tagStats)) {
    console.log(`    ${t.padEnd(35)} total=${s.total}  collected=${s.collected}`);
  }
  console.log(`  Unique contacts : ${contacts.length}`);
  console.log(`  Elapsed         : ${elapsed}s`);
  console.log(`\n  Output : data/samples/preview-buyers.json`);
  console.log(`  Report : data/reports/extract-pb-${timestamp}.json`);

  if (sample.length > 0) {
    console.log(`\n  Sample (first 5):`);
    for (const s of sample) console.log(`    ${s.id}  ${s.name.padEnd(30)}  ${s.tags.join(', ')}`);
  }

  logger.info('extract-preview-buyers complete', { collected: contacts.length, elapsed });
}

main().catch(err => {
  logger.error('extract-preview-buyers failed', { error: err.message });
  console.error('\nFatal:', err.message);
  console.error('Run with --resume to continue from last checkpoint.');
  process.exit(1);
});
