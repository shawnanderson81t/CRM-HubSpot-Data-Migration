/**
 * Extract all GHL registrants (Tier 3) via POST /contacts/search with weekly date-range chunking.
 *
 * Strategy: GHL's search API caps at 100 pages (10,000 contacts) per query.
 * With ~895K contacts across ~6 years, monthly windows average ~11K — too large.
 * Weekly windows average ~2,500, keeping every window safely under the 10K cap.
 *
 * Memory design:
 *   Only contact IDs are held in memory (Set<string>, ~50MB for 850K contacts).
 *   Contact objects are written immediately to an NDJSON file and never stored in RAM.
 *   Final registrants.json is stream-converted from NDJSON — no full-set stringify.
 *
 * Checkpoint design:
 *   - extract-reg.json           — small metadata (doneWindows, windowStats, cappedWindows)
 *   - extract-reg-contacts.ndjson — one contact per line, append-only
 *   Resume reads IDs from NDJSON via streaming readline (no heap pressure).
 *
 * Resilience:
 *   - Retries 429, 502, 503, 504, SSL/network errors with exponential backoff
 *   - Checkpoints after each completed week — resume skips done windows
 *   - --resume flag loads checkpoint and continues
 *   - Warns if any weekly window hits the 100-page cap (needs daily sub-chunking)
 *
 * Usage:
 *   node scripts/extract-registrants.js
 *   node scripts/extract-registrants.js --resume
 *   npm run extract:reg
 *   npm run extract:reg:resume
 *
 * Output:
 *   data/samples/registrants.json             — contact records (JSON array)
 *   data/reports/extract-reg-[ts].json        — run report
 */

import dotenv from 'dotenv';
import {
  writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync,
  appendFileSync, createWriteStream, createReadStream,
} from 'fs';
import { createInterface } from 'readline';
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
const CP_FILE         = join(CHECKPOINTS_DIR, 'extract-reg.json');
const CP_CONTACTS     = join(CHECKPOINTS_DIR, 'extract-reg-contacts.ndjson');

const RESUME = process.argv.includes('--resume');

const PAGE_LIMIT      = 100;
const WINDOW_START_YR = 2020;
const RETRYABLE       = new Set([429, 502, 503, 504]);
const sleep           = ms => new Promise(r => setTimeout(r, ms));

// ── Date window generator ─────────────────────────────────────────────────────

/**
 * Generate weekly ISO date windows from startYear-01-01 through today.
 * @returns {Array<{ label: string, gte: string, lte: string }>}
 */
function weeklyWindows() {
  const windows = [];
  const now     = new Date();
  let cursor    = new Date(Date.UTC(WINDOW_START_YR, 0, 1));

  while (cursor <= now) {
    const gte        = cursor.toISOString();
    const nextCursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000);
    const lte        = new Date(Math.min(nextCursor.getTime(), now.getTime() + 86400000) - 1).toISOString();
    const label      = cursor.toISOString().slice(0, 10);
    windows.push({ label, gte, lte });
    cursor = nextCursor;
  }

  return windows;
}

// ── Checkpoint helpers ────────────────────────────────────────────────────────

/**
 * Save window metadata + current seenIds array to checkpoint JSON.
 * 850K IDs × ~20 chars = ~17MB — safe to JSON.stringify/parse.
 * Storing IDs here means resume never needs to read the large NDJSON file.
 * @param {{ doneWindows: string[], windowStats: object, cappedWindows: string[] }} meta
 * @param {Set<string>} seenIds
 */
function saveCheckpoint(meta, seenIds) {
  mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  writeFileSync(CP_FILE, JSON.stringify({ ...meta, seenIds: [...seenIds] }));
}

/**
 * Append new unique contacts from a completed window to the NDJSON file.
 * Each contact is one line — no full-set stringify ever happens.
 * @param {object[]} newContacts
 */
function appendWindowContacts(newContacts) {
  if (newContacts.length === 0) return;
  mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  appendFileSync(CP_CONTACTS, newContacts.map(c => JSON.stringify(c)).join('\n') + '\n');
}

/**
 * Load checkpoint. Reads seenIds from the JSON checkpoint if present (fast, ~17MB).
 * Falls back to streaming NDJSON if seenIds missing (backward compat — needs more heap).
 * @returns {Promise<{ meta: object, seenIds: Set<string> } | null>}
 */
