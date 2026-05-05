/**
 * scripts/sample-ghl-endpoints.js
 *
 * Pulls four additional GHL endpoints to complete the data model picture:
 *   - /locations/{id}/customFields  → resolves customField IDs to names/labels
 *   - /locations/{id}/tags          → full tag taxonomy
 *   - /opportunities/pipelines      → pipeline stage definitions
 *   - /opportunities/search         → 10 sample opportunities
 *
 * Output files saved to data/samples/:
 *   ghl-custom-fields.json
 *   ghl-tags.json
 *   ghl-pipelines.json
 *   ghl-opportunities-sample.json
 *
 * Usage:
 *   node scripts/sample-ghl-endpoints.js
 *   npm run sample:ghl-endpoints
 *
 * Required env vars:
 *   GHL_API_KEY      — Private Integration Token
 *   GHL_LOCATION_ID  — GHL sub-account location ID
 */

import 'dotenv/config';
import axios from 'axios';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_VERSION  = process.env.GHL_VERSION  || '2021-07-28';
const OUTPUT_DIR   = './data/samples';

const apiKey     = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;

if (!apiKey)     { console.error('Missing GHL_API_KEY in .env');     process.exit(1); }
if (!locationId) { console.error('Missing GHL_LOCATION_ID in .env'); process.exit(1); }

const client = axios.create({
  baseURL: GHL_BASE_URL,
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Version: GHL_VERSION,
    'Content-Type': 'application/json',
  },
});

/**
 * Saves data to a JSON file and logs the result.
 * @param {string} filename
 * @param {*} data
 */
function save(filename, data) {
  const path = resolve(`${OUTPUT_DIR}/${filename}`);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  console.log(`  Saved → ${filename}`);
}

/**
 * Fetches and saves custom field definitions for the location.
 * These resolve the opaque {id, value} pairs in contact.customFields.
 */
async function fetchCustomFields() {
  console.log('\n[1/4] Custom Fields...');
  const res = await client.get(`/locations/${locationId}/customFields`);
  const fields = res.data?.customFields ?? res.data ?? [];
  save('ghl-custom-fields.json', { total: fields.length, customFields: fields });
  console.log(`      ${fields.length} custom fields found`);

  // Print a quick reference table
  console.log(`\n      ${'ID'.padEnd(25)} ${'Name'.padEnd(30)} Type`);
  console.log(`      ${'─'.repeat(70)}`);
  for (const f of fields) {
    console.log(`      ${f.id?.padEnd(25)} ${f.name?.padEnd(30)} ${f.fieldKey ?? f.dataType ?? ''}`);
  }
}

/**
 * Fetches and saves all tags for the location.
 * Tags contain buyer tier, market/city, engagement status, and more.
 */
async function fetchTags() {
  console.log('\n[2/4] Tags...');
  const res = await client.get(`/locations/${locationId}/tags`);
  const tags = res.data?.tags ?? res.data ?? [];
  save('ghl-tags.json', { total: tags.length, tags });
  console.log(`      ${tags.length} tags found`);
  console.log('\n      All tags:');
  for (const t of tags) {
    const name = typeof t === 'string' ? t : (t.name ?? JSON.stringify(t));
    console.log(`      - ${name}`);
  }
}

/**
 * Fetches and saves pipeline and stage definitions.
 */
async function fetchPipelines() {
  console.log('\n[3/4] Pipelines...');
  const res = await client.get('/opportunities/pipelines', {
    params: { locationId },
  });
  const pipelines = res.data?.pipelines ?? res.data ?? [];
  save('ghl-pipelines.json', { total: pipelines.length, pipelines });
  console.log(`      ${pipelines.length} pipeline(s) found`);
  for (const p of pipelines) {
    console.log(`\n      Pipeline: ${p.name}`);
    for (const s of p.stages ?? []) {
      console.log(`        Stage: ${s.name} (${s.id})`);
    }
  }
}

/**
 * Fetches and saves a small sample of opportunities.
 */
async function fetchOpportunities() {
  console.log('\n[4/4] Opportunities (sample of 10)...');
  const res = await client.get('/opportunities/search', {
    params: { location_id: locationId, limit: 10 },
  });
  const opps = res.data?.opportunities ?? res.data ?? [];
  save('ghl-opportunities-sample.json', res.data);
  console.log(`      ${opps.length} opportunities returned`);

  if (opps.length > 0) {
    console.log('\n      Fields in first opportunity:');
    for (const key of Object.keys(opps[0])) {
      console.log(`        ${key}: ${JSON.stringify(opps[0][key])?.slice(0, 60)}`);
    }
  }
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log('Pulling GHL endpoints...');

  const steps = [fetchCustomFields, fetchTags, fetchPipelines, fetchOpportunities];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      const status = err.response?.status;
      const body   = JSON.stringify(err.response?.data ?? {});
      console.error(`  FAIL HTTP ${status ?? 'network error'} — ${body || err.message}`);
    }
  }

  console.log('\nDone. Check data/samples/ for all output files.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
