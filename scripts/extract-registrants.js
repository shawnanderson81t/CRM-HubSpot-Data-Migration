/**
 * Extract General Registrants from GHL via the contacts API.
 *
 * Strategy: unlike Tiers 1 & 2 (pipeline-based), Tier 3 uses direct contact
 * list pagination (cursor-based via startAfterId). Contacts are filtered in
 * memory — hs-to-hl import contacts (tagged hs_transfer or hs-to-hl_temp_*)
 * are excluded since they are HubSpot→GHL syncs, not real registrants.
 *
 * GHL returns contacts newest-first. The first ~134K records are hs-to-hl
 * imports — they get skipped quickly by the tag filter.
 *
 * Usage:
 *   node scripts/extract-registrants.js               # full run (default 900K cap)
 *   node scripts/extract-registrants.js --count=100   # sample for pilot
 *   npm run extract:reg
 *   npm run extract:reg:sample                        # 100 contacts for pilot
 *
 * Output:
 *   --count=100  → data/samples/registrants-sample.json  (pilot use)
 *   full run     → data/samples/registrants.json          (Tier 3 migration)
 *   data/reports/extract-reg-[ts].json                   — run report
 */

import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../src/utils/config.js';
import { logger } from '../src/utils/logger.js';
import axios from 'axios';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = join(__dirname, '../data/samples');
const REPORTS_DIR = join(__dirname, '../data/reports');

const TARGET_COUNT = parseInt(
  process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '900000'
);

// Contacts with these tags are HubSpot→GHL syncs — not real registrants
const EXCLUDE_TAG_PREFIXES = ['hs-to-hl', 'hs_transfer'];

const isSyncContact = tags =>
  (tags ?? []).some(t => EXCLUDE_TAG_PREFIXES.some(prefix => t.startsWith(prefix)));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const config = loadConfig();

  const isSample = TARGET_COUNT <= 1000;
  const outputFile = isSample ? 'registrants-sample.json' : 'registrants.json';

  logger.info(`extract-registrants: targeting ${TARGET_COUNT} contacts via contacts API`);
  console.log(`\n=== GHL Extract — General Registrants (contacts API) ===`);
  console.log(`  Strategy : cursor-based contact pagination`);
  console.log(`  Exclude  : hs_transfer / hs-to-hl_temp_* tags (HubSpot→GHL syncs)`);
  console.log(`  Target   : ${TARGET_COUNT} contacts`);
  console.log(`  Output   : data/samples/${outputFile}\n`);

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

  const startTime = Date.now();
  const collected = [];
  let startAfterId = null;
  let page = 1;
  let scanned = 0;
  let skipped = 0;

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
        const status = err.response?.status;
        const isRetryable = status === 429 || !status;
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
    scanned += contacts.length;

    if (contacts.length === 0) break;

    for (const contact of contacts) {
      if (collected.length >= TARGET_COUNT) break;
      if (isSyncContact(contact.tags)) {
        skipped++;
        continue;
      }
      collected.push(contact);
    }

    process.stdout.write(
      `\r  Scanned: ${scanned} | Skipped (sync): ${skipped} | Collected: ${collected.length}/${TARGET_COUNT} | Page: ${page}  `
    );

    if (scanned % 5000 === 0) {
      logger.info(`extract-reg page ${page}: scanned=${scanned}, skipped=${skipped}, collected=${collected.length}`);
    }

    startAfterId = meta.startAfterId ?? null;
    if (!startAfterId || contacts.length < 100) break;
    page++;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n  Done in ${elapsed}s`);

  if (collected.length === 0) {
    console.log('  No contacts collected. Check API key and location ID.');
    process.exit(0);
  }

  // Tag distribution (top 20)
  const tagCounts = {};
  for (const contact of collected) {
    for (const tag of contact.tags ?? []) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }));

  const sample = collected.slice(0, 5).map(c => ({
    id: c.id,
    name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
    tags: (c.tags ?? []).slice(0, 5),
  }));

  const report = {
    timestamp: new Date().toISOString(),
    strategy: 'contacts-api-cursor-pagination',
    config: { targetCount: TARGET_COUNT },
    results: {
      pagesScanned: page,
      contactsScanned: scanned,
      syncContactsSkipped: skipped,
      contactsCollected: collected.length,
      elapsedSeconds: parseFloat(elapsed),
    },
    sample,
    topTags,
  };

  mkdirSync(SAMPLES_DIR, { recursive: true });
  writeFileSync(join(SAMPLES_DIR, outputFile), JSON.stringify(collected, null, 2));

  mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `extract-reg-${timestamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`=== Summary ===`);
  console.log(`  Pages scanned          : ${page}`);
  console.log(`  Contacts scanned       : ${scanned}`);
  console.log(`  Sync contacts skipped  : ${skipped}`);
  console.log(`  Contacts collected     : ${collected.length}`);
  console.log(`  Elapsed                : ${elapsed}s`);
  console.log(`\n  Output : data/samples/${outputFile}`);
  console.log(`  Report : data/reports/extract-reg-${timestamp}.json`);

  if (sample.length > 0) {
    console.log(`\n  Sample (first 5):`);
    for (const s of sample) {
      console.log(`    ${s.id}  ${s.name.padEnd(30)}  ${s.tags.join(', ')}`);
    }
  }

  logger.info('extract-registrants complete', { collected: collected.length, skipped, elapsed });
}

main().catch(err => {
  logger.error('extract-registrants failed', { error: err.message });
  console.error('\nFatal:', err.message);
  process.exit(1);
});
