import { logger } from '../utils/logger.js';
import { resolveEventTags } from './geoResolver.js';

/**
 * GHL custom field ID → HubSpot property mapping.
 * GHL returns customFields as [{id, value}] — IDs resolved from /custom-fields/ endpoint.
 * HubSpot property name is derived from the GHL fieldKey (contact.xxx → xxx).
 *
 * Special hubspot values:
 *   '_hubspot_contact_id' — not written as a property; returned separately for dedup
 *   '_guest_group_ref'    — not written as a property; returned separately for association pass
 */
const CUSTOM_FIELD_ID_MAP = {
  // --- Dedup / Association ---
  plLjgTFOde5EUxJWWDLl: { hubspot: '_hubspot_contact_id',    transform: null },
  '0F0eNZMequj4JEf4AdgC': { hubspot: '_guest_group_ref',      transform: null },

  // --- Engagement scores (new properties created Day 6) ---
  agPOPXVU1qhYnjJxPz7V: { hubspot: 'sms_engmt_score',        transform: 'integer' },
  dW752RjWvFrfBjpeSoTt: { hubspot: 'email_engmt_score',       transform: 'integer' },

  // --- Geography ---
  XbsASg0C5TDPgSDV2ELo: { hubspot: 'market_name',            transform: null },

  // --- Community ---
  ZwJCtoQ4rG7eqZCJap0e: { hubspot: 'community_join_date',    transform: 'isoDate' },

  // --- Workshop payment ---
  '1rnHjHmUbV5XkqyEVVHx': { hubspot: 'workshop_payment_status',  transform: null },
  '242BK1r5mwKE4NDdEspk': { hubspot: 'workshop_payment_balance', transform: 'decimal' },
  '2xvxtcUmOpov38NTSDCK': { hubspot: 'workshop_payment_history', transform: null },
  eDlnaObiYujDnYMw8JWh: { hubspot: 'workshop_paid',              transform: 'decimal' },
  YZh2Mu66sJeJGrLstXv7: { hubspot: 'workshop_total',             transform: 'decimal' },
  fIDq2FxIMPoE2S6pSdiz: { hubspot: 'workshop_purchase_date',     transform: 'isoDate' },
  kTLTRPGnknC02980X6t9: { hubspot: 'workshop_payment_type',      transform: 'multiSelect' },
  lQyCkSrBQtsO5nOxGgCP: { hubspot: 'payment_transaction_id',     transform: null },

  // --- Preview payment ---
  crA7d9feEZgISV16vIVs: { hubspot: 'preview_payment_status',  transform: null },
  NAVv2mYKtw0dUjaECJDa: { hubspot: 'preview_payment_balance', transform: 'decimal' },
  '5tSC6RTUtYNvLeH3yqSy': { hubspot: 'preview_paid',          transform: 'decimal' },
  oModmzrZ6Xb6Zi3q4SAq: { hubspot: 'preview_purchase_date',   transform: 'isoDate' },
  '7XwHuqb1U7MqSw4D3YLt': { hubspot: 'preview_payment_methods', transform: 'multiSelect' },
  el6MOEH09mMT291Ouhez: { hubspot: 'preview_sales_total',      transform: 'decimal' },
  '0b6zq88gXLBCNzDP325l': { hubspot: 'preview_invoice_id_payment_id', transform: null },
  '1AhH8EKwizmtvm2gw45U': { hubspot: 'preview_attendance_status', transform: null },

  // --- Products / coaching ---
  GbGvpdfbVyeGAvCI1PpX: { hubspot: 'workshop_product_package',             transform: null },
  WuVyUtalsgS5TPA3OhIF: { hubspot: 'products_purchased',                    transform: 'multiSelect' },
  LBzOL7RhOiZMgaveKGor: { hubspot: 'number_of_coaching_sessions_purchased', transform: 'integer' },
  tJH0BERoeDzTDFZpFIZW: { hubspot: 'assigned_coach',                        transform: null },
  '5ltkMoMxesQAoJzpScck': { hubspot: 'coaching_sessions_fulfilled',          transform: 'multiSelect' },

  // --- Sales reps ---
  bmw20X9pY8b8FKwEu3ur: { hubspot: 'workshop_team',   transform: 'multiSelect' },
  sPkhkhdYIas4n3iTuNql: { hubspot: 'preview_sales_rep', transform: 'multiSelect' },
  XH1v6DpEIkJiC2VEvlDb: { hubspot: 'telesales_repteam', transform: 'multiSelect' },

  // --- Event attendance status (James/Jai request — May 15) ---
  Rq7cnsHuFoM5ToszZoMN: { hubspot: 'workshop_attendance_status',    transform: null },
  AslBpu7YJRTEWxGG5Vac: { hubspot: 'foundations_attendance_status', transform: null },
  '8C4y1RyeYLG3fpywBSfP': { hubspot: 'auction_attendance_status',     transform: null },
  '27987mgyDDic9Bs6KZEI': { hubspot: 'commercial_attendance_status',  transform: null },
  m5BMgHBqYfwBvs77U31A: { hubspot: 'expo_attendance_status',         transform: null },
  O1g8LKalb7jsHSPb5Oyo: { hubspot: 'summit_attendance_status',       transform: null },
  R9yZyQMKm8bZKMvqAXrB: { hubspot: 'symposium_attendance_status',    transform: null },

  // --- Event date fulfilled (James/Jai request — May 15) ---
  fDwc1oHV1sQu0mKQoQOJ: { hubspot: 'workshop_date_fulfilled',          transform: 'isoDate' },
  tIjqcLNkPtmYw7JEeQYE: { hubspot: 'foundations_date_fulfilled',       transform: 'isoDate' },
  O2oSJOjyWViP5lPQaXSa: { hubspot: 'expo_bootcamp_date_fulfilled',     transform: 'isoDate' },
  S1HYJJQkGdiWQoeGM6bN: { hubspot: 'auction_date_fulfilled',           transform: 'isoDate' },
  UpGbVgWeCs8sxpNp4oNF: { hubspot: 'commercial_bootcamp_date_fulfilled', transform: 'isoDate' },
  '45sELBoFlhUH7h7onvh9': { hubspot: 'flyout_date_fulfilled',            transform: 'isoDate' },
  '0Sdv3wgHiYzgqeALpW8a': { hubspot: 'summit_date_fulfilled',            transform: 'isoDate' },
  '6BYevZMMUOPFRvNuzFfE': { hubspot: 'propstream_date_fulfilled',        transform: 'isoDate' },

  // --- Events attended multi-select ---
  '8HRVUMTBzK0jS9XBJGxV': { hubspot: 'tlc_events_attended',            transform: 'multiSelect' },
};

