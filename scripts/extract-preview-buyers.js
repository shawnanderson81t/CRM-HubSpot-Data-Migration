/**
 * Extract Preview Buyers from GHL via POST /contacts/search with date-range chunking.
 *
 * Strategy: GHL's search API caps at 100 pages (10,000 contacts) per query.
 * `phase-preview-buyer` has ~31K contacts, so we chunk by month (dateAdded).
 * Each monthly window stays well under 10K, giving us full coverage.
 *
 * Filters applied per window:
 *   tag = phase-preview-buyer  AND  dateAdded >= windowStart  AND  dateAdded < windowEnd
 *
 * If Andy confirms additional preview tags should be included, add them
 * to BUYER_TAGS and re-run — the script will make a separate pass per tag
 * and deduplicate by contact ID.
 *
 * Resilience:
 *   - Retries 429, 502, 503, 504, SSL/network errors with exponential backoff
 *   - Checkpoints after each completed month — resume skips done windows
 *   - --resume flag loads checkpoint and continues
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
 * Tags to extract — one pass per tag, results merged and deduped.
 * Add additional preview tags here if Andy confirms expanded Tier 2 scope.
 */
const BUYER_TAGS = ['phase-preview-buyer'];

const PAGE_LIMIT      = 100;
const WINDOW_START_YR = 2020;
const RETRYABLE       = new Set([429, 502, 503, 504]);
const sleep           = ms => new Promise(r => setTimeout(r, ms));

// ── Date window generator ─────────────────────────────────────────────────────

/**
 * Generate monthly ISO date windows from startYear-01 through current month.
 * @returns {Array<{ label: string, start: string, end: string }>}
 */
function monthlyWindows() {
  const windows = [];
  const now     = new Date();
  let year  = WINDOW_START_YR;
  let month = 1;

  while (year < now.getFullYear() || (year === now.getFullYear() && month <= now.getMonth() + 1)) {
    const gte    = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const nextMo = month === 12 ? 1 : month + 1;
    const nextYr = month === 12 ? year + 1 : year;
    // lte = last millisecond of the month (one ms before start of next month)
    const lte    = new Date(Date.UTC(nextYr, nextMo - 1, 1) - 1).toISOString();
    windows.push({ label: `${year}-${String(month).padStart(2, '0')}`, gte, lte });
    month = nextMo;
    year  = nextYr;
  }
  return windows;
}

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

async function searchPage(client, locationId, tag, window, page, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await client.post('/contacts/search', {
        locationId,
        filters: [
          { field: 'tags',      operator: 'contains', value: tag },
          { field: 'dateAdded', operator: 'range',    value: { gte: window.gte, lte: window.lte } },
        ],
        pageLimit: PAGE_LIMIT,
        page,
      });
      return { contacts: res.data?.contacts ?? [], total: res.data?.total ?? 0 };
    } catch (err) {
      const status      = err.response?.status;
      const isRetryable = RETRYABLE.has(status) || !status;
      if (isRetryable && attempt < retries) {
        const delay = 2000 * attempt;
        logger.warn(`GHL ${status ?? 'network'} tag=${tag} window=${window.label} page=${page} — retry ${attempt} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`search tag=${tag} window=${window.label} page=${page} failed: ${err.message}`);
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

  const windows = monthlyWindows();

  console.log(`\n=== GHL Extract — Preview Buyers (tag search + monthly date chunks) ===`);
  console.log(`  Tags     : ${BUYER_TAGS.join(', ')}`);
  console.log(`  Windows  : ${windows.length} monthly windows (${windows[0].label} → ${windows.at(-1).label})`);
  console.log(`  Resume   : ${RESUME ? 'YES — loading checkpoint' : 'no'}\n`);

  // contactMap: id → contact  (dedup across all windows and tags)
  const contactMap   = new Map();
  let doneWindows    = new Set();
  let windowStats    = {};

  if (RESUME) {
    const cp = loadCheckpoint();
    if (cp) {
      for (const [id, contact] of Object.entries(cp.contacts ?? {})) contactMap.set(id, contact);
      doneWindows = new Set(cp.doneWindows ?? []);
      windowStats = cp.windowStats ?? {};
      console.log(`  Resumed: ${contactMap.size} contacts, ${doneWindows.size} windows already done\n`);
    } else {
      console.log('  No checkpoint found — starting fresh\n');
    }
  }

  logger.info(`extract-pb: start — tags=${BUYER_TAGS}, windows=${windows.length}, resume=${RESUME}, already=${contactMap.size}`);

  const startTime = Date.now();

  for (const tag of BUYER_TAGS) {
    console.log(`\n  Tag: [${tag}]`);

    for (const window of windows) {
      const key = `${tag}::${window.label}`;
      if (doneWindows.has(key)) continue;

      let page          = 1;
      let windowCount   = 0;
      let total         = null;

      while (true) {
        const { contacts, total: t } = await searchPage(client, config.ghl.locationId, tag, window, page);

        if (total === null) total = t;

        for (const contact of contacts) {
          if (!contactMap.has(contact.id)) contactMap.set(contact.id, contact);
          windowCount++;
        }

        process.stdout.write(
          `\r    ${window.label} | page ${page} | window: ${windowCount}/${total} | unique total: ${contactMap.size}  `
        );

        if (contacts.length < PAGE_LIMIT) break;

        if (page >= 100) {
          logger.warn(`extract-pb: window ${window.label} hit 100-page cap with ${windowCount} contacts — consider narrower chunks`);
          break;
        }

        page++;
        await sleep(150);
      }

      if (total > 0) process.stdout.write('\n');

      doneWindows.add(key);
      windowStats[key] = { total, collected: windowCount };

      saveCheckpoint({
        doneWindows: [...doneWindows],
        windowStats,
        contacts: Object.fromEntries(contactMap),
      });
    }
  }

  const elapsed  = ((Date.now() - startTime) / 1000).toFixed(1);
  const contacts = [...contactMap.values()];

  console.log(`\n  Done in ${elapsed}s`);
  console.log(`  Unique contacts collected: ${contacts.length}`);

  if (contacts.length === 0) {
    console.log('  No contacts found. Check tag name and API key.');
    process.exit(0);
  }

  // Build report
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
    strategy: 'contacts-search-api-monthly-date-chunks',
    tags: BUYER_TAGS,
    windowCount: windows.length,
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
