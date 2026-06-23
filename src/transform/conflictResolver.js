import { logger } from '../utils/logger.js';
import { CUSTOM_FIELD_ID_MAP } from './fieldMapper.js';

/**
 * Conflict resolution for the daily sync — "HubSpot wins on manually-edited fields".
 *
 * Strategy (v1, field-ownership allowlist):
 *   The sync may only WRITE the HubSpot properties that GoHighLevel owns (tags →
 *   buyer_tier/eventtag/etc., geo, UTM, and the event/buyer custom fields). Any
 *   property NOT on the allowlist is withheld from update payloads, so whatever a
 *   human typed into HubSpot for that field is left exactly as-is. This needs no
 *   extra API calls and builds on the upserter's existing identity-stripping.
 *
 *   GHL wins on NEW contacts and NEW activity — so this filter is applied to
 *   UPDATES only. Inserts (brand-new contacts) are never passed through it.
 *
 * v2 (optional, not implemented here): for a small set of contested fields, call
 * HubSpot's property history and skip any field whose last write was `CRM_UI`.
 * See `filterUpdate`'s extension note.
 */

/**
 * HubSpot custom-field properties the field mapper can write — derived directly
 * from the mapper's CUSTOM_FIELD_ID_MAP so the allowlist can never drift from it.
 * The two `_`-prefixed sentinels (`_hubspot_contact_id`, `_guest_group_ref`) are
 * not written as properties, so they're excluded.
 */
const CUSTOM_FIELD_PROPS = Object.values(CUSTOM_FIELD_ID_MAP)
  .map(m => m.hubspot)
  .filter(name => !name.startsWith('_'));

/**
 * Standard + tag-derived properties that mapContact() writes. This list mirrors
 * the body of fieldMapper.mapContact() — keep it in sync if the mapper gains or
 * loses a standard/tag-derived field.
 *
 * Deliberately EXCLUDED from the GHL-owned set:
 *   - email / phone / engager_contact_id — identity fields (also stripped by the
 *     upserter); must never be rewritten on an update.
 *   - lifecyclestage — the sales team advances this by hand in HubSpot; letting
 *     GHL push "customer" would clobber a manually-set stage. (HubSpot wins.)
 *   - hubspot_owner_id — ownership is managed in HubSpot. (HubSpot wins.)
 * Andy can move any of these into the allowlist via the constructor (Phase 0).
 */
const STANDARD_PROPS = [
  'firstname', 'lastname', 'company', 'address', 'city', 'state', 'zip',
  'country', 'website', 'hs_timezone', 'utm_source', 'utm_medium',
  'buyer_tier', 'cancellation_status', 'fulfillment_status', 'eventtag',
];

/**
 * HubSpot properties a human edits directly in HubSpot — the sync must never
 * overwrite these on updates, even though the mapper can produce them.
 *
 * Confirmed off-limits:
 *   - assigned_coach — assigned by hand by the Coaching Manager (Carter Brown).
 *
 * Protected pending team confirmation — fulfillment and sales staff move these
 * across both platforms by necessity, so withholding is the safe default. Remove
 * a field from this set to hand it back to GoHighLevel once the field owner
 * confirms GoHighLevel is the source of truth:
 *   - sales rep / team: workshop_team, preview_sales_rep, telesales_repteam
 *   - fulfillment + attendance: fulfillment_status and the *_attendance_status fields
 */
const HUBSPOT_OWNED_FIELDS = new Set([
  'assigned_coach',
  // pending confirmation (safe-default protected):
  'workshop_team', 'preview_sales_rep', 'telesales_repteam',
  'fulfillment_status',
  'preview_attendance_status', 'workshop_attendance_status', 'foundations_attendance_status',
  'auction_attendance_status', 'commercial_attendance_status', 'expo_attendance_status',
  'summit_attendance_status', 'symposium_attendance_status',
]);

/** Default set of HubSpot properties the sync is allowed to write on EXISTING contacts. */
export const DEFAULT_GHL_OWNED_FIELDS = Object.freeze(
  [...STANDARD_PROPS, ...CUSTOM_FIELD_PROPS].filter(name => !HUBSPOT_OWNED_FIELDS.has(name))
);

export class ConflictResolver {
  /**
   * @param {Object} [options]
   * @param {Iterable<string>} [options.allowlist=DEFAULT_GHL_OWNED_FIELDS]
   *   HubSpot property names the sync is permitted to write on updates.
   */
  constructor({ allowlist = DEFAULT_GHL_OWNED_FIELDS } = {}) {
    this.allowlist = new Set(allowlist);
    logger.info(`ConflictResolver: ${this.allowlist.size} GHL-owned fields are writable on updates`);
  }

  /**
   * Restrict an outgoing UPDATE payload to GHL-owned fields. Any property not on
   * the allowlist is withheld so a human's HubSpot edit is never overwritten.
   *
   * Do NOT call this for inserts — GHL wins on brand-new contacts, so new records
   * keep every mapped field.
   *
   * v2 extension point: before keeping an allowlisted-but-contested field, a
   * property-history check could be inserted here to defer to a recent `CRM_UI`
   * write. Left out of v1 by design (per-contact API cost).
   *
   * @param {Object} properties - Mapped HubSpot properties destined for an existing contact.
   * @returns {{ properties: Object, withheld: string[] }} kept properties + names of withheld fields.
   */
  filterUpdate(properties) {
    const kept = {};
    const withheld = [];
    for (const [key, value] of Object.entries(properties)) {
      if (this.allowlist.has(key)) kept[key] = value;
      else withheld.push(key);
    }
    return { properties: kept, withheld };
  }
}
