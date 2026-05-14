/**
 * Creates all HubSpot contact properties needed for the GHL migration.
 * Covers both our new properties AND Andy's PROD custom properties (for sandbox sync).
 *
 * Idempotent — safe to run multiple times. Skips anything that already exists.
 * Writes a JSON report to data/reports/property-setup-[timestamp].json
 *
 * Usage: npm run create-properties
 */

import axios from 'axios';
import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(__dirname, '../data/reports');
const BASE_URL = 'https://api.hubapi.com/crm/v3/properties/contacts';

const headers = {
  Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
  'Content-Type': 'application/json',
};

const PROPERTIES_TO_CREATE = [
  // --- Our new properties ---
  {
    name: 'engager_contact_id',
    label: 'Engager Contact ID',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Original GoHighLevel/Engager contact ID — rollback key and highest-confidence dedup anchor',
    options: [],
  },
  {
    name: 'buyer_tier',
    label: 'Buyer Tier',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    description: 'Contact buyer classification derived from GHL tags (highest priority tag wins)',
    options: [
      { label: 'Workshop Buyer - Diamond', value: 'Workshop Buyer - Diamond', displayOrder: 0, hidden: false },
      { label: 'Workshop Buyer',           value: 'Workshop Buyer',           displayOrder: 1, hidden: false },
      { label: 'Telesales Diamond Buyer',  value: 'Telesales Diamond Buyer',  displayOrder: 2, hidden: false },
      { label: 'Telesales Buyer',          value: 'Telesales Buyer',          displayOrder: 3, hidden: false },
      { label: 'Preview Buyer',            value: 'Preview Buyer',            displayOrder: 4, hidden: false },
      { label: 'Preview Attendee',         value: 'Preview Attendee',         displayOrder: 5, hidden: false },
      { label: 'Preview Registrant',       value: 'Preview Registrant',       displayOrder: 6, hidden: false },
      { label: 'Preview Non-Attendee',     value: 'Preview Non-Attendee',     displayOrder: 7, hidden: false },
      { label: 'Registrant',               value: 'Registrant',               displayOrder: 8, hidden: false },
    ],
  },
  {
    name: 'utm_source',
    label: 'UTM Source',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Registration source from first GHL attribution (utmSource / sessionSource)',
    options: [],
  },
  {
    name: 'utm_medium',
    label: 'UTM Medium',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Registration medium from first GHL attribution (e.g. facebook, zapier, form)',
    options: [],
  },
  {
    name: 'community_join_date',
    label: 'Community Join Date',
    type: 'date',
    fieldType: 'date',
    groupName: 'contactinformation',
    description: 'Date the contact joined the TLC community',
    options: [],
  },
  {
    name: 'cancellation_status',
    label: 'Cancellation Status',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    description: 'Cancellation type derived from GHL tags',
    options: [
      { label: 'Workshop Cancelled',    value: 'Workshop Cancelled',    displayOrder: 0, hidden: false },
      { label: 'Foundations Cancelled', value: 'Foundations Cancelled', displayOrder: 1, hidden: false },
      { label: 'All Cancelled',         value: 'All Cancelled',         displayOrder: 2, hidden: false },
    ],
  },
  {
    name: 'fulfillment_status',
    label: 'Fulfillment Status',
    type: 'enumeration',
    fieldType: 'checkbox',
    groupName: 'contactinformation',
    description: 'Active fulfillment products/services — multi-select, derived from GHL tags',
    options: [
      { label: 'Coaching Purchased', value: 'Coaching Purchased', displayOrder: 0, hidden: false },
      { label: 'Coaching Active',    value: 'Coaching Active',    displayOrder: 1, hidden: false },
      { label: 'Community Active',   value: 'Community Active',   displayOrder: 2, hidden: false },
      { label: 'Portal Active',      value: 'Portal Active',      displayOrder: 3, hidden: false },
      { label: 'Marketplace Active', value: 'Marketplace Active', displayOrder: 4, hidden: false },
      { label: 'Subscribed',         value: 'Subscribed',         displayOrder: 5, hidden: false },
    ],
  },

  // --- Andy's PROD properties (needed in sandbox for pilot testing) ---
  // These use string/text so sandbox accepts semicolon-separated multi-values without needing exact option lists.
  {
    name: 'products_purchased',
    label: 'Products Purchased',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Products purchased by the contact (multi-value from GHL)',
    options: [],
  },
  {
    name: 'workshop_team',
    label: 'Workshop Team',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Workshop sales team assignment',
    options: [],
  },
  {
    name: 'workshop_product_package',
    label: 'Workshop Product Package',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Workshop product package selected',
    options: [],
  },
  {
    name: 'eventtag',
    label: 'Event Tag',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Event city tags (semicolon-separated) from GHL geo resolver',
    options: [],
  },
  {
    name: 'workshop_paid',
    label: 'Workshop Paid',
    type: 'number',
    fieldType: 'number',
    groupName: 'contactinformation',
    description: 'Amount paid toward workshop',
    options: [],
  },
  {
    name: 'workshop_payment_type',
    label: 'Workshop Payment Type',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Workshop payment method(s)',
    options: [],
  },
  {
    name: 'workshop_payment_status',
    label: 'Workshop Payment Status',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Current workshop payment status',
    options: [],
  },
  {
    name: 'workshop_payment_balance',
    label: 'Workshop Payment Balance',
    type: 'number',
    fieldType: 'number',
    groupName: 'contactinformation',
    description: 'Remaining balance owed for workshop',
    options: [],
  },
  {
    name: 'workshop_payment_history',
    label: 'Workshop Payment History',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Full payment history log for workshop',
    options: [],
  },
  {
    name: 'workshop_total',
    label: 'Workshop Total',
    type: 'number',
    fieldType: 'number',
    groupName: 'contactinformation',
    description: 'Total workshop purchase price',
    options: [],
  },
  {
    name: 'workshop_purchase_date',
    label: 'Workshop Purchase Date',
    type: 'date',
    fieldType: 'date',
    groupName: 'contactinformation',
    description: 'Date the workshop was purchased',
    options: [],
  },
  {
    name: 'preview_payment_status',
    label: 'Preview Payment Status',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Current preview event payment status',
    options: [],
  },
  {
    name: 'preview_payment_methods',
    label: 'Preview Payment Methods',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Payment methods used for preview purchase',
    options: [],
  },
  {
    name: 'preview_sales_total',
    label: 'Preview Sales Total',
    type: 'number',
    fieldType: 'number',
    groupName: 'contactinformation',
    description: 'Total preview sales amount',
    options: [],
  },
  {
    name: 'preview_purchase_date',
    label: 'Preview Purchase Date',
    type: 'date',
    fieldType: 'date',
    groupName: 'contactinformation',
    description: 'Date the preview was purchased',
    options: [],
  },
  {
    name: 'preview_attendance_status',
    label: 'Preview Attendance Status',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Preview event attendance status',
    options: [],
  },
  {
    name: 'preview_sales_rep',
    label: 'Preview Sales Rep',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Sales rep assigned to preview purchase',
    options: [],
  },
  {
    name: 'market_name',
    label: 'Market Name',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Geographic market name from GHL geo custom field',
    options: [],
  },
  {
    name: 'sms_engmt_score',
    label: 'SMS Engagement Score',
    type: 'number',
    fieldType: 'number',
    groupName: 'contactinformation',
    description: 'SMS engagement score from GHL',
    options: [],
  },
  {
    name: 'email_engmt_score',
    label: 'Email Engagement Score',
    type: 'number',
    fieldType: 'number',
    groupName: 'contactinformation',
    description: 'Email engagement score from GHL',
    options: [],
  },

  // --- Additional Andy's PROD properties (remaining from CUSTOM_FIELD_ID_MAP) ---
  {
    name: 'payment_transaction_id',
    label: 'Payment Transaction ID',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Workshop payment transaction ID from GHL',
    options: [],
  },
  {
    name: 'preview_payment_balance',
    label: 'Preview Payment Balance',
    type: 'number',
    fieldType: 'number',
    groupName: 'contactinformation',
    description: 'Remaining balance owed for preview purchase',
    options: [],
  },
  {
    name: 'preview_paid',
    label: 'Preview Paid',
    type: 'number',
    fieldType: 'number',
    groupName: 'contactinformation',
    description: 'Amount paid toward preview event',
    options: [],
  },
  {
    name: 'preview_invoice_id_payment_id',
    label: 'Preview Invoice / Payment ID',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Preview event invoice or payment ID from GHL',
    options: [],
  },
  {
    name: 'number_of_coaching_sessions_purchased',
    label: 'Coaching Sessions Purchased',
    type: 'number',
    fieldType: 'number',
    groupName: 'contactinformation',
    description: 'Number of coaching sessions purchased',
    options: [],
  },
  {
    name: 'assigned_coach',
    label: 'Assigned Coach',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Coach assigned to this contact',
    options: [],
  },
  {
    name: 'coaching_sessions_fulfilled',
    label: 'Coaching Sessions Fulfilled',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Coaching sessions fulfilled (multi-value from GHL)',
    options: [],
  },
  {
    name: 'telesales_repteam',
    label: 'Telesales Rep / Team',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Telesales rep or team assignment (multi-value from GHL)',
    options: [],
  },
];

