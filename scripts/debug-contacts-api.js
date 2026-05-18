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

async function run() {
  const locationId = config.ghl.locationId;

  // Test 1: single tag, correct field names from error message
  console.log('\nTest 1 — single tag filter (contains, pageLimit)...');
  try {
    const res = await client.post('/contacts/search', {
      locationId,
      filters: [{ field: 'tags', operator: 'contains', value: 'pna' }],
      pageLimit: 5,
    });
    console.log(`  OK — contacts: ${(res.data?.contacts ?? []).length}`);
    console.log(`  Response keys: ${Object.keys(res.data ?? {}).join(', ')}`);
    console.log(`  Meta: ${JSON.stringify(res.data?.meta ?? {})}`);
    if (res.data?.contacts?.[0]) {
      console.log(`  First contact tags: ${JSON.stringify(res.data.contacts[0].tags?.slice(0, 5))}`);
    }
  } catch (err) {
    console.log(`  FAILED: ${err.response?.status} — ${JSON.stringify(err.response?.data)}`);
  }

  // Test 2: try contains_set operator (may match "tag is in array")
  console.log('\nTest 2 — contains_set operator...');
  try {
    const res = await client.post('/contacts/search', {
      locationId,
      filters: [{ field: 'tags', operator: 'contains_set', value: 'pna' }],
      pageLimit: 5,
    });
    console.log(`  OK — contacts: ${(res.data?.contacts ?? []).length}`);
    if (res.data?.contacts?.[0]) {
      console.log(`  First contact tags: ${JSON.stringify(res.data.contacts[0].tags?.slice(0, 5))}`);
    }
  } catch (err) {
    console.log(`  FAILED: ${err.response?.status} — ${JSON.stringify(err.response?.data)}`);
  }

  // Test 3: OR across multiple preview tags using nested filters
  console.log('\nTest 3 — OR across multiple preview tags...');
  try {
    const res = await client.post('/contacts/search', {
      locationId,
      filters: [
        { field: 'tags', operator: 'contains', value: 'pna' },
        { field: 'tags', operator: 'contains', value: 'phase_preview-attendee' },
      ],
      pageLimit: 5,
    });
    console.log(`  OK — contacts: ${(res.data?.contacts ?? []).length}`);
    if (res.data?.contacts?.[0]) {
      console.log(`  First contact tags: ${JSON.stringify(res.data.contacts[0].tags?.slice(0, 5))}`);
    }
  } catch (err) {
    console.log(`  FAILED: ${err.response?.status} — ${JSON.stringify(err.response?.data)}`);
  }
}

run().catch(err => {
  console.error('Failed:', err.response?.data ?? err.message);
  process.exit(1);
});
