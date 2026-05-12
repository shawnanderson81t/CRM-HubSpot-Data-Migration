/**
 * Extract Workshop Buyers from GHL via the Workshop pipeline opportunities.
 *
 * Strategy: GHL paginates contacts newest-first, so tag-based contact scanning
 * hits 134K+ HS→GHL imports before reaching real buyers. Instead, we stream
 * the Workshop pipeline opportunities page-by-page, fetch each contact by ID,
 * filter for wb / wb_diamond tags, and stop when we have enough.
 *
 * Workshop pipeline ID: sJF6NWKqQAF4qZGBK3cq ("2 - Workshops")
 *
 * Usage:
 *   node scripts/extract-workshop-buyers.js              # 100 WBs (default)
 *   node scripts/extract-workshop-buyers.js --count=50   # custom count
 *
 * Output:
 *   data/samples/workshop-buyers-sample.json    — contact records (WBs only)
 *   data/reports/extract-wb-[ts].json           — run report
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

const WORKSHOP_PIPELINE_ID = 'sJF6NWKqQAF4qZGBK3cq';
const BUYER_TAGS = new Set(['wb', 'wb_diamond']);

const TARGET_COUNT = parseInt(
  process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '100'
);

async function run() {
  const config = loadConfig();
  const ghl = new GHLClient(config.ghl);
  const client = ghl._getClient();

  logger.info(`extract-workshop-buyers: targeting ${TARGET_COUNT} WBs (wb/wb_diamond) via pipeline`);
  console.log(`\n=== GHL Extract — Workshop Buyers via Pipeline (filtered) ===`);
  console.log(`  Pipeline : ${WORKSHOP_PIPELINE_ID} (2 - Workshops)`);
  console.log(`  Tags     : wb, wb_diamond`);
  console.log(`  Target   : ${TARGET_COUNT} contacts\n`);

  const startTime = Date.now();

  const matched = [];
  const seenIds = new Set();
  let page = 1;
  let startAfterId = null;
  let oppScanned = 0;
  let contactsFetched = 0;
  let fetchErrors = 0;

  while (matched.length < TARGET_COUNT) {
    const params = {
      location_id: config.ghl.locationId,
      pipeline_id: WORKSHOP_PIPELINE_ID,
      limit: 100,
    };
    if (startAfterId) params.startAfterId = startAfterId;

    let response;
    try {
      response = await client.get('/opportunities/search', { params });
    } catch (err) {
      throw new Error(`Opportunities page ${page} failed: ${err.message}`);
    }

    const opportunities = response.data?.opportunities ?? [];
    const meta = response.data?.meta ?? {};
    oppScanned += opportunities.length;

    if (opportunities.length === 0) break;

    // Unique contact IDs not yet processed
    const ids = opportunities
      .map(o => o.contactId)
      .filter(id => id && !seenIds.has(id));
    ids.forEach(id => seenIds.add(id));

    for (const id of ids) {
      if (matched.length >= TARGET_COUNT) break;
      try {
        const contact = await ghl.getContact(id);
        contactsFetched++;
        if (contact && (contact.tags ?? []).some(t => BUYER_TAGS.has(t))) {
          matched.push(contact);
        }
      } catch (err) {
        logger.warn(`skip contact ${id}: ${err.message}`);
        fetchErrors++;
      }

      process.stdout.write(
        `\r  Opps scanned: ${oppScanned} | Fetched: ${contactsFetched} | Matched: ${matched.length}/${TARGET_COUNT} | Page: ${page}  `
      );
    }

    logger.info(`extract-wb page ${page}: opps=${oppScanned}, fetched=${contactsFetched}, matched=${matched.length}`);

    startAfterId = meta.startAfterId ?? null;
    if (!startAfterId || opportunities.length < 100) break;
    page++;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n  Done in ${elapsed}s`);

  if (matched.length === 0) {
    console.log('  No Workshop Buyers found. Check pipeline ID and tag names.');
    process.exit(0);
  }

  // Field coverage
  const fieldCoverage = {};
  for (const contact of matched) {
    for (const key of Object.keys(contact)) {
      if (contact[key] !== null && contact[key] !== undefined && contact[key] !== '') {
        fieldCoverage[key] = (fieldCoverage[key] ?? 0) + 1;
      }
    }
  }
  const coveragePct = Object.fromEntries(
    Object.entries(fieldCoverage)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, `${Math.round((v / matched.length) * 100)}%`])
  );

  // Tag distribution
  const tagCounts = {};
  for (const contact of matched) {
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
  for (const contact of matched) {
    for (const cf of contact.customFields ?? []) {
      if (cf.value !== null && cf.value !== '' && cf.value !== undefined) {
        customFieldCounts[cf.id] = (customFieldCounts[cf.id] ?? 0) + 1;
      }
    }
  }

  // Sample for quick verification
  const sample = matched.slice(0, 5).map(c => ({
    id: c.id,
    name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
    tags: (c.tags ?? []).filter(t => BUYER_TAGS.has(t)),
  }));

  const report = {
    timestamp: new Date().toISOString(),
    strategy: 'pipeline-opportunities-filtered',
    pipelineId: WORKSHOP_PIPELINE_ID,
    buyerTags: [...BUYER_TAGS],
    config: { targetCount: TARGET_COUNT },
    results: {
      opportunitiesScanned: oppScanned,
      contactsFetched: contactsFetched,
      matchedBuyers: matched.length,
      fetchErrors,
      elapsedSeconds: parseFloat(elapsed),
    },
    sample,
    fieldCoverage: coveragePct,
    topTags,
    customFieldPopulation: Object.entries(customFieldCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, count, pct: `${Math.round((count / matched.length) * 100)}%` })),
  };

  // Save contacts
  mkdirSync(SAMPLES_DIR, { recursive: true });
  const samplesPath = join(SAMPLES_DIR, 'workshop-buyers-sample.json');
  writeFileSync(samplesPath, JSON.stringify(matched, null, 2));

  // Save report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `extract-wb-${timestamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`=== Summary ===`);
  console.log(`  Opportunities scanned : ${oppScanned}`);
  console.log(`  Contacts fetched      : ${contactsFetched}`);
  console.log(`  Workshop Buyers found : ${matched.length} (wb/wb_diamond)`);
  console.log(`  Fetch errors          : ${fetchErrors}`);
  console.log(`  Elapsed               : ${elapsed}s`);
  console.log(`\n  Contacts : data/samples/workshop-buyers-sample.json`);
  console.log(`  Report   : data/reports/extract-wb-${timestamp}.json`);

  if (sample.length > 0) {
    console.log(`\n  Sample (first 5 — buyer tags only):`);
    for (const s of sample) {
      console.log(`    ${s.id}  ${s.name.padEnd(30)}  ${s.tags.join(', ')}`);
    }
  }

  logger.info('extract-workshop-buyers complete', { matched: matched.length, elapsed });
}

run().catch(err => {
  logger.error('extract-workshop-buyers failed', { error: err.message });
  console.error('\nFatal:', err.message);
  process.exit(1);
});