/**
 * Buyer tier tag priority — lower number = higher priority.
 * When multiple tier tags exist, the highest-priority one wins.
 */
const BUYER_TIER_TAGS = [
  { tag: 'wb_diamond',                         value: 'Workshop Buyer - Diamond', priority: 1 },
  { tag: 'wb',                                  value: 'Workshop Buyer',           priority: 2 },
  { tag: 'telesales_diamond-elite-program',     value: 'Telesales Diamond Buyer',  priority: 3 },
  { tag: 'telesales_diamond',                   value: 'Telesales Diamond Buyer',  priority: 3 },
  { tag: 'telesales_sold',                      value: 'Telesales Buyer',          priority: 4 },
  { tag: 'phase-preview-buyer',                 value: 'Preview Buyer',            priority: 5 },
  { tag: 'phase_preview-attendee',              value: 'Preview Attendee',         priority: 6 },
  { tag: 'phase_preview-reg',                   value: 'Preview Registrant',       priority: 7 },
  { tag: 'phase_preview-non-attendee',          value: 'Preview Non-Attendee',     priority: 8 },
  { tag: 'pna',                                 value: 'Preview Non-Attendee',     priority: 8 },
  { tag: 'community_newmember_directsignup',    value: 'Registrant',               priority: 9 },
  { tag: 'community_newmember',                 value: 'Registrant',               priority: 9 },
];

const CANCELLATION_TAG_MAP = {
  workshop_cancel_reg:      'Workshop Cancelled',
  foundations_cancel_reg:   'Foundations Cancelled',
  all_products_cancelled:   'All Cancelled',
  cancel:                   'All Cancelled',
};

/** Fulfillment tags in priority order — highest status wins (single-select property) */
const FULFILLMENT_PRIORITY = [
  { tag: 'coaching_user_created_in_tlc',    value: 'Coaching Active' },
  { tag: 'coaching_sessions_purchased',     value: 'Coaching Purchased' },
  { tag: 'community-assign-space',          value: 'Community Active' },
  { tag: 'marketplace_account',             value: 'Marketplace Active' },
  { tag: 'user_created',                    value: 'Portal Active' },
  { tag: 'user_subscribed',                 value: 'Subscribed' },
];

