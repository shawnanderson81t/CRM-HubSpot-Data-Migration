/**
 * Diagnostic: check what fields the GHL /contacts/ list API returns.
 * Specifically verifies whether `tags` is included in bulk list responses.
 *
 * Usage: node scripts/debug-contacts-api.js
 */

import 'dotenv/config';
import axios from 'axios';
import { loadConfig } from '../src/utils/config.js';

const config = loadConfig();

const client = axios.create({
  baseURL: process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com',
  headers: {
    Authorization: `Bearer ${config.ghl.apiKey}`,
    Version: process.env.GHL_VERSION || '2021-07-28',
  },
});

const PREVIEW_TAGS = [
  'pna',
  'phase_preview-non-attendee',
  'phase_preview-reg',
  'phase_preview-attendee',
  'phase-preview-buyer',
];

async function run() {
  const locationId = config.ghl.locationId;

  // Count per tag (1 contact fetch each — just need the total field)
  console.log('\nTag counts (total contacts per preview tag):');
  console.log('─'.repeat(55));
  let grandTotal = 0;
  for (const tag of PREVIEW_TAGS) {
    try {
      const res = await client.post('/contacts/search', {
        locationId,
        filters: [{ field: 'tags', operator: 'contains', value: tag }],
        pageLimit: 1,
        page: 1,
      });
      const total = res.data?.total ?? '?';
      grandTotal += typeof total === 'number' ? total : 0;
      console.log(`  ${tag.padEnd(35)} ${String(total).padStart(8)}`);
    } catch (err) {
      console.log(`  ${tag.padEnd(35)} FAILED: ${err.response?.status}`);
    }
  }
  console.log('─'.repeat(55));
  console.log(`  ${'TOTAL (with overlap)'.padEnd(35)} ${String(grandTotal).padStart(8)}`);
  console.log('\nNote: contacts can have multiple tags so unique count will be less than total above.');
}

run().catch(err => {
  console.error('Failed:', err.response?.data ?? err.message);
  process.exit(1);
});
