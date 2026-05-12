/**
 * Extract a sample of Workshop Buyers from GHL for pilot testing.
 *
 * Streams GHL contacts page by page, filters by Workshop Buyer tags,
 * stops when the target count is reached. Saves results and a JSON report.
 *
 * Usage:
 *   node scripts/extract-sample.js              # 100 Workshop Buyers (default)
 *   node scripts/extract-sample.js --count=50   # custom count
 *
 * Output:
 *   data/samples/workshop-buyers-sample.json    — contact records
 *   data/reports/extract-sample-[ts].json       — run report
 */

import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../src/utils/config.js';
import { GHLClient } from '../src/extract/ghlClient.js';
import { logger } from '../src/utils/logger.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = join(__dirname, '../data/samples');
const REPORTS_DIR = join(__dirname, '../data/reports');

/** Tags that identify Workshop Buyers in GHL */
const WORKSHOP_BUYER_TAGS = ['wb', 'wb_diamond'];

/** Contacts with this tag were already migrated — exclude them */
const EXCLUDE_TAGS = ['hs_transfer'];

const TARGET_COUNT = parseInt(
  process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '100'
);

async function run() {
  const config = loadConfig();
  const ghl = new GHLClient(config.ghl);

  logger.info(`extract-sample: targeting ${TARGET_COUNT} Workshop Buyers from GHL`);
  console.log(`\n=== GHL Extract — Workshop Buyers Sample ===`);
  console.log(`  Target  : ${TARGET_COUNT} contacts`);
  console.log(`  Tags    : ${WORKSHOP_BUYER_TAGS.join(', ')}`);
  console.log(`  Exclude : ${EXCLUDE_TAGS.join(', ')}\n`);

  const startTime = Date.now();

  const contacts = await ghl.findContacts({
    tags: WORKSHOP_BUYER_TAGS,
    excludeTags: EXCLUDE_TAGS,
    limit: TARGET_COUNT,
    pageSize: 100,
    onProgress: ({ scanned, matched, page }) => {
      process.stdout.write(`\r  Scanned: ${scanned.toLocaleString()} | Matched: ${matched}/${TARGET_COUNT} | Page: ${page}  `);
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n  Done in ${elapsed}s`);

  // Field coverage check — which fields are populated across the sample
  const fieldCoverage = {};
  for (const contact of contacts) {
    for (const key of Object.keys(contact)) {
      if (contact[key] !== null && contact[key] !== undefined && contact[key] !== '') {
        fieldCoverage[key] = (fieldCoverage[key] ?? 0) + 1;
      }
    }
  }

  const coveragePct = Object.fromEntries(
    Object.entries(fieldCoverage)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, `${Math.round((v / contacts.length) * 100)}%`])
  );

  // Tag distribution across sample
  const tagCounts = {};
  for (const contact of contacts) {
    for (const tag of contact.tags ?? []) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([tag, count]) => ({ tag, count }));

  // Custom field coverage
  const customFieldCounts = {};
  for (const contact of contacts) {
    for (const cf of contact.customFields ?? []) {
      if (cf.value !== null && cf.value !== '' && cf.value !== undefined) {
        customFieldCounts[cf.id] = (customFieldCounts[cf.id] ?? 0) + 1;
      }
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    config: {
      targetCount: TARGET_COUNT,
      workshopBuyerTags: WORKSHOP_BUYER_TAGS,
      excludeTags: EXCLUDE_TAGS,
    },
    results: {
      extracted: contacts.length,
      elapsedSeconds: parseFloat(elapsed),
    },
    fieldCoverage: coveragePct,
    topTags,
    customFieldPopulation: Object.entries(customFieldCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, count, pct: `${Math.round((count / contacts.length) * 100)}%` })),
  };

  // Save contacts
  mkdirSync(SAMPLES_DIR, { recursive: true });
  const samplesPath = join(SAMPLES_DIR, 'workshop-buyers-sample.json');
  writeFileSync(samplesPath, JSON.stringify(contacts, null, 2));

  // Save report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `extract-sample-${timestamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`=== Summary ===`);
  console.log(`  Extracted : ${contacts.length} Workshop Buyers`);
  console.log(`  Elapsed   : ${elapsed}s`);
  console.log(`\n  Contacts  : data/samples/workshop-buyers-sample.json`);
  console.log(`  Report    : data/reports/extract-sample-${timestamp}.json`);

  logger.info(`extract-sample complete`, { extracted: contacts.length, elapsed });
}

run().catch(err => {
  logger.error('extract-sample failed', { error: err.message });
  console.error('\nFatal:', err.message);
  process.exit(1);
});
