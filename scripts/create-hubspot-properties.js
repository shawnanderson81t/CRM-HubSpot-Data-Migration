import 'dotenv/config';
import { loadConfig } from '../src/utils/config.js';
import { HubSpotClient } from '../src/load/hubspotClient.js';
import { logger } from '../src/utils/logger.js';

/**
 * Creates all required custom properties in HubSpot
 * Run this ONCE before any data migration begins
 *
 * Usage: node scripts/create-hubspot-properties.js
 */

const CUSTOM_PROPERTIES = [
  {
    name: 'market_city',
    label: 'Market City',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    description: 'Market/city where contact registered or purchased',
    options: [
      { label: 'Orlando', value: 'Orlando' },
      { label: 'Fort Myers', value: 'Fort Myers' },
      { label: 'Tampa', value: 'Tampa' },
      { label: 'Miami', value: 'Miami' },
      { label: 'Jacksonville', value: 'Jacksonville' },
      // TODO: Add remaining cities after Phase 1 audit
    ],
  },
  {
    name: 'event_type',
    label: 'Event Type',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    description: 'Type of event associated with contact',
    options: [
      { label: 'Workshop', value: 'Workshop' },
      { label: 'Preview', value: 'Preview' },
      { label: 'Masterclass', value: 'Masterclass' },
    ],
  },
  {
    name: 'attendance_origin',
    label: 'Attendance Origin',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    description: 'Whether registration was auto-detected or manually overridden',
    options: [
      { label: 'Auto-registered', value: 'auto' },
      { label: 'Manually overridden', value: 'manual' },
    ],
  },
  {
    name: 'buyer_tier',
    label: 'Buyer Tier',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    description: 'Classification of buyer status',
    options: [
      { label: 'Workshop Buyer', value: 'Workshop Buyer' },
      { label: 'Preview Buyer', value: 'Preview Buyer' },
      { label: 'Registrant', value: 'Registrant' },
    ],
  },
  {
    name: 'payment_method',
    label: 'Payment Method',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Payment method used for purchase',
  },
  {
    name: 'payment_status',
    label: 'Payment Status',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    description: 'Current payment status',
    options: [
      { label: 'Paid', value: 'Paid' },
      { label: 'Pending', value: 'Pending' },
      { label: 'Refunded', value: 'Refunded' },
      { label: 'Failed', value: 'Failed' },
    ],
  },
  {
    name: 'registration_source',
    label: 'Registration Source',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'UTM source or registration origin',
  },
];

async function main() {
  const config = loadConfig();
  const hs = new HubSpotClient(config);

  logger.info('Creating custom HubSpot properties...');

  for (const prop of CUSTOM_PROPERTIES) {
    try {
      const result = await hs.createProperty(prop);
      if (result) {
        logger.info(`Created: ${prop.name}`);
      }
    } catch (error) {
      logger.error(`Failed to create ${prop.name}`, { error: error.message });
    }
  }

  // TODO: Create custom association type for guest_of
  // This requires the Associations API v4:
  // POST /crm/v4/associations/contacts/contacts/labels
  // { "name": "guest_of", "label": "Guest Of" }
  logger.info('NOTE: guest_of association type must be created manually or via Associations API v4');

  logger.info('Property creation complete');
}

main().catch((e) => {
  logger.error('Property creation script failed', { error: e.message });
  process.exit(1);
});
