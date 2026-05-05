/**
 * scripts/sample-ghl-contacts.js
 *
 * Pulls the first 100 contacts from GET /contacts/ and writes the raw JSON
 * response to data/samples/ghl-sample-100.json so we can map every field.
 *
 * Usage:
 *   node scripts/sample-ghl-contacts.js
 *   npm run sample:ghl
 *
 * Required env vars:
 *   GHL_API_KEY      — Private Integration Token from GHL Settings > Private Integrations
 *   GHL_LOCATION_ID  — GHL sub-account location ID
 */

import 'dotenv/config';
import axios from 'axios';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const GHL_BASE_URL  = process.env.GHL_BASE_URL         || 'https://services.leadconnectorhq.com';
const GHL_VERSION   = process.env.GHL_VERSION          || '2021-07-28';
const OUTPUT_PATH   = resolve(process.env.GHL_SAMPLE_OUTPUT_PATH || './data/samples/ghl-sample-100.json');
const SAMPLE_LIMIT  = parseInt(process.env.GHL_SAMPLE_LIMIT || '100', 10);

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

/**
 * Fetches one page of contacts from GHL using the Private Integration Token.
 * @param {string} apiKey
 * @param {string} locationId
 * @returns {Promise<Object>} Raw response body
 */
async function fetchContactsPage(apiKey, locationId) {
  console.log(`Fetching first ${SAMPLE_LIMIT} contacts from GHL...`);
  const res = await axios.get(`${GHL_BASE_URL}/contacts/`, {
    params: { locationId, limit: SAMPLE_LIMIT },
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
  });
  return res.data;
}

/**
 * Prints a field presence table and sample values for each field across all contacts.
 * @param {Array<Object>} contacts
 */
function printFieldSummary(contacts) {
  const fieldCounts = {};
  for (const contact of contacts) {
    for (const key of Object.keys(contact)) {
      fieldCounts[key] = (fieldCounts[key] ?? 0) + 1;
    }
  }

  const fields = Object.entries(fieldCounts).sort(([, a], [, b]) => b - a);

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`FIELD SUMMARY — ${contacts.length} contacts sampled`);
  console.log(`${'─'.repeat(55)}`);
  console.log(`${'Field'.padEnd(35)} Present in`);
  console.log(`${'─'.repeat(55)}`);
  for (const [field, count] of fields) {
    const pct = ((count / contacts.length) * 100).toFixed(0).padStart(3);
    console.log(`${field.padEnd(35)} ${count}/${contacts.length} (${pct}%)`);
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log('SAMPLE VALUES (first non-null per field):');
  console.log(`${'─'.repeat(55)}`);
  for (const [field] of fields) {
    const sample  = contacts.find(c => c[field] != null)?.[field];
    const display = JSON.stringify(sample);
    const value   = display.length > 60 ? display.slice(0, 57) + '...' : display;
    console.log(`${field.padEnd(35)} ${value}`);
  }
  console.log(`${'─'.repeat(55)}\n`);
}

async function main() {
  const apiKey     = requireEnv('GHL_API_KEY');
  const locationId = requireEnv('GHL_LOCATION_ID');

  const rawResponse = await fetchContactsPage(apiKey, locationId);

  mkdirSync('./data/samples', { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(rawResponse, null, 2), 'utf8');
  console.log(`Raw response saved to: ${OUTPUT_PATH}`);

  const contacts = rawResponse?.contacts ?? rawResponse ?? [];

  if (!Array.isArray(contacts) || contacts.length === 0) {
    console.warn('No contacts array found in response. Check the raw file for the actual shape.');
    console.log('Response keys:', Object.keys(rawResponse ?? {}));
    return;
  }

  console.log(`Contacts returned: ${contacts.length}`);
  if (rawResponse?.meta) {
    console.log('Pagination meta:', JSON.stringify(rawResponse.meta, null, 2));
  }

  printFieldSummary(contacts);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
