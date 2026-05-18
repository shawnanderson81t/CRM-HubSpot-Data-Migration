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

const PREVIEW_TAGS = ['phase-preview-buyer', 'phase_preview-attendee', 'phase_preview-reg', 'phase_preview-non-attendee', 'pna'];

async function run() {
  const locationId = config.ghl.locationId;

  // Test 1: total count across all preview tags (OR) — how many contacts are we targeting?
  console.log('\nTest 1 — total preview contacts (all tags, OR)...');
  try {
    const res = await client.post('/contacts/search', {
      locationId,
      filters: PREVIEW_TAGS.map(t => ({ field: 'tags', operator: 'contains', value: t })),
      pageLimit: 1,
    });
    console.log(`  total: ${res.data?.total}`);
    console.log(`  contacts returned: ${(res.data?.contacts ?? []).length}`);
    console.log(`  all response keys: ${Object.keys(res.data ?? {}).join(', ')}`);
  } catch (err) {
    console.log(`  FAILED: ${err.response?.status} — ${JSON.stringify(err.response?.data)}`);
  }

  // Test 2: pagination — does `page` work?
  console.log('\nTest 2 — pagination via page number...');
  try {
    const res1 = await client.post('/contacts/search', {
      locationId,
      filters: [{ field: 'tags', operator: 'contains', value: 'pna' }],
      pageLimit: 3,
      page: 1,
    });
    const res2 = await client.post('/contacts/search', {
      locationId,
      filters: [{ field: 'tags', operator: 'contains', value: 'pna' }],
      pageLimit: 3,
      page: 2,
    });
    const ids1 = (res1.data?.contacts ?? []).map(c => c.id);
    const ids2 = (res2.data?.contacts ?? []).map(c => c.id);
    console.log(`  page 1 ids: ${ids1.join(', ')}`);
    console.log(`  page 2 ids: ${ids2.join(', ')}`);
    console.log(`  overlap: ${ids1.filter(id => ids2.includes(id)).length} (should be 0)`);
  } catch (err) {
    console.log(`  FAILED: ${err.response?.status} — ${JSON.stringify(err.response?.data)}`);
  }

  // Test 3: pagination via startAfterId
  console.log('\nTest 3 — pagination via startAfterId...');
  try {
    const res1 = await client.post('/contacts/search', {
      locationId,
      filters: [{ field: 'tags', operator: 'contains', value: 'pna' }],
      pageLimit: 3,
    });
    const lastId = res1.data?.contacts?.at(-1)?.id;
    const res2 = await client.post('/contacts/search', {
      locationId,
      filters: [{ field: 'tags', operator: 'contains', value: 'pna' }],
      pageLimit: 3,
      startAfterId: lastId,
    });
    const ids1 = (res1.data?.contacts ?? []).map(c => c.id);
    const ids2 = (res2.data?.contacts ?? []).map(c => c.id);
    console.log(`  page 1 ids: ${ids1.join(', ')}`);
    console.log(`  page 2 ids: ${ids2.join(', ')}`);
    console.log(`  overlap: ${ids1.filter(id => ids2.includes(id)).length} (should be 0)`);
  } catch (err) {
    console.log(`  FAILED: ${err.response?.status} — ${JSON.stringify(err.response?.data)}`);
  }
}

run().catch(err => {
  console.error('Failed:', err.response?.data ?? err.message);
  process.exit(1);
});
