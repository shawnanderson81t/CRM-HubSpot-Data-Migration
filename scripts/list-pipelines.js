/**
 * List all GHL pipelines with their IDs, names, and opportunity counts.
 * Run this to identify which pipelines contain Preview Buyers.
 *
 * Usage:
 *   node scripts/list-pipelines.js
 */

import 'dotenv/config';
import axios from 'axios';

const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_VERSION  = process.env.GHL_VERSION  || '2021-07-28';
const apiKey       = process.env.GHL_API_KEY;
const locationId   = process.env.GHL_LOCATION_ID;

if (!apiKey)     { console.error('Missing GHL_API_KEY');     process.exit(1); }
if (!locationId) { console.error('Missing GHL_LOCATION_ID'); process.exit(1); }

const client = axios.create({
  baseURL: GHL_BASE_URL,
  headers: { Authorization: `Bearer ${apiKey}`, Version: GHL_VERSION },
});

async function getOppCount(pipelineId) {
  try {
    const res = await client.get('/opportunities/search', {
      params: { location_id: locationId, pipeline_id: pipelineId, limit: 1, page: 1 },
    });
    return res.data?.meta?.total ?? '?';
  } catch {
    return '?';
  }
}

async function run() {
  const res = await client.get('/opportunities/pipelines', {
    params: { locationId },
  });
  const pipelines = res.data?.pipelines ?? [];

  console.log(`\n${'#'.padEnd(4)} ${'Pipeline Name'.padEnd(40)} ${'ID'.padEnd(25)} Opps`);
  console.log('─'.repeat(90));

  for (let i = 0; i < pipelines.length; i++) {
    const p = pipelines[i];
    const count = await getOppCount(p.id);
    console.log(`${String(i + 1).padEnd(4)} ${(p.name ?? '').padEnd(40)} ${p.id.padEnd(25)} ${count}`);
  }

  console.log(`\nTotal pipelines: ${pipelines.length}`);
}

run().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