async function loadCheckpoint() {
  if (!existsSync(CP_FILE)) return null;
  try {
    const meta = JSON.parse(readFileSync(CP_FILE, 'utf-8'));

    // Fast path: seenIds stored in checkpoint JSON (new format)
    if (Array.isArray(meta.seenIds)) {
      return { meta, seenIds: new Set(meta.seenIds) };
    }

    // Slow path: backward compat — extract IDs from NDJSON via streaming readline
    const seenIds = new Set();
    if (existsSync(CP_CONTACTS)) {
      console.log('  (one-time: rebuilding ID index from NDJSON checkpoint — may take a minute)');
      const rl = createInterface({ input: createReadStream(CP_CONTACTS), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        const m = line.match(/"id"\s*:\s*"([^"]+)"/);
        if (m) seenIds.add(m[1]);
      }
    }
    return { meta, seenIds };
  } catch { return null; }
}

function clearCheckpoint() {
  try { unlinkSync(CP_FILE); } catch {}
  try { unlinkSync(CP_CONTACTS); } catch {}
}

// ── Search with retry ─────────────────────────────────────────────────────────

/**
 * Fetch one page of contacts for a given date window.
 * @param {import('axios').AxiosInstance} client
 * @param {string} locationId
 * @param {{ label: string, gte: string, lte: string }} window
 * @param {number} page
 * @param {number} retries
 * @returns {Promise<{ contacts: object[], total: number }>}
 */
