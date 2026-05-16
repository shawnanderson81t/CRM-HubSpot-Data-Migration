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
 * Usage:
 *   node scripts/extract-preview-buyers.js
 *   npm run extract:pb
 *
 * Output:
 *   data/samples/preview-buyers.json        — contact records
 *   data/reports/extract-pb-[ts].json       — run report
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

const PREVIEW_PIPELINE_ID = 'yZ49CJBYdHhC0IEIe9Cs';

// All opportunity statuses — GHL defaults to 'open' only
const OPP_STATUSES = ['open', 'won', 'lost', 'abandoned'];

const TARGET_COUNT = parseInt(
  process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '50000'
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch one page of opportunities with retry on 429, SSL/network errors, and
 * end-of-results detection (GHL returns 400 past the last page).
 */
async function fetchOppsPage(client, params, retries = 6) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await client.get('/opportunities/search', { params });
    } catch (err) {
      const status = err.response?.status;
      if (status === 400) {
        return { data: { opportunities: [] } };
      }
      const isRetryable = status === 429 || !status;
      if (isRetryable && attempt < retries) {
        const delay = 2000 * attempt;
        logger.warn(`GHL ${status ?? 'SSL/network'} error on opps page ${params.page} [${params.status}] — retry ${attempt}/${retries - 1} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Opportunities page ${params.page} failed: ${err.message}`);
    }
  }
}

async function run() {
  const config = loadConfig();
  const ghl = new GHLClient(config.ghl);
  const client = ghl._getClient();

  logger.info(`extract-preview-buyers: targeting up to ${TARGET_COUNT} contacts via pipeline (all statuses)`);
  console.log(`\n=== GHL Extract — Preview Buyers via Pipeline (all statuses) ===`);
  console.log(`  Pipeline : ${PREVIEW_PIPELINE_ID} (1 - Preview Registrants)`);
  console.log(`  Statuses : ${OPP_STATUSES.join(', ')}`);
  console.log(`  Filter   : none (all pipeline contacts)`);
  console.log(`  Target   : up to ${TARGET_COUNT} contacts\n`);

  const startTime = Date.now();

  const contacts = [];
  const seenIds = new Set();
  let oppScanned = 0;
  let contactsFetched = 0;
  let fetchErrors = 0;

  for (const status of OPP_STATUSES) {
    if (contacts.length >= TARGET_COUNT) break;
    console.log(`\n  [status: ${status}]`);
    let page = 1;

    while (contacts.length < TARGET_COUNT) {
      const params = {
        location_id: config.ghl.locationId,
        pipeline_id: PREVIEW_PIPELINE_ID,
        status,
        limit: 100,
        page,
      };

      const response = await fetchOppsPage(client, params);
      const opportunities = response.data?.opportunities ?? [];
      oppScanned += opportunities.length;

      if (opportunities.length === 0) break;

      const ids = opportunities
        .map(o => o.contactId)
        .filter(id => id && !seenIds.has(id));
      ids.forEach(id => seenIds.add(id));

      for (const id of ids) {
        if (contacts.length >= TARGET_COUNT) break;
        try {
          const contact = await ghl.getContact(id);
          contactsFetched++;
          contacts.push(contact);
        } catch (err) {
          logger.warn(`skip contact ${id}: ${err.message}`);
          fetchErrors++;
        }

        process.stdout.write(
          `\r  Opps scanned: ${oppScanned} | Fetched: ${contactsFetched} | Collected: ${contacts.length} | Page: ${page} [${status}]  `
        );
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

  // Field coverage
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

  // Tag distribution
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
    results: {
      opportunitiesScanned: oppScanned,
      contactsFetched,
      contactsCollected: contacts.length,
      fetchErrors,
      elapsedSeconds: parseFloat(elapsed),
    },
    sample,
    fieldCoverage: coveragePct,
    topTags,
  };

  mkdirSync(SAMPLES_DIR, { recursive: true });
  const samplesPath = join(SAMPLES_DIR, 'preview-buyers.json');
  writeFileSync(samplesPath, JSON.stringify(contacts, null, 2));

  mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `extract-pb-${timestamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`=== Summary ===`);
  console.log(`  Opportunities scanned : ${oppScanned}`);
  console.log(`  Contacts fetched      : ${contactsFetched}`);
  console.log(`  Contacts collected    : ${contacts.length} (all pipeline contacts)`);
  console.log(`  Fetch errors          : ${fetchErrors}`);
  console.log(`  Elapsed               : ${elapsed}s`);
  console.log(`\n  Contacts : data/samples/preview-buyers.json`);
  console.log(`  Report   : data/reports/extract-pb-${timestamp}.json`);

  if (sample.length > 0) {
    console.log(`\n  Sample (first 5):`);
    for (const s of sample) {
      console.log(`    ${s.id}  ${s.name.padEnd(30)}  ${s.tags.join(', ')}`);
    }
  }

  logger.info('extract-preview-buyers complete', { collected: contacts.length, elapsed });
}

run().catch(err => {
  logger.error('extract-preview-buyers failed', { error: err.message });
  console.error('\nFatal:', err.message);
  process.exit(1);
});