/**
 * Map a cleaned GHL contact record to HubSpot contact properties.
 *
 * Returns:
 *   properties        — HubSpot property key/value pairs ready for API
 *   hubspotContactId  — value of GHL's "Hubspot Contact ID" custom field (dedup key)
 *   guestGroupRef     — value of "Preview Guest - Group" (for later association pass)
 *
 * Rules enforced:
 *   - Blank/null GHL values are never written (caller must protect existing HS data)
 *   - buyer_tier uses tag priority — highest tier tag wins
 *   - fulfillment_status uses priority — most advanced status wins
 *
 * @param {Object} contact - Cleaned GHL contact (output of cleanRecord)
 * @returns {{ properties: Object, hubspotContactId: string|null, guestGroupRef: string|null }}
 */
export function mapContact(contact) {
  const properties = {};
  let hubspotContactId = null;
  let guestGroupRef = null;

  // --- Standard contact fields ---
  setIfPresent(properties, 'engager_contact_id', contact.id);
  setIfPresent(properties, 'firstname',       contact.firstName);
  setIfPresent(properties, 'lastname',        contact.lastName);
  setIfPresent(properties, 'email',           contact.email);
  setIfPresent(properties, 'phone',           contact.phone);
  setIfPresent(properties, 'company',         contact.companyName);
  setIfPresent(properties, 'address',         contact.address1);
  setIfPresent(properties, 'city',            contact.city);
  setIfPresent(properties, 'state',           contact.state);
  setIfPresent(properties, 'zip',             contact.postalCode);
  setIfPresent(properties, 'country',         contact.country);
  setIfPresent(properties, 'website',         contact.website);
  setIfPresent(properties, 'hs_timezone',     toHubspotTimezone(contact.timezone));

  // lifecyclestage — GHL "customer" → HubSpot "customer"
  if (contact.type) {
    setIfPresent(properties, 'lifecyclestage', contact.type.toLowerCase());
  }

  // DND / hs_email_optout intentionally skipped:
  // HubSpot treats hs_email_optout as read-only on the contacts API.
  // Opt-out state must be managed via the Email Subscriptions API (/communication-preferences/v3).

  // registration_source / registration_medium from first attribution entry
  const firstAttr = Array.isArray(contact.attributionSource)
    ? contact.attributionSource.find(a => a.isFirst)
    : contact.attributionSource ?? null;
  if (firstAttr) {
    setIfPresent(properties, 'utm_source', firstAttr.utmSource ?? firstAttr.sessionSource);
    setIfPresent(properties, 'utm_medium', firstAttr.medium);
  }

  // --- Custom fields (GHL [{id, value}] array) ---
  const cfLookup = buildCustomFieldLookup(contact.customFields);

  for (const [id, mapping] of Object.entries(CUSTOM_FIELD_ID_MAP)) {
    const raw = cfLookup[id];
    if (raw === null || raw === undefined || raw === '' || raw === ' ') continue;

    const value = applyTransform(mapping.transform, raw);
    if (value === null || value === undefined) continue;

    if (mapping.hubspot === '_hubspot_contact_id') {
      hubspotContactId = String(value).trim() || null;
    } else if (mapping.hubspot === '_guest_group_ref') {
      guestGroupRef = String(value).trim() || null;
    } else {
      properties[mapping.hubspot] = value;
    }
  }

  // Normalize known dirty market_name aliases (e.g. "San Fran" → "San Francisco")
  if (properties.market_name) {
    const alias = MARKET_NAME_ALIASES[properties.market_name.toLowerCase().trim()];
    if (alias) properties.market_name = alias;
  }

  // --- Tags → derived properties ---
  const tags = contact.tags ?? [];
  const tagSet = new Set(tags);

  // buyer_tier — highest priority tag wins
  const buyerTier = resolveBuyerTier(tagSet);
  if (buyerTier) properties.buyer_tier = buyerTier;

  // cancellation_status — first match wins (contacts rarely have more than one)
  for (const [tag, value] of Object.entries(CANCELLATION_TAG_MAP)) {
    if (tagSet.has(tag)) { properties.cancellation_status = value; break; }
  }

  // fulfillment_status — highest priority match wins
  const fulfillment = resolveFulfillmentStatus(tagSet);
  if (fulfillment) properties.fulfillment_status = fulfillment;

  // 'e2i-email unsubscribe' tag → opt-out handled separately via Subscriptions API

  // eventtag — multi-select of cities attended (Andy's existing field)
  const { eventtag } = resolveEventTags(tags);
  if (eventtag) properties.eventtag = eventtag;

  logger.debug(`mapContact [${contact.id}]: ${Object.keys(properties).length} properties mapped`);

  return { properties, hubspotContactId, guestGroupRef };
}