async function searchPage(client, locationId, window, page, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await client.post('/contacts/search', {
        locationId,
        filters: [
          { field: 'dateAdded', operator: 'range', value: { gte: window.gte, lte: window.lte } },
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
        logger.warn(`GHL ${status ?? 'network'} window=${window.label} page=${page} — retry ${attempt} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`search window=${window.label} page=${page} failed: ${err.message}`);
    }
  }
}

// ── Stream NDJSON → JSON array ────────────────────────────────────────────────

/**
 * Convert the NDJSON contacts file into a valid JSON array using streaming.
 * Reads line-by-line — no full file loaded into RAM.
 * @param {string} ndjsonPath
 * @param {string} outputPath
 * @returns {Promise<number>} Number of contacts written
 */
async function ndjsonToJsonArray(ndjsonPath, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const ws  = createWriteStream(outputPath);
  const rl  = createInterface({ input: createReadStream(ndjsonPath), crlfDelay: Infinity });
  let first = true;
  let count = 0;

  ws.write('[\n');
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!first) ws.write(',\n');
    ws.write(line);
    first = false;
    count++;
  }
  ws.write('\n]\n');
  await new Promise((resolve, reject) => ws.end(err => err ? reject(err) : resolve()));
  return count;
}

// ── Build tag counts from NDJSON without loading all contacts into RAM ────────

/**
 * Stream NDJSON to build tag frequency map and collect sample contacts.
 * @param {string} ndjsonPath
 * @returns {Promise<{ topTags: object[], sample: object[] }>}
 */
async function buildReportData(ndjsonPath) {
  const tagCounts = {};
  const sample    = [];
  const rl        = createInterface({ input: createReadStream(ndjsonPath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    for (const t of c.tags ?? []) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
    if (sample.length < 5) {
      sample.push({
        id:   c.id,
        name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
        tags: (c.tags ?? []).slice(0, 5),
      });
    }
  }

  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([tag, count]) => ({ tag, count }));

  return { topTags, sample };
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

  const windows = weeklyWindows();

  console.log(`\n=== GHL Extract — All Registrants (weekly date chunks, no tag filter) ===`);
  console.log(`  Windows  : ${windows.length} weekly windows (${windows[0].label} → ${windows.at(-1).label})`);
  console.log(`  Resume   : ${RESUME ? 'YES — loading checkpoint' : 'no'}\n`);

  // Only IDs in memory — contact objects live in the NDJSON file
  const seenIds      = new Set();
  let doneWindows    = new Set();
  let windowStats    = {};
  let cappedWindows  = [];
  let totalUnique    = 0;

  if (RESUME) {
    const cp = await loadCheckpoint();
    if (cp) {
      cp.seenIds.forEach(id => seenIds.add(id));
      doneWindows   = new Set(cp.meta.doneWindows ?? []);
      windowStats   = cp.meta.windowStats ?? {};
      cappedWindows = cp.meta.cappedWindows ?? [];
      totalUnique   = seenIds.size;
      console.log(`  Resumed: ${totalUnique} contacts, ${doneWindows.size} windows already done\n`);
    } else {
      console.log('  No checkpoint found — starting fresh\n');
    }
  }

  logger.info(`extract-reg: start — windows=${windows.length}, resume=${RESUME}, already=${totalUnique}`);

  const startTime = Date.now();

  for (const window of windows) {
    if (doneWindows.has(window.label)) continue;

    let page          = 1;
    let windowCount   = 0;
    let total         = null;
    let hitCap        = false;
    const newContacts = [];

    while (true) {
      const { contacts, total: t } = await searchPage(client, config.ghl.locationId, window, page);

      if (total === null) total = t;

      for (const contact of contacts) {
        if (!seenIds.has(contact.id)) {
          seenIds.add(contact.id);
          newContacts.push(contact);
          totalUnique++;
        }
        windowCount++;
      }

      process.stdout.write(
        `\r  ${window.label} | page ${page} | window: ${windowCount}/${total ?? '?'} | unique total: ${totalUnique}  `
      );

      if (contacts.length < PAGE_LIMIT) break;

      if (page >= 100) {
        hitCap = true;
        logger.warn(`extract-reg: window ${window.label} hit 100-page cap at ${windowCount} contacts — some contacts in this week may be missed`);
        cappedWindows.push(window.label);
        break;
      }

      page++;
      await sleep(150);
    }

    if (total > 0 || windowCount > 0) process.stdout.write('\n');

    doneWindows.add(window.label);
    windowStats[window.label] = { total, collected: windowCount, capped: hitCap };

    appendWindowContacts(newContacts);
    saveCheckpoint({ doneWindows: [...doneWindows], windowStats, cappedWindows }, seenIds);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n  Done in ${elapsed}s`);
  console.log(`  Unique contacts collected: ${totalUnique}`);

  if (cappedWindows.length > 0) {
    console.log(`\n  ⚠ WARNING: ${cappedWindows.length} weekly window(s) hit the 10K cap — contacts in those weeks may be incomplete:`);
    for (const w of cappedWindows) console.log(`    - ${w}`);
  }

  if (totalUnique === 0) {
    console.log('  No contacts found. Check API key and location ID.');
    process.exit(0);
  }

  // Build report data by streaming NDJSON — no in-memory contact objects
  console.log('  Building report...');
  const { topTags, sample } = await buildReportData(CP_CONTACTS);

  const report = {
    timestamp: new Date().toISOString(),
    strategy: 'contacts-search-api-weekly-date-chunks',
    windowCount: windows.length,
    cappedWindows,
    results: { contactsCollected: totalUnique, elapsedSeconds: parseFloat(elapsed) },
    sample,
    topTags,
  };

  // Stream-convert NDJSON → JSON array
  console.log('  Writing registrants.json...');
  const written = await ndjsonToJsonArray(CP_CONTACTS, join(SAMPLES_DIR, 'registrants.json'));

  mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(REPORTS_DIR, `extract-reg-${timestamp}.json`), JSON.stringify(report, null, 2));

  clearCheckpoint();

  console.log(`\n=== Summary ===`);
  console.log(`  Unique contacts : ${written}`);
  console.log(`  Windows scanned : ${windows.length}`);
  console.log(`  Capped windows  : ${cappedWindows.length}`);
  console.log(`  Elapsed         : ${elapsed}s`);
  console.log(`\n  Output : data/samples/registrants.json`);
  console.log(`  Report : data/reports/extract-reg-${timestamp}.json`);

  if (sample.length > 0) {
    console.log(`\n  Sample (first 5):`);
    for (const s of sample) console.log(`    ${s.id}  ${s.name.padEnd(30)}  ${s.tags.join(', ')}`);
  }

  logger.info('extract-registrants complete', { collected: written, elapsed, cappedWindows: cappedWindows.length });
}

main().catch(err => {
  logger.error('extract-registrants failed', { error: err.message });
  console.error('\nFatal:', err.message);
  console.error('Run with --resume to continue from last checkpoint.');
  process.exit(1);
});
