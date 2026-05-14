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
 *   node scripts/pilot-run.js             # 100 contacts (default)
 *   node scripts/pilot-run.js --count=50  # 50 contacts
 *
 * Reads from data/samples/workshop-buyers-sample.json.
 * Make sure HUBSPOT_API_KEY points to the SANDBOX portal — not PROD.
 *
 * After running, manually verify in HubSpot:
 *   - Existing contacts were updated (not duplicated)
 *   - No existing field values were overwritten with blanks
 *   - buyer_tier, eventtag, market_name, payment fields are populated
 *   - Contact owner is assigned where ownerMap has a match
 */

const COUNT = parseInt(
  process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '100'
);

async function main() {
  const config = loadConfig();
  logger.info(`=== Pilot Run: ${COUNT} contacts ===`);
  logger.info(`Target HubSpot portal base: ${config.hubspot.baseUrl}`);

  let allContacts;
  try {
    allContacts = JSON.parse(readFileSync('./data/samples/workshop-buyers-sample.json', 'utf-8'));
  } catch (err) {
    logger.error('Cannot read workshop-buyers-sample.json', { error: err.message });
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
  const checkpoint    = new Checkpoint('pilot', config.paths.checkpointDir);
  const upserter      = new BatchUpserter(hubspotClient, checkpoint, config, ownerMap);

  const state = await upserter.run(contacts, 'pilot');

  logger.info('=== Pilot Complete ===', {
    total:     contacts.length,
    succeeded: state.succeeded,
    failed:    state.failed,
    skipped:   state.skipped,
  });

  if (state.failed > 0) {
    logger.warn(`${state.failed} contacts failed. Check data/checkpoints/pilot-checkpoint.json`);
  }

  logger.info('Next step: spot-check 10-20 contacts in HubSpot sandbox before approving Tier 1 run.');
}

main().catch(err => {
  logger.error('Pilot run crashed', { error: err.message, stack: err.stack });
  process.exit(1);
});
