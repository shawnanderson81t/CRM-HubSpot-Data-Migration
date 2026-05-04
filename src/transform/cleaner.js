import { logger } from '../utils/logger.js';

/**
 * Clean and normalize a GHL contact record before mapping
 * Handles: email validation, phone normalization, encoding fixes, empty fields
 *
 * @param {Object} record - Raw GHL contact record
 * @returns {{ cleaned: Object, issues: string[] }} Cleaned record + list of issues found
 */
export function cleanRecord(record) {
  const issues = [];
  const cleaned = { ...record };

  // Email validation
  if (cleaned.email) {
    cleaned.email = cleaned.email.trim().toLowerCase();
    if (!isValidEmail(cleaned.email)) {
      issues.push(`Invalid email: ${cleaned.email}`);
      cleaned.email = null;
    }
  }

  // Phone normalization
  if (cleaned.phone) {
    cleaned.phone = cleaned.phone.replace(/[^\d+\-() ]/g, '').trim();
    if (cleaned.phone.length < 7) {
      issues.push(`Phone too short: ${cleaned.phone}`);
      cleaned.phone = null;
    }
  }

  // Strip HTML from text fields
  for (const field of ['firstName', 'lastName', 'address1', 'city']) {
    if (cleaned[field] && typeof cleaned[field] === 'string') {
      cleaned[field] = cleaned[field].replace(/<[^>]*>/g, '').trim();
    }
  }

  // Name normalization
  if (cleaned.firstName) cleaned.firstName = titleCase(cleaned.firstName);
  if (cleaned.lastName) cleaned.lastName = titleCase(cleaned.lastName);

  if (issues.length > 0) {
    logger.debug(`Cleaned record ${cleaned.email || 'no-email'}`, { issues });
  }

  return { cleaned, issues };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function titleCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
