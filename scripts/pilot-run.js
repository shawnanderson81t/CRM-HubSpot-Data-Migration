import 'dotenv/config';
import { loadConfig } from '../src/utils/config.js';
import { logger } from '../src/utils/logger.js';

/**
 * Pilot migration run — 50-100 contacts only
 * Run this to validate the full pipeline before any bulk migration
 *
 * Usage: node scripts/pilot-run.js [--count=50]
 */

const PILOT_COUNT = parseInt(
  process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '50'
);

async function main() {
  const config = loadConfig();
  logger.info(`Starting pilot run with ${PILOT_COUNT} contacts`);

  // Step 1: Extract small sample from GHL
  // TODO: const ghlContacts = await ghlClient.getContacts({ limit: PILOT_COUNT });

  // Step 2: Clean and transform
  // TODO: const cleaned = ghlContacts.map(c => cleanRecord(c));
  // TODO: const mapped = cleaned.map(c => mapContact(c.cleaned));

  // Step 3: Deduplicate against existing HubSpot
  // TODO: const existing = await hsClient.getContactsByEmails(mapped.map(m => m.email));
  // TODO: const { unique, updates, duplicates } = deduplicateBatch(mapped, existing);

  // Step 4: Batch upsert to HubSpot
  // TODO: const result = await hsClient.batchUpsertContacts(unique.map(u => ({ properties: u })));

  // Step 5: Validate — pull back from HubSpot and compare
  // TODO: Run diffChecker on sample

  logger.info('Pilot run complete — check logs and validate in HubSpot UI');
}

main().catch((e) => {
  logger.error('Pilot run failed', { error: e.message, stack: e.stack });
  process.exit(1);
});
