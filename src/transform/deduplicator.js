import { logger } from '../utils/logger.js';

/**
 * Detect duplicates within a batch and against existing HubSpot records
 * Match logic: email OR phone (configurable)
 *
 * @param {Array} records - Array of cleaned contact records
 * @param {Map} existingMap - Map of email/phone → HubSpot contact ID (pre-loaded)
 * @returns {{ unique: Array, duplicates: Array, updates: Array }}
 */
export function deduplicateBatch(records, existingMap = new Map()) {
  const seen = new Map();
  const unique = [];
  const duplicates = [];
  const updates = []; // Records that match existing HubSpot contacts (upsert)

  for (const record of records) {
    const email = (record.email || '').toLowerCase().trim();
    const phone = (record.phone || '').replace(/\D/g, '');
    const key = email || phone;

    if (!key) {
      duplicates.push({ record, reason: 'No email or phone — cannot deduplicate' });
      continue;
    }

    // Check against existing HubSpot data
    const existingId = existingMap.get(email) || existingMap.get(phone);
    if (existingId) {
      updates.push({ record, hubspotId: existingId, matchedOn: existingMap.has(email) ? 'email' : 'phone' });
      continue;
    }

    // Check within this batch
    if (seen.has(key)) {
      duplicates.push({ record, reason: `Duplicate of ${key} within batch` });
      continue;
    }

    seen.set(key, true);
    if (email) seen.set(email, true);
    if (phone) seen.set(phone, true);
    unique.push(record);
  }

  logger.info(`Dedup results: ${unique.length} new, ${updates.length} updates, ${duplicates.length} skipped`);
  return { unique, duplicates, updates };
}
