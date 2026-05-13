import { logger } from '../utils/logger.js';

const TEMPLATE_PLACEHOLDER_RE = /\{\{[^}]*\}\}/g;
const HTML_TAG_RE = /<[^>]+>/g;
const PHONE_PATTERN_RE = /^[+\d\s\-().]{7,}$/;

/**
 * Clean and normalize a raw GHL contact record before field mapping.
 *
 * Handles:
 * - `{{placeholder}}` stripping (unresolved GHL template vars in live data)
 * - Email validation and normalization
 * - Phone E.164 verification
 * - Phone-as-name detection (firstName/lastName that are actually phone numbers)
 * - HTML tag stripping from text fields
 *
 * @param {Object} contact - Raw GHL contact object
 * @returns {{ cleaned: Object, issues: string[] }}
 */
export function cleanRecord(contact) {
  const issues = [];
  const cleaned = { ...contact };

  // Strip {{placeholders}} from all top-level string fields
  for (const key of Object.keys(cleaned)) {
    if (typeof cleaned[key] === 'string') {
      const stripped = cleaned[key].replace(TEMPLATE_PLACEHOLDER_RE, '').trim();
      if (stripped !== cleaned[key]) {
        issues.push(`Template placeholder stripped from field "${key}"`);
        cleaned[key] = stripped || null;
      }
    }
  }

  // Strip HTML from name and address fields
  for (const field of ['firstName', 'lastName', 'address1', 'city', 'companyName']) {
    if (cleaned[field] && typeof cleaned[field] === 'string') {
      cleaned[field] = cleaned[field].replace(HTML_TAG_RE, '').trim() || null;
    }
  }

  // Phone-as-name detection: if firstName or lastName looks like a phone number, null it
  for (const field of ['firstName', 'lastName']) {
    if (cleaned[field] && PHONE_PATTERN_RE.test(cleaned[field])) {
      issues.push(`${field} looks like a phone number — cleared: "${cleaned[field]}"`);
      cleaned[field] = null;
    }
  }

  // Normalize email
  if (cleaned.email) {
    cleaned.email = cleaned.email.trim().toLowerCase();
    if (!isValidEmail(cleaned.email)) {
      issues.push(`Invalid email format: "${cleaned.email}"`);
      cleaned.email = null;
    }
  }

  // Verify phone is E.164 — GHL stores as +1XXXXXXXXXX already; reject anything malformed
  if (cleaned.phone) {
    const phone = cleaned.phone.trim();
    if (!/^\+\d{7,15}$/.test(phone)) {
      // Try to salvage by stripping non-digit chars and prepending +1 for US numbers
      const digits = phone.replace(/\D/g, '');
      if (digits.length === 10) {
        cleaned.phone = `+1${digits}`;
        issues.push(`Phone normalized to E.164: "${phone}" → "${cleaned.phone}"`);
      } else if (digits.length === 11 && digits.startsWith('1')) {
        cleaned.phone = `+${digits}`;
        issues.push(`Phone normalized to E.164: "${phone}" → "${cleaned.phone}"`);
      } else {
        issues.push(`Phone unparseable — cleared: "${phone}"`);
        cleaned.phone = null;
      }
    }
  }

  // Strip placeholders from customFields values too
  if (Array.isArray(cleaned.customFields)) {
    cleaned.customFields = cleaned.customFields.map(cf => {
      if (typeof cf.value === 'string') {
        const stripped = cf.value.replace(TEMPLATE_PLACEHOLDER_RE, '').trim();
        return stripped !== cf.value ? { ...cf, value: stripped || null } : cf;
      }
      return cf;
    });
  }

  if (issues.length > 0) {
    logger.debug(`cleaner [${contact.id}]: ${issues.join(' | ')}`);
  }

  return { cleaned, issues };
}

/**
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
