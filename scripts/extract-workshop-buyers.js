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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOppsPage(client, params, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await client.get('/opportunities/search', { params });
    } catch (err) {
      const status = err.response?.status;
      if (status === 400) {
        // GHL returns 400 (not an empty array) when page is past the end of results
        return { data: { opportunities: [] } };
      }
      if (status === 429 && attempt < retries) {
        const delay = 2000 * attempt;
        logger.warn(`GHL 429 on opps page ${params.page} — retry ${attempt} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Opportunities page ${params.page} failed: ${err.message}`);
    }
  }
}

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = join(__dirname, '../data/samples');
const REPORTS_DIR = join(__dirname, '../data/reports');

const WORKSHOP_PIPELINE_ID = 'sJF6NWKqQAF4qZGBK3cq';

// All opportunity statuses — GHL defaults to 'open' only, missing won/lost/abandoned
const OPP_STATUSES = ['open', 'won', 'lost', 'abandoned'];

const TARGET_COUNT = parseInt(
  process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '50000'
);

async function run() {
  const config = loadConfig();
  const ghl = new GHLClient(config.ghl);
  const client = ghl._getClient();

  logger.info(`extract-workshop-buyers: targeting up to ${TARGET_COUNT} contacts via pipeline (all statuses, no tag filter)`);
  console.log(`\n=== GHL Extract — Workshop Buyers via Pipeline (all statuses) ===`);
  console.log(`  Pipeline : ${WORKSHOP_PIPELINE_ID} (2 - Workshops)`);
  console.log(`  Statuses : ${OPP_STATUSES.join(', ')}`);
  console.log(`  Filter   : none (all pipeline contacts per Andy's instruction)`);
  console.log(`  Target   : up to ${TARGET_COUNT} contacts\n`);

  const startTime = Date.now();

  const matched = [];
  const seenIds = new Set();   // deduplicates contacts across all statuses
  let oppScanned = 0;
  let contactsFetched = 0;
  let fetchErrors = 0;

  // Paginate through every opportunity status — GHL caps each status at 10K results
  for (const status of OPP_STATUSES) {
    if (matched.length >= TARGET_COUNT) break;
    console.log(`\n  [status: ${status}]`);
    let page = 1;

    while (matched.length < TARGET_COUNT) {
      const params = {
        location_id: config.ghl.locationId,
        pipeline_id: WORKSHOP_PIPELINE_ID,
        status,
        limit: 100,
        page,
      };

      const response = await fetchOppsPage(client, params);
      const opportunities = response.data?.opportunities ?? [];
      oppScanned += opportunities.length;

      if (opportunities.length === 0) break;

      // Unique contact IDs not yet seen across any status
      const ids = opportunities
        .map(o => o.contactId)
        .filter(id => id && !seenIds.has(id));
      ids.forEach(id => seenIds.add(id));

      for (const id of ids) {
        if (matched.length >= TARGET_COUNT) break;
        try {
          const contact = await ghl.getContact(id);
          contactsFetched++;
          matched.push(contact);
        } catch (err) {
          logger.warn(`skip contact ${id}: ${err.message}`);
          fetchErrors++;
        }

        process.stdout.write(
          `\r  Opps scanned: ${oppScanned} | Fetched: ${contactsFetched} | Collected: ${matched.length} | Page: ${page} [${status}]  `
        );
        await sleep(150);
      }

      logger.info(`extract-wb [${status}] page ${page}: opps=${oppScanned}, fetched=${contactsFetched}, collected=${matched.length}`);

      if (opportunities.length < 100) break;
      page++;
    }
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
    tags: (c.tags ?? []).slice(0, 5),
  }));

  const report = {
    timestamp: new Date().toISOString(),
    strategy: 'pipeline-opportunities-all-statuses',
    pipelineId: WORKSHOP_PIPELINE_ID,
    statuses: OPP_STATUSES,
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
  console.log(`  Contacts collected    : ${matched.length} (all pipeline contacts, no tag filter)`);
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
