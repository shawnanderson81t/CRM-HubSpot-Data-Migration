/**
 * Extract Workshop Buyers from GHL via the Workshop pipeline opportunities.
 *
 * Strategy: GHL paginates contacts newest-first, so the first 134K+ contacts are
 * HS→GHL imports with no buyer tags. Instead, we query the Workshop pipeline
 * opportunities to get contact IDs, then fetch each contact individually.
 *
 * Workshop pipeline ID: sJF6NWKqQAF4qZGBK3cq ("2 - Workshops")
 *
 * Usage:
 *   node scripts/extract-workshop-buyers.js              # 100 contacts (default)
 *   node scripts/extract-workshop-buyers.js --count=50   # custom count
 *
 * Output:
 *   data/samples/workshop-buyers-sample.json    — contact records
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

const TARGET_COUNT = parseInt(
  process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '100'
);

async function run() {
  const config = loadConfig();
  const ghl = new GHLClient(config.ghl);

  logger.info(`extract-workshop-buyers: targeting ${TARGET_COUNT} contacts via pipeline opportunities`);
  console.log(`\n=== GHL Extract — Workshop Buyers via Pipeline ===`);
  console.log(`  Pipeline : ${WORKSHOP_PIPELINE_ID} (2 - Workshops)`);
  console.log(`  Target   : ${TARGET_COUNT} contacts\n`);

  const startTime = Date.now();

  // Step 1 — collect contact IDs from Workshop pipeline opportunities
  console.log('  Step 1: Collecting contact IDs from Workshop pipeline opportunities...');
  const contactIds = await ghl.getContactIdsByPipeline({
    pipelineId: WORKSHOP_PIPELINE_ID,
    limit: TARGET_COUNT,
    onProgress: ({ scanned, unique, page }) => {
      process.stdout.write(`\r    Opportunities scanned: ${scanned} | Unique contacts: ${unique} | Page: ${page}  `);
    },
  });

  const elapsedStep1 = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n    Found ${contactIds.length} unique contact IDs in ${elapsedStep1}s`);

  if (contactIds.length === 0) {
    console.log('\n  No contacts found in Workshop pipeline. Exiting.');
    process.exit(0);
  }

  // Step 2 — fetch each contact by ID
  const toFetch = contactIds.slice(0, TARGET_COUNT);
  console.log(`\n  Step 2: Fetching ${toFetch.length} contacts by ID...`);

  const contacts = [];
  const errors = [];

  for (let i = 0; i < toFetch.length; i++) {
    const contactId = toFetch[i];
    try {
      const contact = await ghl.getContact(contactId);
      if (contact) contacts.push(contact);
    } catch (err) {
      logger.warn(`Failed to fetch contact ${contactId}: ${err.message}`);
      errors.push({ contactId, error: err.message });
    }
    if ((i + 1) % 10 === 0 || i === toFetch.length - 1) {
      process.stdout.write(`\r    Fetched: ${contacts.length}/${toFetch.length} | Errors: ${errors.length}  `);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n  Done in ${elapsed}s`);

  // Field coverage check
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

  // Custom field coverage
  const customFieldCounts = {};
  for (const contact of contacts) {
    for (const cf of contact.customFields ?? []) {
      if (cf.value !== null && cf.value !== '' && cf.value !== undefined) {
        customFieldCounts[cf.id] = (customFieldCounts[cf.id] ?? 0) + 1;
      }
    }
  }

  // Sample of 5 contacts (id, name, tags) for quick verification
  const sample = contacts.slice(0, 5).map(c => ({
    id: c.id,
    name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim(),
    tags: c.tags ?? [],
  }));

  const report = {
    timestamp: new Date().toISOString(),
    strategy: 'pipeline-opportunities',
    pipelineId: WORKSHOP_PIPELINE_ID,
    config: { targetCount: TARGET_COUNT },
    results: {
      contactIdsFound: contactIds.length,
      fetched: contacts.length,
      errors: errors.length,
      elapsedSeconds: parseFloat(elapsed),
    },
    sample,
    fieldCoverage: coveragePct,
    topTags,
    customFieldPopulation: Object.entries(customFieldCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, count, pct: `${Math.round((count / contacts.length) * 100)}%` })),
    fetchErrors: errors,
  };

  // Save contacts
  mkdirSync(SAMPLES_DIR, { recursive: true });
  const samplesPath = join(SAMPLES_DIR, 'workshop-buyers-sample.json');
  writeFileSync(samplesPath, JSON.stringify(contacts, null, 2));

  // Save report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `extract-wb-${timestamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`=== Summary ===`);
  console.log(`  Contact IDs from pipeline : ${contactIds.length}`);
  console.log(`  Contacts fetched          : ${contacts.length}`);
  console.log(`  Fetch errors              : ${errors.length}`);
  console.log(`  Elapsed                   : ${elapsed}s`);
  console.log(`\n  Contacts : data/samples/workshop-buyers-sample.json`);
  console.log(`  Report   : data/reports/extract-wb-${timestamp}.json`);

  if (sample.length > 0) {
    console.log(`\n  Sample (first 5):`);
    for (const s of sample) {
      console.log(`    ${s.id}  ${s.name.padEnd(30)}  tags: ${s.tags.join(', ') || '(none)'}`);
    }
  }

  logger.info('extract-workshop-buyers complete', { fetched: contacts.length, elapsed });
}

run().catch(err => {
  logger.error('extract-workshop-buyers failed', { error: err.message });
  console.error('\nFatal:', err.message);
  process.exit(1);
});
