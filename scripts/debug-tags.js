/**
 * Diagnostic script — scans the first N pages of GHL contacts and reports:
 * - All unique tags found and their frequency
 * - Whether any wb / wb_diamond tags exist
 * - Sample of contacts with their tags
 *
 * Usage: node scripts/debug-tags.js
 *        node scripts/debug-tags.js --pages=20
 */

import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../src/utils/config.js';
import { GHLClient } from '../src/extract/ghlClient.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '../data/reports');

const PAGES_TO_SCAN = parseInt(
  process.argv.find(a => a.startsWith('--pages='))?.split('=')[1] || '10'
);

async function run() {
  const config = loadConfig();
  const ghl = new GHLClient(config.ghl);

  console.log(`\n=== GHL Tag Diagnostic (scanning ${PAGES_TO_SCAN} pages) ===\n`);

  const tagCounts = {};
  let scanned = 0;
  let startAfterId = null;

  for (let page = 1; page <= PAGES_TO_SCAN; page++) {
    const params = { locationId: config.ghl.locationId, limit: 100 };
    if (startAfterId) params.startAfterId = startAfterId;

    const response = await ghl._getClient().get('/contacts/', { params });
    const contacts = response.data?.contacts ?? [];
    const meta = response.data?.meta ?? {};

    scanned += contacts.length;

    for (const contact of contacts) {
      for (const tag of contact.tags ?? []) {
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
    }

    process.stdout.write(`\r  Page ${page}/${PAGES_TO_SCAN} — ${scanned} contacts scanned`);

    startAfterId = meta.startAfterId ?? null;
    if (!startAfterId || contacts.length < 100) break;
  }

  console.log(`\n\n  Total contacts scanned: ${scanned}`);
  console.log(`  Unique tags found: ${Object.keys(tagCounts).length}\n`);

  // Sort by frequency
  const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

  // Check specifically for buyer-tier tags
  const buyerTags = ['wb', 'wb_diamond', 'WB', 'WB_DIAMOND', 'phase-preview-buyer',
    'phase_preview-buyer', 'telesales_sold', 'telesales_diamond', 'community_newmember'];

  console.log('  === Buyer-tier tags found ===');
  for (const tag of buyerTags) {
    const count = tagCounts[tag] ?? 0;
    console.log(`  ${tag.padEnd(30)} : ${count}`);
  }

  console.log('\n  === Top 40 tags across scanned contacts ===');
  for (const [tag, count] of sorted.slice(0, 40)) {
    const pct = ((count / scanned) * 100).toFixed(1);
    console.log(`  ${tag.padEnd(40)} : ${count} (${pct}%)`);
  }

  // Save full report
  const report = {
    timestamp: new Date().toISOString(),
    pagesScanned: PAGES_TO_SCAN,
    contactsScanned: scanned,
    uniqueTagCount: Object.keys(tagCounts).length,
    buyerTagCheck: Object.fromEntries(buyerTags.map(t => [t, tagCounts[t] ?? 0])),
    allTags: sorted.map(([tag, count]) => ({ tag, count })),
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(REPORTS_DIR, `debug-tags-${ts}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report: data/reports/debug-tags-${ts}.json`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
