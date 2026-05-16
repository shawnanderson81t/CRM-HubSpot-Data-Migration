import 'dotenv/config';
import { readFileSync } from 'fs';
import { loadConfig } from '../src/utils/config.js';
import { HubSpotClient } from '../src/load/hubspotClient.js';
import { Checkpoint } from '../src/load/checkpoint.js';
import { BatchUpserter } from '../src/load/batchUpserter.js';
import { logger } from '../src/utils/logger.js';

/**
 * Pilot run — validate the full pipeline against a small sample before any bulk migration.
 *
 * Usage:
 *   node scripts/pilot-run.js                        # Tier 1, 10 contacts
 *   node scripts/pilot-run.js --tier=2 --count=10    # Tier 2, 10 contacts
 *   node scripts/pilot-run.js --tier=3 --count=10    # Tier 3, 10 contacts
 *
 * Make sure HUBSPOT_API_KEY points to the correct portal before running.
 */

const TIER = parseInt(
  process.argv.find(a => a.startsWith('--tier='))?.split('=')[1] || '1'
);

const COUNT = parseInt(
  process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '10'
);

const TIER_CONFIG = {
  1: { name: 'Workshop Buyers',     dataFile: './data/samples/workshop-buyers-sample.json' },
  2: { name: 'Preview Buyers',      dataFile: './data/samples/preview-buyers.json' },
  3: { name: 'General Registrants', dataFile: './data/samples/registrants-sample.json' },
};

async function main() {
  const config = loadConfig();
  const tierInfo = TIER_CONFIG[TIER];

  if (!tierInfo) {
    logger.error(`Invalid tier: ${TIER}. Use --tier=1, --tier=2, or --tier=3`);
    process.exit(1);
  }

  logger.info(`=== Pilot Run: Tier ${TIER} (${tierInfo.name}) — ${COUNT} contacts ===`);
  logger.info(`Target HubSpot portal base: ${config.hubspot.baseUrl}`);

  let allContacts;
  try {
    allContacts = JSON.parse(readFileSync(tierInfo.dataFile, 'utf-8'));
  } catch (err) {
    logger.error(`Cannot read ${tierInfo.dataFile} — run the extract script first`, { error: err.message });
    process.exit(1);
  }

  const contacts = allContacts.slice(0, COUNT);
  logger.info(`Using ${contacts.length} of ${allContacts.length} available contacts`);

  let ownerMap = {};
  try {
    ownerMap = JSON.parse(readFileSync('./data/owner-map.json', 'utf-8'));
    logger.info(`Owner map loaded: ${Object.keys(ownerMap).length} entries`);
  } catch {
    logger.warn('No owner map found — proceeding without owner assignment');
  }

  const hubspotClient = new HubSpotClient(config);
  const checkpoint    = new Checkpoint(`pilot-tier${TIER}`, config.paths.checkpointDir);
  const upserter      = new BatchUpserter(hubspotClient, checkpoint, config, ownerMap);

  const state = await upserter.run(contacts, `tier${TIER}-pilot`);

  logger.info(`=== Tier ${TIER} Pilot Complete ===`, {
    total:     contacts.length,
    succeeded: state.succeeded,
    failed:    state.failed,
    skipped:   state.skipped,
  });

  if (state.failed > 0) {
    logger.warn(`${state.failed} contacts failed. Check data/checkpoints/pilot-tier${TIER}-checkpoint.json`);
  }

  logger.info(`Next step: validate with "npm run validate:pilot -- --tier=${TIER} --count=${COUNT}"`);
}

main().catch(err => {
  logger.error('Pilot run crashed', { error: err.message, stack: err.stack });
  process.exit(1);
});
