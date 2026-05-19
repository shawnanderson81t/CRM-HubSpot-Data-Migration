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

const PREVIEW_TAGS = [
  'pna',
  'phase_preview-non-attendee',
  'phase_preview-reg',
  'phase_preview-attendee',
  'phase-preview-buyer',
];

async function run() {
  const locationId = config.ghl.locationId;

  const TAG = 'phase-preview-buyer';
  const isoStart = '2024-01-01T00:00:00.000Z';
  const isoEnd   = '2024-04-01T00:00:00.000Z';
  const tsStart  = new Date(isoStart).getTime();
  const tsEnd    = new Date(isoEnd).getTime();

  async function tryFilter(label, filters) {
    try {
      const res = await client.post('/contacts/search', {
        locationId,
        filters,
        pageLimit: 1,
        page: 1,
      });
      console.log(`  ${label}: OK — total=${res.data?.total}, contacts=${(res.data?.contacts ?? []).length}`);
      if (res.data?.contacts?.[0]) {
        console.log(`    dateAdded=${res.data.contacts[0].dateAdded}`);
      }
    } catch (err) {
      console.log(`  ${label}: FAILED ${err.response?.status} — ${JSON.stringify(err.response?.data?.message)}`);
    }
  }

  // Test various date field names and value formats
  await tryFilter('gte/lt ISO, field=dateAdded', [
    { field: 'tags',      operator: 'contains', value: TAG },
    { field: 'dateAdded', operator: 'gte',      value: isoStart },
    { field: 'dateAdded', operator: 'lt',       value: isoEnd },
  ]);

  await tryFilter('gte/lt Unix ms, field=dateAdded', [
    { field: 'tags',      operator: 'contains', value: TAG },
    { field: 'dateAdded', operator: 'gte',      value: tsStart },
    { field: 'dateAdded', operator: 'lt',       value: tsEnd },
  ]);

  await tryFilter('range operator, field=dateAdded', [
    { field: 'tags',      operator: 'contains', value: TAG },
    { field: 'dateAdded', operator: 'range',    value: `${isoStart},${isoEnd}` },
  ]);

  await tryFilter('gte/lt ISO, field=date_added', [
    { field: 'tags',       operator: 'contains', value: TAG },
    { field: 'date_added', operator: 'gte',      value: isoStart },
    { field: 'date_added', operator: 'lt',       value: isoEnd },
  ]);

  await tryFilter('gte/lt ISO, field=createdAt', [
    { field: 'tags',      operator: 'contains', value: TAG },
    { field: 'createdAt', operator: 'gte',      value: isoStart },
    { field: 'createdAt', operator: 'lt',       value: isoEnd },
  ]);

  await tryFilter('gte/lt Unix ms, field=createdAt', [
    { field: 'tags',      operator: 'contains', value: TAG },
    { field: 'createdAt', operator: 'gte',      value: tsStart },
    { field: 'createdAt', operator: 'lt',       value: tsEnd },
  ]);
}

run().catch(err => {
  console.error('Failed:', err.response?.data ?? err.message);
  process.exit(1);
});
