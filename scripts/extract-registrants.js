/**
 * Extract all GHL registrants (Tier 3) via POST /contacts/search with weekly date-range chunking.
 *
 * Strategy: GHL's search API caps at 100 pages (10,000 contacts) per query.
 * With ~895K contacts across ~6 years, monthly windows average ~11K — too large.
 * Weekly windows average ~2,500, keeping every window safely under the 10K cap.
 *
 * No tag filter — extracts all contacts by dateAdded range.
 * Contacts already migrated in Tier 1/2 will be safely re-upserted (setIfPresent
 * in fieldMapper ensures no good data is overwritten with blanks).
 *
 * Checkpoint design:
 *   - extract-reg.json          — small metadata (doneWindows, windowStats, cappedWindows)
 *   - extract-reg-contacts.ndjson — one contact per line, append-only per window
 *   This avoids JSON.stringify of the full contact set on every checkpoint save.
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
 *   data/samples/registrants.json             — contact records
 *   data/reports/extract-reg-[ts].json        — run report
 */

import dotenv from 'dotenv';
import {
  writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync,
  appendFileSync, createWriteStream,
} from 'fs';
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
 * Save only window metadata — contacts live in the NDJSON file.
 * @param {{ doneWindows: string[], windowStats: object, cappedWindows: string[] }} meta
 */
function saveCheckpoint(meta) {
  mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  writeFileSync(CP_FILE, JSON.stringify(meta));
}

/**
 * Append new unique contacts from a completed window to the NDJSON file.
 * @param {object[]} newContacts
 */
function appendWindowContacts(newContacts) {
  if (newContacts.length === 0) return;
  mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  appendFileSync(CP_CONTACTS, newContacts.map(c => JSON.stringify(c)).join('\n') + '\n');
}

/**
 * Load checkpoint metadata + rebuild contactMap from NDJSON.
 * @returns {{ doneWindows: string[], windowStats: object, cappedWindows: string[], contacts: object[] } | null}
 */
function loadCheckpoint() {
  if (!existsSync(CP_FILE)) return null;
  try {
    const meta     = JSON.parse(readFileSync(CP_FILE, 'utf-8'));
    const contacts = existsSync(CP_CONTACTS)
      ? readFileSync(CP_CONTACTS, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
      : [];
    return { ...meta, contacts };
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

// ── Stream-write JSON array to avoid in-memory stringify of 800K objects ──────

/**
 * Write contactMap values to a JSON array file without ever stringifying all at once.
 * @param {Map<string, object>} contactMap
 * @param {string} filePath
 * @returns {Promise<void>}
 */
function writeContactsFile(contactMap, filePath) {
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(filePath), { recursive: true });
    const ws = createWriteStream(filePath);
    ws.write('[\n');
    let first = true;
    for (const contact of contactMap.values()) {
      if (!first) ws.write(',\n');
      ws.write(JSON.stringify(contact));
      first = false;
    }
    ws.write('\n]\n');
    ws.end(err => err ? reject(err) : resolve());
  });
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

  const contactMap   = new Map();
  let doneWindows    = new Set();
  let windowStats    = {};
  let cappedWindows  = [];

  if (RESUME) {
    const cp = loadCheckpoint();
    if (cp) {
      for (const contact of cp.contacts) contactMap.set(contact.id, contact);
      doneWindows   = new Set(cp.doneWindows ?? []);
      windowStats   = cp.windowStats ?? {};
      cappedWindows = cp.cappedWindows ?? [];
      console.log(`  Resumed: ${contactMap.size} contacts, ${doneWindows.size} windows already done\n`);
    } else {
      console.log('  No checkpoint found — starting fresh\n');
    }
  }

  logger.info(`extract-reg: start — windows=${windows.length}, resume=${RESUME}, already=${contactMap.size}`);

  const startTime = Date.now();

  for (const window of windows) {
    if (doneWindows.has(window.label)) continue;

    let page        = 1;
    let windowCount = 0;
    let total       = null;
    let hitCap      = false;
    const newContacts = [];

    while (true) {
      const { contacts, total: t } = await searchPage(client, config.ghl.locationId, window, page);

      if (total === null) total = t;

      for (const contact of contacts) {
        if (!contactMap.has(contact.id)) {
          contactMap.set(contact.id, contact);
          newContacts.push(contact);
        }
        windowCount++;
      }

      process.stdout.write(
        `\r  ${window.label} | page ${page} | window: ${windowCount}/${total ?? '?'} | unique total: ${contactMap.size}  `
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

    // Append only the new contacts from this window — never stringify the whole map
    appendWindowContacts(newContacts);
    saveCheckpoint({ doneWindows: [...doneWindows], windowStats, cappedWindows });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n  Done in ${elapsed}s`);
  console.log(`  Unique contacts collected: ${contactMap.size}`);

  if (cappedWindows.length > 0) {
    console.log(`\n  ⚠ WARNING: ${cappedWindows.length} weekly window(s) hit the 10K cap — contacts in those weeks may be incomplete:`);
    for (const w of cappedWindows) console.log(`    - ${w}`);
    console.log(`  Consider re-running those windows with daily sub-chunking.`);
  }

  if (contactMap.size === 0) {
    console.log('  No contacts found. Check API key and location ID.');
    process.exit(0);
  }

  // Build report from tag counts (stream through map — no full stringify)
  const tagCounts = {};
  for (const c of contactMap.values()) {
    for (const t of c.tags ?? []) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  }
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 30)
    .map(([tag, count]) => ({ tag, count }));

  const sampleContacts = [...contactMap.values()].slice(0, 5);
  const sample = sampleContacts.map(c => ({
    id: c.id,
    name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
    tags: (c.tags ?? []).slice(0, 5),
  }));

  const report = {
    timestamp: new Date().toISOString(),
    strategy: 'contacts-search-api-weekly-date-chunks',
    windowCount: windows.length,
    cappedWindows,
    results: { contactsCollected: contactMap.size, elapsedSeconds: parseFloat(elapsed) },
    sample,
    topTags,
  };

  // Stream-write contacts to avoid in-memory stringify of 800K+ objects
  console.log('  Writing registrants.json...');
  await writeContactsFile(contactMap, join(SAMPLES_DIR, 'registrants.json'));

  mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(REPORTS_DIR, `extract-reg-${timestamp}.json`), JSON.stringify(report, null, 2));

  clearCheckpoint();

  console.log(`\n=== Summary ===`);
  console.log(`  Unique contacts : ${contactMap.size}`);
  console.log(`  Windows scanned : ${windows.length}`);
  console.log(`  Capped windows  : ${cappedWindows.length}`);
  console.log(`  Elapsed         : ${elapsed}s`);
  console.log(`\n  Output : data/samples/registrants.json`);
  console.log(`  Report : data/reports/extract-reg-${timestamp}.json`);

  if (sample.length > 0) {
    console.log(`\n  Sample (first 5):`);
    for (const s of sample) console.log(`    ${s.id}  ${s.name.padEnd(30)}  ${s.tags.join(', ')}`);
  }

  logger.info('extract-registrants complete', { collected: contactMap.size, elapsed, cappedWindows: cappedWindows.length });
}

main().catch(err => {
  logger.error('extract-registrants failed', { error: err.message });
  console.error('\nFatal:', err.message);
  console.error('Run with --resume to continue from last checkpoint.');
  process.exit(1);
});
