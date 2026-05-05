/**
 * scripts/pull-hubspot-schema.js
 *
 * Fetches all contact properties from HubSpot and saves the full list to
 * data/samples/hubspot-schema.json so we can see what already exists vs
 * what needs to be created before migration.
 *
 * Usage:
 *   node scripts/pull-hubspot-schema.js
 *   npm run schema:hs
 *
 * Required env vars:
 *   HUBSPOT_API_KEY — HubSpot Service Key (Super Admin level)
 */

import 'dotenv/config';
import axios from 'axios';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const HS_BASE_URL   = process.env.HUBSPOT_BASE_URL        || 'https://api.hubapi.com';
const OUTPUT_PATH   = resolve(process.env.HS_SCHEMA_OUTPUT_PATH || './data/samples/hubspot-schema.json');

const apiKey = process.env.HUBSPOT_API_KEY;
if (!apiKey) { console.error('Missing HUBSPOT_API_KEY in .env'); process.exit(1); }

const client = axios.create({
  baseURL: HS_BASE_URL,
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
});

/**
 * Fetches all contact properties from HubSpot CRM v3.
 * @returns {Promise<Array>} Full array of property objects
 */
async function fetchAllContactProperties() {
  console.log('Fetching HubSpot contact properties...');
  const res = await client.get('/crm/v3/properties/contacts', {
    params: { archived: false },
  });
  return res.data?.results ?? [];
}

/**
 * Prints a summary table of properties grouped by source (built-in vs custom).
 * @param {Array} properties
 */
function printSummary(properties) {
  const custom   = properties.filter(p => p.hubspotDefined === false);
  const builtIn  = properties.filter(p => p.hubspotDefined === true);

  const byType = {};
  for (const p of properties) {
    byType[p.type] = (byType[p.type] ?? 0) + 1;
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`HUBSPOT SCHEMA SUMMARY — ${properties.length} contact properties`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`  HubSpot built-in : ${builtIn.length}`);
  console.log(`  Custom (yours)   : ${custom.length}`);
  console.log(`\nBy field type:`);
  for (const [type, count] of Object.entries(byType).sort(([, a], [, b]) => b - a)) {
    console.log(`  ${type.padEnd(20)} ${count}`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log('CUSTOM PROPERTIES (non-HubSpot-defined):');
  console.log(`${'─'.repeat(60)}`);
  console.log(`${'Name'.padEnd(40)} ${'Type'.padEnd(15)} Label`);
  console.log(`${'─'.repeat(60)}`);
  for (const p of custom.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`${p.name.padEnd(40)} ${p.type.padEnd(15)} ${p.label}`);
  }
  console.log(`${'─'.repeat(60)}\n`);
}

async function main() {
  let properties;
  try {
    properties = await fetchAllContactProperties();
  } catch (err) {
    const status = err.response?.status;
    const body   = JSON.stringify(err.response?.data ?? {});
    console.error(`FAIL  HTTP ${status ?? 'network error'} — ${body || err.message}`);
    process.exit(1);
  }

  mkdirSync('./data/samples', { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify({ total: properties.length, properties }, null, 2), 'utf8');
  console.log(`\nSchema saved to: ${OUTPUT_PATH}`);
  console.log(`Total properties: ${properties.length}`);

  printSummary(properties);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
