import { logger } from '../utils/logger.js';

/**
 * Classify a batch of mapped GHL contacts against existing HubSpot records.
 *
 * Match chain (highest confidence first):
 *   1. hubspotContactId — GHL stores the HS contact ID in a custom field.
 *      If present, this is a direct match: always UPDATE, skip email/phone lookup.
 *   2. email — normalised lowercase match in existingMap
 *   3. phone — E.164 match in existingMap
 *
 * Since Andy's team has already loaded Workshop contacts into HubSpot,
 * Tier 1 records are expected to be nearly all UPDATEs. Records with no
 * match key (no email AND no phone AND no hubspotContactId) are flagged
 * for manual review rather than being created blindly.
 *
 * @param {Array<{contact: Object, properties: Object, hubspotContactId: string|null}>} records
 *   Each element is the output of mapContact(), wrapped with the original contact.
 * @param {Map<string, string>} existingMap
 *   Map of normalised email|phone → HubSpot contact ID, pre-loaded from HubSpot.
 * @returns {{
 *   updates: Array<{properties: Object, hubspotId: string, matchedOn: string}>,
 *   inserts: Array<{properties: Object}>,
 *   unresolvable: Array<{contact: Object, reason: string}>
 * }}
 */
export function deduplicateBatch(records, existingMap = new Map()) {
  const updates = [];
  const inserts = [];
  const unresolvable = [];

  for (const { contact, properties, hubspotContactId } of records) {
    // 1. Direct HS contact ID match (highest confidence)
    if (hubspotContactId) {
      updates.push({ properties, hubspotId: hubspotContactId, matchedOn: 'hubspot_contact_id' });
      continue;
    }

    const email = (contact.email || '').toLowerCase().trim();
    const phone = (contact.phone || '').trim();

    // 2. Email match
    if (email && existingMap.has(email)) {
      updates.push({ properties, hubspotId: existingMap.get(email), matchedOn: 'email' });
      continue;
    }

    // 3. Phone match
    if (phone && existingMap.has(phone)) {
      updates.push({ properties, hubspotId: existingMap.get(phone), matchedOn: 'phone' });
      continue;
    }

    // 4. No match — treat as INSERT only if we have at least an email or phone
    if (email || phone) {
      inserts.push({ properties });
      continue;
    }

    // 5. No match key at all — flag for review
    unresolvable.push({
      contact: { id: contact.id, firstName: contact.firstName, lastName: contact.lastName },
      reason: 'No hubspotContactId, email, or phone — cannot match or create safely',
    });
  }

  logger.info(
    `dedup: ${updates.length} updates, ${inserts.length} inserts, ${unresolvable.length} unresolvable`
  );

  return { updates, inserts, unresolvable };
}

/**
 * Build the existingMap from a HubSpot contact search result set.
 * Indexes by both email and phone so either can match.
 *
 * @param {Array<{id: string, properties: {email: string, phone: string}}>} hubspotContacts
 * @returns {Map<string, string>} key → HubSpot contact ID
 */
export function buildExistingMap(hubspotContacts) {
  const map = new Map();
  for (const hs of hubspotContacts) {
    const email = (hs.properties?.email || '').toLowerCase().trim();
    const phone = (hs.properties?.phone || '').trim();
    if (email) map.set(email, hs.id);
    if (phone) map.set(phone, hs.id);
  }
  return map;
}
