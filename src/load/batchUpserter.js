import { cleanRecord } from '../transform/cleaner.js';
import { mapContact } from '../transform/fieldMapper.js';
import { deduplicateBatch, buildExistingMap } from '../transform/deduplicator.js';
import { logger } from '../utils/logger.js';

const BATCH_SIZE = 100;

/**
 * BatchUpserter — orchestrates the full ETL pipeline for a migration tier.
 *
 * For each batch of raw GHL contacts it:
 *   1. Cleans records (cleanRecord)
 *   2. Maps fields to HubSpot properties (mapContact)
 *   3. Applies contact owner assignment from ownerMap
 *   4. Fetches existing HubSpot contacts for this batch (by engager_id / email / phone)
 *   5. Deduplicates → splits into updates (by HS ID) and inserts
 *   6. Calls batchUpdateContacts for updates and batchCreateContacts for inserts
 *   7. Checkpoints after every batch (safe to resume on failure)
 */
export class BatchUpserter {
  /**
   * @param {import('../load/hubspotClient.js').HubSpotClient} hubspotClient
   * @param {import('../load/checkpoint.js').Checkpoint} checkpoint
   * @param {Object} config - Output of loadConfig()
   * @param {Object} [ownerMap] - GHL userId → HubSpot ownerId lookup (optional)
   */
  constructor(hubspotClient, checkpoint, config, ownerMap = {}) {
    this.hs = hubspotClient;
    this.checkpoint = checkpoint;
    this.config = config;
    this.ownerMap = ownerMap;
    this.batchDelayMs = config.migration.batchDelayMs;
  }

  /**
   * Process one batch of raw GHL contacts through the full pipeline.
   *
   * @param {Object[]} rawContacts - Raw GHL contact objects (max 100)
   * @param {number} batchNumber - For logging
   * @returns {Promise<{ succeeded: number, failed: number, skipped: number, errors: Array }>}
   */
  async processBatch(rawContacts, batchNumber) {
    // Step 1 — Clean
    const cleaned = rawContacts.map(c => {
      const { cleaned: contact, issues } = cleanRecord(c);
      return { contact, issues };
    });

    // Step 2 — Map fields + owner assignment
    const mapped = cleaned.map(({ contact }) => {
      const { properties, hubspotContactId, guestGroupRef } = mapContact(contact);

      if (contact.assignedTo && this.ownerMap[contact.assignedTo]) {
        properties.hubspot_owner_id = this.ownerMap[contact.assignedTo];
      }

      return { contact, properties, hubspotContactId, guestGroupRef };
    });

    // Step 3 — Fetch existing HS contacts for dedup (4 lookup strategies in parallel)
    const DEDUP_PROPS = ['email', 'phone', 'engager_contact_id'];
    const emails      = [...new Set(mapped.map(r => r.contact.email).filter(Boolean))];
    const phones      = [...new Set(mapped.map(r => r.contact.phone).filter(Boolean))];
    const hsIds       = [...new Set(mapped.map(r => r.hubspotContactId).filter(Boolean))];
    const ghlIds      = [...new Set(mapped.map(r => r.contact.id).filter(Boolean))];

    const [byEmail, byPhone, byHsId, byEngagerId] = await Promise.all([
      this.hs.batchReadContacts(emails,  'email',               DEDUP_PROPS),
      this.hs.batchReadContacts(phones,  'phone',               DEDUP_PROPS),
      this.hs.batchReadContacts(hsIds,   'hs_object_id',        DEDUP_PROPS),
      this.hs.batchReadContacts(ghlIds,  'engager_contact_id',  DEDUP_PROPS),
    ]);

    const existingMap = buildExistingMap([...byEmail, ...byPhone, ...byHsId, ...byEngagerId]);

    // Step 4 — Deduplicate
    const { updates, inserts, unresolvable } = deduplicateBatch(mapped, existingMap);

    logger.info(
      `Batch ${batchNumber}: ${updates.length} updates, ${inserts.length} inserts, ${unresolvable.length} unresolvable`
    );

    let succeeded = 0;
    let failed = 0;
    const errors = [];

    // Step 5 — Batch update (contacts that exist in HubSpot)
    if (updates.length > 0) {
      const res = await this.hs.batchUpdateContacts(
        updates.map(u => ({ hubspotId: u.hubspotId, properties: u.properties }))
      );
      succeeded += res.succeeded;
      failed    += res.failed;
      errors.push(...res.errors);
    }

    // Step 6 — Batch create (new contacts)
    if (inserts.length > 0) {
      const res = await this.hs.batchCreateContacts(inserts);
      succeeded += res.succeeded;
      failed    += res.failed;
      errors.push(...res.errors);
    }

    return { succeeded, failed, skipped: unresolvable.length, errors };
  }

  /**
   * Run the full tier migration over all contacts.
   * Splits into batches of 100, checkpoints after each, honours batchDelayMs between calls.
   * Safe to interrupt and resume — re-running picks up from last completed batch.
   *
   * @param {Object[]} allContacts - All raw GHL contacts for this tier
   * @param {string} tierName - e.g. 'tier1' (used in log messages)
   * @returns {Promise<Object>} Final checkpoint state
   */
  async run(allContacts, tierName) {
    const totalBatches = Math.ceil(allContacts.length / BATCH_SIZE);
    const state = this.checkpoint.load(totalBatches);
    const startBatch = state.lastBatch + 1;

    if (startBatch >= totalBatches) {
      logger.info(`${tierName}: already complete — ${state.succeeded} succeeded, ${state.failed} failed`);
      return state;
    }

    logger.info(
      `${tierName}: ${allContacts.length} contacts, ${totalBatches} batches, starting at batch ${startBatch}`
    );

    for (let i = startBatch; i < totalBatches; i++) {
      const batch = allContacts.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);

      const result = await this.processBatch(batch, i);

      this.checkpoint.update(state, {
        batchNumber: i,
        succeeded:   result.succeeded,
        failed:      result.failed,
        skipped:     result.skipped,
        errors:      result.errors,
      });

      const pct = (((i + 1) / totalBatches) * 100).toFixed(1);
      logger.info(
        `[${tierName}] Batch ${i + 1}/${totalBatches} (${pct}%) — ` +
        `succeeded: ${result.succeeded}, failed: ${result.failed}, skipped: ${result.skipped}`
      );

      // Rate limit gap between batches (skip after last batch)
      if (i < totalBatches - 1) {
        await new Promise(r => setTimeout(r, this.batchDelayMs));
      }
    }

    this.checkpoint.complete(state);
    return state;
  }
}
