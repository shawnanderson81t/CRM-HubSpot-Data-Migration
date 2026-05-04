/**
 * scripts/test-ghl-connection.js
 *
 * Read-only connection test: fetches a Bearer token from Engager then hits
 * GET /locations/{locationId} to confirm auth is working. No writes.
 *
 * Usage:
 *   node scripts/test-ghl-connection.js
 *   npm run test:ghl
 */

import 'dotenv/config';
import axios from 'axios';

const ENGAGER_TOKEN_URL = process.env.GHL_ENGAGER_TOKEN_URL || 'https://api.engager.ai/get-token';
const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_VERSION = process.env.GHL_VERSION || '2021-07-28';

const secretKey = process.env.GHL_ENGAGER_SECRET_KEY;
const locationId = process.env.GHL_LOCATION_ID;

if (!secretKey) { console.error('Missing GHL_ENGAGER_SECRET_KEY in .env'); process.exit(1); }
if (!locationId) { console.error('Missing GHL_LOCATION_ID in .env'); process.exit(1); }

console.log('Step 1/2  Fetching Engager token...');
let token;
try {
  const res = await axios.get(`${ENGAGER_TOKEN_URL}/${secretKey}`);
  token = res.data?.token ?? (typeof res.data === 'string' ? res.data : null);
  if (!token) throw new Error(`Unexpected response shape: ${JSON.stringify(res.data)}`);
  console.log('          Token received.\n');
} catch (err) {
  console.error('FAIL  Token fetch failed:', err.message);
  process.exit(1);
}

console.log('Step 2/2  GET /locations/' + locationId);
try {
  const res = await axios.get(`${GHL_BASE_URL}/locations/${locationId}`, {
    headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION },
  });
  const loc = res.data?.location ?? res.data;
  console.log('\nConnection OK');
  console.log('  Name    :', loc.name ?? '—');
  console.log('  Email   :', loc.email ?? '—');
  console.log('  Phone   :', loc.phone ?? '—');
  console.log('  Country :', loc.country ?? '—');
} catch (err) {
  const status = err.response?.status;
  const body = JSON.stringify(err.response?.data ?? {});
  console.error(`\nFAIL  HTTP ${status ?? 'network error'} — ${body || err.message}`);
  process.exit(1);
}
