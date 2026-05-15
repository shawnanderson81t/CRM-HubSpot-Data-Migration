import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { loadConfig } from '../src/utils/config.js';
import { HubSpotClient } from '../src/load/hubspotClient.js';
import { cleanRecord } from '../src/transform/cleaner.js';
import { mapContact } from '../src/transform/fieldMapper.js';
import { logger } from '../src/utils/logger.js';

/**
 * Validate pilot results by fetching contacts back from HubSpot
 * and comparing actual values against what fieldMapper expected to write.
 *
 * Usage:
 *   node scripts/validate-pilot.js             # validates first 20 contacts
 *   node scripts/validate-pilot.js --count=50
 *
 * Output: data/reports/validate-pilot-[timestamp].json
 */

const COUNT = parseInt(
  process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '20'
);

// Properties to fetch back from HubSpot for comparison
const PROPS_TO_FETCH = [
  // Standard contact fields
  'email', 'firstname', 'lastname', 'phone', 'company', 'website',
  'address', 'city', 'state', 'zip', 'country', 'hs_timezone', 'lifecyclestage',
  // Our custom / migration fields
  'engager_contact_id', 'buyer_tier', 'fulfillment_status', 'cancellation_status',
  'utm_source', 'utm_medium', 'market_name', 'eventtag',
  'community_join_date', 'assigned_coach', 'telesales_repteam',
  'workshop_paid', 'workshop_total', 'workshop_payment_status', 'workshop_payment_balance',
  'workshop_purchase_date', 'workshop_payment_type', 'workshop_product_package',
  'workshop_team', 'workshop_payment_history',
  'preview_payment_status', 'preview_sales_total', 'preview_purchase_date',
  'preview_attendance_status', 'preview_sales_rep', 'preview_payment_methods',
  'preview_paid', 'preview_payment_balance',
  'products_purchased', 'sms_engmt_score', 'email_engmt_score',
  'number_of_coaching_sessions_purchased', 'coaching_sessions_fulfilled',
  'payment_transaction_id',
  // Event attendance status (James/Jai fulfillment fields)
  'workshop_attendance_status', 'foundations_attendance_status', 'auction_attendance_status',
  'commercial_attendance_status', 'expo_attendance_status', 'summit_attendance_status',
  'symposium_attendance_status',
  // Event date fulfilled
  'workshop_date_fulfilled', 'foundations_date_fulfilled', 'expo_bootcamp_date_fulfilled',
  'auction_date_fulfilled', 'commercial_bootcamp_date_fulfilled', 'flyout_date_fulfilled',
  'summit_date_fulfilled', 'propstream_date_fulfilled',
  // Events attended multi-select
  'tlc_events_attended',
];

// Numeric fields — HubSpot returns them as strings; compare as numbers
const NUMERIC_FIELDS = new Set([
  'workshop_paid', 'workshop_total', 'workshop_payment_balance', 'preview_sales_total',
  'sms_engmt_score', 'email_engmt_score',
]);

// Fields deliberately stripped from update payloads (see batchUpserter.js).
// PROD has duplicate contacts that would cause uniqueness violations if we wrote
// these. Validation skips them entirely — blank/mismatch is expected and correct.
const SKIP_ON_UPDATE = new Set([
  'email', 'phone', 'engager_contact_id',
]);

// Fields where a mismatch is a WARNING (not a hard FAIL) — e.g. optional enrichment
const WARN_ONLY_FIELDS = new Set([
  'utm_source', 'utm_medium', 'cancellation_status',
  // PROD has custom lifecycle stage IDs (e.g. 2107021006) — overwriting with "customer"
  // needs explicit sign-off; treat as warn until confirmed with Andy's team.
  'lifecyclestage',
]);

/**
 * Compare expected (from fieldMapper) vs actual (from HubSpot).
 * Returns array of mismatch objects.
 */
