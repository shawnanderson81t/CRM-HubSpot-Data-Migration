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
  const res = await client.get('/contacts/', {
    params: { locationId: config.ghl.locationId, limit: 5 },
  });

  const contacts = res.data?.contacts ?? [];
  console.log(`\nContacts returned: ${contacts.length}`);
  console.log(`\nFields present on first contact:`);
  console.log(Object.keys(contacts[0] ?? {}).join(', '));

  console.log(`\nFirst 5 contacts — tags field:`);
  for (const c of contacts) {
    const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
    const tags = c.tags;
    console.log(`  ${c.id}  ${name.padEnd(25)}  tags type=${typeof tags}  value=${JSON.stringify(tags)}`);
  }
}

run().catch(err => {
  console.error('Failed:', err.response?.data ?? err.message);
  process.exit(1);
});
