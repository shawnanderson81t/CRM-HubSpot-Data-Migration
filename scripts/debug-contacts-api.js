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
  // Test 1: plain list — check meta for total count
  const res1 = await client.get('/contacts/', {
    params: { locationId: config.ghl.locationId, limit: 5 },
  });
  console.log(`\nTest 1 — plain list meta:`);
  console.log(JSON.stringify(res1.data?.meta ?? {}, null, 2));

  // Test 2: with startDate/endDate — does GHL support date filtering?
  const res2 = await client.get('/contacts/', {
    params: {
      locationId: config.ghl.locationId,
      limit: 5,
      startDate: '2024-01-01T00:00:00.000Z',
      endDate:   '2024-06-30T23:59:59.999Z',
    },
  });
  console.log(`\nTest 2 — with startDate/endDate (2024 H1):`);
  console.log(`  contacts returned: ${(res2.data?.contacts ?? []).length}`);
  console.log(`  meta: ${JSON.stringify(res2.data?.meta ?? {})}`);
  if (res2.data?.contacts?.length) {
    console.log(`  first contact dateAdded: ${res2.data.contacts[0].dateAdded}`);
  }

  // Test 3: with query param — does GHL support tag search?
  const res3 = await client.get('/contacts/', {
    params: {
      locationId: config.ghl.locationId,
      limit: 5,
      query: 'pna',
    },
  });
  console.log(`\nTest 3 — with query=pna:`);
  console.log(`  contacts returned: ${(res3.data?.contacts ?? []).length}`);
  if (res3.data?.contacts?.length) {
    console.log(`  first contact tags: ${JSON.stringify(res3.data.contacts[0].tags)}`);
  }
}

run().catch(err => {
  console.error('Failed:', err.response?.data ?? err.message);
  process.exit(1);
});