function compareContact(email, expected, actual) {
  const mismatches = [];

  for (const [key, expVal] of Object.entries(expected)) {
    if (key === 'hubspot_owner_id') continue; // owner map was empty for sandbox pilot
    if (SKIP_ON_UPDATE.has(key)) continue;    // intentionally not written during updates

    const actVal = actual[key];

    // Expected a value but HubSpot has nothing
    if (expVal !== null && expVal !== undefined && expVal !== '') {
      if (actVal === null || actVal === undefined || actVal === '') {
        mismatches.push({
          field: key,
          expected: expVal,
          actual: actVal ?? '(blank)',
          severity: WARN_ONLY_FIELDS.has(key) ? 'warn' : 'fail',
        });
        continue;
      }
    }

    // Value exists on both sides — compare
    if (actVal !== null && actVal !== undefined && actVal !== '') {
      let matches;
      if (NUMERIC_FIELDS.has(key)) {
        matches = parseFloat(String(expVal)) === parseFloat(String(actVal));
      } else {
        matches = String(expVal).trim() === String(actVal).trim();
      }
      if (!matches) {
        mismatches.push({
          field: key,
          expected: expVal,
          actual: actVal,
          severity: WARN_ONLY_FIELDS.has(key) ? 'warn' : 'fail',
        });
      }
    }
  }

  return mismatches;
}

async function main() {
  const config = loadConfig();
  const hsClient = new HubSpotClient(config);

  let allContacts;
  try {
    allContacts = JSON.parse(readFileSync('./data/samples/workshop-buyers-sample.json', 'utf-8'));
  } catch {
    logger.error('Cannot read workshop-buyers-sample.json — run extract:wb first');
    process.exit(1);
  }

  const contacts = allContacts.slice(0, COUNT);
  logger.info(`Validating ${contacts.length} contacts against HubSpot`);

  // Build expected map: email → expected properties
  const expectedByEmail = new Map();
  for (const raw of contacts) {
    const { cleaned } = cleanRecord(raw);
    const { properties } = mapContact(cleaned);
    const email = (properties.email || '').toLowerCase().trim();
    if (email) expectedByEmail.set(email, properties);
  }

  // Fetch from HubSpot in batches of 100
  const emails = [...expectedByEmail.keys()];
  const hsContacts = await hsClient.batchReadContacts(emails, 'email', PROPS_TO_FETCH);

  const actualByEmail = new Map();
  for (const hs of hsContacts) {
    const email = (hs.properties?.email || '').toLowerCase().trim();
    if (email) actualByEmail.set(email, hs.properties);
  }

  logger.info(`HubSpot returned ${hsContacts.length} of ${emails.length} contacts`);

  // Compare
  const results = [];
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  let notFoundCount = 0;

  for (const [email, expected] of expectedByEmail) {
    const actual = actualByEmail.get(email);

    if (!actual) {
      notFoundCount++;
      results.push({ email, status: 'NOT_FOUND', mismatches: [] });
      console.log(`  NOT_FOUND  ${email}`);
      continue;
    }

    const mismatches = compareContact(email, expected, actual);
    const fails = mismatches.filter(m => m.severity === 'fail');
    const warns = mismatches.filter(m => m.severity === 'warn');

    if (fails.length > 0) {
      failCount++;
      results.push({ email, status: 'FAIL', mismatches });
      console.log(`  FAIL  ${email}`);
      for (const m of fails) {
        console.log(`        [${m.field}] expected="${m.expected}" actual="${m.actual}"`);
      }
    } else if (warns.length > 0) {
      warnCount++;
      results.push({ email, status: 'WARN', mismatches });
      console.log(`  WARN  ${email}`);
      for (const m of warns) {
        console.log(`        [${m.field}] expected="${m.expected}" actual="${m.actual}"`);
      }
    } else {
      passCount++;
      results.push({ email, status: 'PASS', mismatches: [] });
    }
  }

  // Summary
  console.log('\n=== Validation Summary ===');
  console.log(`  Checked    : ${contacts.length}`);
  console.log(`  PASS       : ${passCount}`);
  console.log(`  WARN       : ${warnCount}`);
  console.log(`  FAIL       : ${failCount}`);
  console.log(`  NOT_FOUND  : ${notFoundCount}`);

  const passed = failCount === 0 && notFoundCount === 0;
  console.log(`\n  Result: ${passed ? 'PILOT VALIDATED ✓' : 'ISSUES FOUND — review report'}`);

  // Write report
  mkdirSync('./data/reports', { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = `./data/reports/validate-pilot-${timestamp}.json`;
  writeFileSync(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    portalBaseUrl: config.hubspot.baseUrl,
    checked: contacts.length,
    summary: { pass: passCount, warn: warnCount, fail: failCount, notFound: notFoundCount },
    results,
  }, null, 2));
  console.log(`\n  Report: ${reportPath}`);

  if (!passed) process.exit(1);
}

main().catch(err => {
  logger.error('validate-pilot failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
