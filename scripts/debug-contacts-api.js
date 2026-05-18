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

  // Test 1: POST /contacts/search with tag filter (recommended modern endpoint)
  console.log('\nTest 1 — POST /contacts/search with tag filter (pna)...');
  try {
    const res = await client.post('/contacts/search', {
      locationId,
      filters: [
        { field: 'tags', operator: 'CONTAINS', value: 'pna' }
      ],
      page: 1,
      pageSize: 5,
    });
    console.log(`  Status: OK`);
    console.log(`  Contacts returned: ${(res.data?.contacts ?? []).length}`);
    console.log(`  Meta: ${JSON.stringify(res.data?.meta ?? res.data?.total ?? {})}`);
    if (res.data?.contacts?.length) {
      console.log(`  First contact tags: ${JSON.stringify(res.data.contacts[0].tags?.slice(0, 5))}`);
    }
  } catch (err) {
    console.log(`  FAILED: ${err.response?.status} — ${JSON.stringify(err.response?.data)}`);
  }

  // Test 2: POST /contacts/search with alternative filter format
  console.log('\nTest 2 — POST /contacts/search alternative filter format...');
  try {
    const res = await client.post('/contacts/search', {
      locationId,
      filters: [
        {
          group: 'AND',
          filters: [
            { type: 'FIELD', field: { key: 'tags' }, condition: 'CONTAINS', value: 'pna' }
          ]
        }
      ],
      page: 1,
      pageSize: 5,
    });
    console.log(`  Status: OK`);
    console.log(`  Contacts returned: ${(res.data?.contacts ?? []).length}`);
    console.log(`  Meta: ${JSON.stringify(res.data?.meta ?? res.data?.total ?? {})}`);
  } catch (err) {
    console.log(`  FAILED: ${err.response?.status} — ${JSON.stringify(err.response?.data)}`);
  }

  // Test 3: GET /contacts/search (some GHL versions use GET)
  console.log('\nTest 3 — GET /contacts/search with tag param...');
  try {
    const res = await client.get('/contacts/search', {
      params: { locationId, limit: 5, tag: 'pna' },
    });
    console.log(`  Status: OK`);
    console.log(`  Contacts returned: ${(res.data?.contacts ?? []).length}`);
    console.log(`  Response keys: ${Object.keys(res.data ?? {}).join(', ')}`);
  } catch (err) {
    console.log(`  FAILED: ${err.response?.status} — ${JSON.stringify(err.response?.data)}`);
  }

  // Test 4: GET /contacts/ with tags[] filter param
  console.log('\nTest 4 — GET /contacts/ with tags param...');
  try {
    const res = await client.get('/contacts/', {
      params: { locationId, limit: 5, 'filters[tags]': 'pna' },
    });
    console.log(`  Contacts returned: ${(res.data?.contacts ?? []).length}`);
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