/** Options to add to the existing event_type property (4 confirmed missing) */
const EVENT_TYPE_NEW_OPTIONS = [
  { label: 'Foundations', value: 'Foundations', displayOrder: 3, hidden: false },
  { label: 'Commercial',  value: 'Commercial',  displayOrder: 4, hidden: false },
  { label: 'Expo',        value: 'Expo',        displayOrder: 5, hidden: false },
  { label: 'Fly Out',     value: 'Fly Out',     displayOrder: 6, hidden: false },
];

/**
 * Fetch a HubSpot contact property by name.
 * @param {string} propertyName
 * @returns {Promise<object|null>}
 */
async function getProperty(propertyName) {
  try {
    const res = await axios.get(`${BASE_URL}/${propertyName}`, { headers });
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

/**
 * Create a new HubSpot contact property.
 * @param {object} property
 * @returns {Promise<object>}
 */
async function createProperty(property) {
  const res = await axios.post(BASE_URL, property, { headers });
  return res.data;
}

/**
 * Add new options to an existing enumeration property.
 * Fetches current options first so existing ones are preserved.
 * @param {string} propertyName
 * @param {object[]} newOptions
 * @returns {Promise<{skipped: boolean, added?: string[], reason?: string}>}
 */
async function addOptionsToProperty(propertyName, newOptions) {
  const existing = await getProperty(propertyName);
  if (!existing) throw new Error(`Property "${propertyName}" not found in HubSpot`);

  const existingValues = new Set(existing.options.map(o => o.value));
  const toAdd = newOptions.filter(o => !existingValues.has(o.value));

  if (toAdd.length === 0) {
    return { skipped: true, reason: 'all options already exist' };
  }

  // Assign display orders after the existing max to avoid conflicts
  const maxOrder = existing.options.reduce((max, o) => Math.max(max, o.displayOrder ?? 0), 0);
  toAdd.forEach((o, i) => { o.displayOrder = maxOrder + 1 + i; });

  const merged = [...existing.options, ...toAdd];
  await axios.patch(`${BASE_URL}/${propertyName}`, { options: merged }, { headers });
  return { skipped: false, added: toAdd.map(o => o.label) };
}

async function run() {
  if (!process.env.HUBSPOT_API_KEY) {
    console.error('ERROR: HUBSPOT_API_KEY is not set in .env');
    process.exit(1);
  }

  const report = {
    timestamp: new Date().toISOString(),
    hubspotApiKey: `${process.env.HUBSPOT_API_KEY.slice(0, 8)}...`,
    summary: { created: 0, skipped: 0, failed: 0, eventTypeOptionsAdded: 0 },
    properties: [],
    eventTypeUpdate: null,
  };

  console.log('=== HubSpot Property Setup ===');
  console.log(`  API key : ${report.hubspotApiKey}`);
  console.log(`  Target  : ${BASE_URL}\n`);

  for (const prop of PROPERTIES_TO_CREATE) {
    try {
      const existing = await getProperty(prop.name);
      if (existing) {
        console.log(`  SKIP  ${prop.name}  (already exists)`);
        report.summary.skipped++;
        report.properties.push({ name: prop.name, label: prop.label, status: 'skipped', reason: 'already exists' });
      } else {
        await createProperty(prop);
        console.log(`  OK    ${prop.name}`);
        report.summary.created++;
        report.properties.push({ name: prop.name, label: prop.label, status: 'created' });
      }
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error(`  FAIL  ${prop.name}  — ${msg}`);
      report.summary.failed++;
      report.properties.push({ name: prop.name, label: prop.label, status: 'failed', error: msg });
    }
  }

  console.log('\n  Updating event_type options...');
  try {
    const result = await addOptionsToProperty('event_type', EVENT_TYPE_NEW_OPTIONS);
    if (result.skipped) {
      console.log(`  SKIP  event_type options  (${result.reason})`);
      report.eventTypeUpdate = { status: 'skipped', reason: result.reason };
    } else {
      console.log(`  OK    event_type — added: ${result.added.join(', ')}`);
      report.summary.eventTypeOptionsAdded = result.added.length;
      report.eventTypeUpdate = { status: 'updated', optionsAdded: result.added };
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error(`  FAIL  event_type — ${msg}`);
    report.eventTypeUpdate = { status: 'failed', error: msg };
  }

  // Save report
  mkdirSync(REPORT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFile = `property-setup-${timestamp}.json`;
  const reportPath = join(REPORT_DIR, reportFile);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('\n=== Summary ===');
  console.log(`  Created              : ${report.summary.created}`);
  console.log(`  Skipped              : ${report.summary.skipped}`);
  console.log(`  Failed               : ${report.summary.failed}`);
  console.log(`  event_type options   : +${report.summary.eventTypeOptionsAdded}`);
  console.log(`\n  Report saved: data/reports/${reportFile}`);

  if (report.summary.failed > 0) {
    console.error('\n  Some properties failed — check report for details.');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
