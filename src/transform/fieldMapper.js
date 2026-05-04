import { logger } from '../utils/logger.js';

/**
 * GHL field → HubSpot property mapping definitions
 * This is the source of truth for all field transformations
 *
 * UPDATE THIS MAP after Phase 1 discovery when you've confirmed
 * actual GHL field names from the API/export
 */
const FIELD_MAP = {
  // GHL field name          → HubSpot property name + transform
  'email':                   { hubspot: 'email', transform: null },
  'firstName':               { hubspot: 'firstname', transform: null },
  'lastName':                { hubspot: 'lastname', transform: null },
  'phone':                   { hubspot: 'phone', transform: 'normalizePhone' },
  'address1':                { hubspot: 'address', transform: null },
  'city':                    { hubspot: 'city', transform: null },
  'state':                   { hubspot: 'state', transform: null },
  'postalCode':              { hubspot: 'zip', transform: null },

  // Custom fields — these map to the new HubSpot custom properties
  // GHL tag names TBD — update after Phase 1 audit
  'ghl_geolocation_tag':     { hubspot: 'market_city', transform: 'resolveMarketCity' },
  'ghl_event_type_tag':      { hubspot: 'event_type', transform: 'resolveEventType' },
  'ghl_attendance_source':   { hubspot: 'attendance_origin', transform: null },
  'ghl_buyer_classification':{ hubspot: 'buyer_tier', transform: 'resolveBuyerTier' },
  'ghl_payment_method':      { hubspot: 'payment_method', transform: null },
  'ghl_payment_status':      { hubspot: 'payment_status', transform: null },
  'ghl_utm_source':          { hubspot: 'registration_source', transform: null },
};

/**
 * Map a single GHL contact record to HubSpot property format
 *
 * @param {Object} ghlContact - Raw GHL contact object
 * @param {Object} existingHubspotData - Existing HubSpot record (for null protection)
 * @returns {Object} HubSpot-formatted contact properties
 */
export function mapContact(ghlContact, existingHubspotData = {}) {
  const properties = {};

  for (const [ghlField, mapping] of Object.entries(FIELD_MAP)) {
    const rawValue = ghlContact[ghlField];

    // CRITICAL: Never overwrite existing HubSpot data with blanks
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      continue;
    }

    // Apply transformation if defined
    let value = rawValue;
    if (mapping.transform) {
      value = applyTransform(mapping.transform, rawValue, ghlContact);
    }

    if (value !== null && value !== undefined) {
      properties[mapping.hubspot] = value;
    }
  }

  return properties;
}

/**
 * Apply a named transformation function to a field value
 * @param {string} transformName
 * @param {*} value
 * @param {Object} fullRecord - Full GHL record for context-dependent transforms
 * @returns {*} Transformed value
 */
function applyTransform(transformName, value, fullRecord) {
  switch (transformName) {
    case 'normalizePhone':
      return normalizePhone(value);
    case 'resolveMarketCity':
      return resolveMarketCity(value, fullRecord);
    case 'resolveEventType':
      return resolveEventType(value);
    case 'resolveBuyerTier':
      return resolveBuyerTier(value);
    default:
      logger.warn(`Unknown transform: ${transformName}`);
      return value;
  }
}

// --- Transform functions (update after Phase 1 discovery) ---

function normalizePhone(phone) {
  if (!phone) return null;
  // Strip everything except digits and leading +
  const cleaned = phone.replace(/[^\d+]/g, '');
  // TODO: Add country code logic if needed
  return cleaned || null;
}

/**
 * Resolve GHL geolocation tags to market_city dropdown values
 * GHL uses tags like "Orlando Workshop", "Fort Myers Manual Override"
 * This needs to extract the city name and check for manual override flag
 *
 * @param {string} geoTag - GHL geolocation tag value
 * @param {Object} fullRecord - Full record to check override flags
 * @returns {string|null} HubSpot market_city value
 */
function resolveMarketCity(geoTag, fullRecord) {
  // TODO: Build complete mapping after reviewing actual GHL tag values
  const CITY_MAP = {
    'orlando': 'Orlando',
    'fort myers': 'Fort Myers',
    'fort_myers': 'Fort Myers',
    'tampa': 'Tampa',
    'miami': 'Miami',
    'jacksonville': 'Jacksonville',
    // Add more after Phase 1 audit
  };

  if (!geoTag) return null;
  const normalized = geoTag.toLowerCase().trim();

  for (const [key, value] of Object.entries(CITY_MAP)) {
    if (normalized.includes(key)) return value;
  }

  logger.warn(`Unmapped market city tag: "${geoTag}"`);
  return null;
}

function resolveEventType(value) {
  // TODO: Map GHL event tags to dropdown values
  const EVENT_MAP = {
    'workshop': 'Workshop',
    'preview': 'Preview',
    'masterclass': 'Masterclass',
  };
  const normalized = (value || '').toLowerCase().trim();
  return EVENT_MAP[normalized] || null;
}

function resolveBuyerTier(value) {
  const TIER_MAP = {
    'buyer': 'Workshop Buyer',
    'workshop buyer': 'Workshop Buyer',
    'preview buyer': 'Preview Buyer',
    'registrant': 'Registrant',
  };
  const normalized = (value || '').toLowerCase().trim();
  return TIER_MAP[normalized] || null;
}

export { FIELD_MAP };
