/**
 * scripts/test-ghl-connection.js
 *
 * Read-only connection test: hits GET /locations/{locationId} using the
 * GHL Private Integration Token directly as a Bearer token. No writes.
 *
 * Usage:
 *   node scripts/test-ghl-connection.js
 *   npm run test:ghl
 *
 * Required env vars:
 *   GHL_API_KEY      — Private Integration Token from GHL Settings > Private Integrations
 *   GHL_LOCATION_ID  — GHL sub-account location ID
 */

import 'dotenv/config';
import axios from 'axios';

const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_VERSION  = process.env.GHL_VERSION  || '2021-07-28';

const apiKey     = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;

if (!apiKey)     { console.error('Missing GHL_API_KEY in .env');     process.exit(1); }
if (!locationId) { console.error('Missing GHL_LOCATION_ID in .env'); process.exit(1); }

console.log('Testing GHL connection...');
console.log('GET /locations/' + locationId + '\n');

try {
  const res = await axios.get(`${GHL_BASE_URL}/locations/${locationId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: GHL_VERSION,
    },
  });

  const loc = res.data?.location ?? res.data;
  console.log('Connection OK');
  console.log('  Name    :', loc.name     ?? '—');
  console.log('  Email   :', loc.email    ?? '—');
  console.log('  Phone   :', loc.phone    ?? '—');
  console.log('  Country :', loc.country  ?? '—');
} catch (err) {
  const status = err.response?.status;
  const body   = JSON.stringify(err.response?.data ?? {});
  console.error(`FAIL  HTTP ${status ?? 'network error'} — ${body || err.message}`);
  process.exit(1);
}