// --- Helpers ---

/**
 * Build a flat id→value lookup from GHL customFields array.
 * @param {Array} customFields
 * @returns {Object}
 */
function buildCustomFieldLookup(customFields = []) {
  return (customFields ?? []).reduce((acc, cf) => {
    acc[cf.id] = cf.value;
    return acc;
  }, {});
}

/**
 * Set a HubSpot property only when the value is non-blank.
 * @param {Object} props
 * @param {string} key
 * @param {*} value
 */
function setIfPresent(props, key, value) {
  if (value !== null && value !== undefined && value !== '') {
    props[key] = value;
  }
}

/**
 * Apply a named transformation to a raw GHL field value.
 * @param {string|null} transformName
 * @param {*} value
 * @returns {*}
 */
function applyTransform(transformName, value) {
  switch (transformName) {
    case 'integer':     return toInteger(value);
    case 'decimal':     return toDecimal(value);
    case 'isoDate':     return toIsoDate(value);
    case 'multiSelect': return toHubspotMultiSelect(value);
    default:            return value;
  }
}

/** Known dirty GHL market_name values → correct HubSpot enum option */
const MARKET_NAME_ALIASES = {
  'san fran': 'San Francisco',
  'sf':       'San Francisco',
};

/**
 * Convert IANA timezone string to HubSpot hs_timezone format.
 * HubSpot expects lowercase with "/" replaced by "_slash_".
 * e.g. "America/Denver" → "america_slash_denver"
 * Returns null for values that are not IANA timezone format (e.g. "prince").
 * @param {string|null|undefined} tz
 * @returns {string|null}
 */
function toHubspotTimezone(tz) {
  if (!tz) return null;
  // Valid IANA timezones contain '/' (America/Denver) or are well-known abbreviations
  if (!tz.includes('/') && !/^(UTC|GMT)$/i.test(tz)) return null;
  return tz.toLowerCase().replace(/\//g, '_slash_');
}

/** @param {*} v @returns {number|null} */
function toInteger(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? null : n;
}

/** @param {*} v @returns {number|null} */
function toDecimal(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
  return isNaN(n) ? null : n;
}

/**
 * Convert GHL date values to ISO YYYY-MM-DD.
 * Handles: Unix ms number, "YYYY-MM-DD", "M/D/YYYY", "MM/DD/YYYY".
 * @param {number|string} v
 * @returns {string|null}
 */
function toIsoDate(v) {
  if (v === null || v === undefined || v === '') return null;
  // Unix ms (community_join_date may arrive as a number)
  if (typeof v === 'number') return new Date(v).toISOString().split('T')[0];
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const mmddyyyy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmddyyyy) {
    const [, m, d, y] = mmddyyyy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  logger.warn(`toIsoDate: unrecognised date format "${s}"`);
  return null;
}

/**
 * Convert GHL MULTIPLE_OPTIONS values to HubSpot semicolon-separated string.
 * GHL may return an array or a semicolon/comma-separated string.
 * @param {string[]|string} v
 * @returns {string|null}
 */
function toHubspotMultiSelect(v) {
  if (!v) return null;
  if (Array.isArray(v)) return v.filter(Boolean).join(';') || null;
  if (typeof v === 'string') {
    // Normalise comma-separated to semicolon
    return v.split(',').map(s => s.trim()).filter(Boolean).join(';') || null;
  }
  return null;
}

/**
 * Resolve the highest-priority buyer tier from a contact's tag set.
 * @param {Set<string>} tagSet
 * @returns {string|null}
 */
function resolveBuyerTier(tagSet) {
  let best = null;
  for (const entry of BUYER_TIER_TAGS) {
    if (tagSet.has(entry.tag)) {
      if (!best || entry.priority < best.priority) best = entry;
    }
  }
  return best?.value ?? null;
}

/**
 * Resolve the highest-priority fulfillment status from a contact's tag set.
 * @param {Set<string>} tagSet
 * @returns {string|null}
 */
function resolveFulfillmentStatus(tagSet) {
  for (const entry of FULFILLMENT_PRIORITY) {
    if (tagSet.has(entry.tag)) return entry.value;
  }
  return null;
}

export { CUSTOM_FIELD_ID_MAP, BUYER_TIER_TAGS };
