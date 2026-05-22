import 'dotenv/config';
import { readFileSync, statSync } from 'fs';
import { loadConfig } from '../src/utils/config.js';
import { HubSpotClient } from '../src/load/hubspotClient.js';
import { Checkpoint } from '../src/load/checkpoint.js';
import { BatchUpserter } from '../src/load/batchUpserter.js';
import { logger } from '../src/utils/logger.js';

/**
 * Main migration runner.
 *
 * Usage:
 *   node scripts/migrate-tier.js --tier=1    # Workshop Buyers  (~10K)
 *   node scripts/migrate-tier.js --tier=2    # Preview Buyers   (~30K)
 *   node scripts/migrate-tier.js --tier=3    # Registrants      (~800K)
 *
 * Resume: re-run the same command after a failure — checkpoint picks up from last batch.
 *
 * Pre-requisites:
 *   1. Data file for the tier must exist (run extract scripts first)
 *   2. data/owner-map.json should exist (run scripts/build-owner-map.js first)
 *   3. HUBSPOT_API_KEY must point to the correct portal (sandbox for pilot, PROD for live)
 */

const TIER = parseInt(
  process.argv.find(a => a.startsWith('--tier='))?.split('=')[1] || '1'
);

const TIER_CONFIG = {
  1: {
    name: 'Workshop Buyers',
    dataFile: './data/samples/workshop-buyers-sample.json',
  },
  2: {
    name: 'Preview Buyers',
    dataFile: './data/samples/preview-buyers.json',
  },
  3: {
    name: 'General Registrants',
    dataFile: './data/samples/registrants.json',
  },
};

async function main() {
  const config = loadConfig();
  const tierInfo = TIER_CONFIG[TIER];

  if (!tierInfo) {
    logger.error(`Invalid tier: ${TIER}. Use --tier=1, --tier=2, or --tier=3`);
    process.exit(1);
  }

  logger.info(`=== Tier ${TIER} Migration: ${tierInfo.name} ===`);

  // Verify data file exists before doing anything
  try {
    statSync(tierInfo.dataFile);
  } catch (err) {
    logger.error(`Cannot read data file: ${tierInfo.dataFile}`, { error: err.message });
    logger.error('Run the extract script first to generate this file.');
    process.exit(1);
  }

  // Load owner map (GHL userId → HubSpot ownerId) — optional but recommended
  let ownerMap = {};
  try {
    ownerMap = JSON.parse(readFileSync('./data/owner-map.json', 'utf-8'));
    logger.info(`Owner map loaded: ${Object.keys(ownerMap).length} entries`);
  } catch {
    logger.warn('No owner map at data/owner-map.json — contacts will have no owner assigned. Run scripts/build-owner-map.js first.');
  }

  const hubspotClient = new HubSpotClient(config);
  const checkpoint    = new Checkpoint(TIER, config.paths.checkpointDir);
  const upserter      = new BatchUpserter(hubspotClient, checkpoint, config, ownerMap);

  let finalState;

  if (TIER === 3) {
    // Tier 3 (907K contacts, ~3.4GB file) — stream line-by-line to avoid OOM
    logger.info(`Tier 3: using streaming reader for ${tierInfo.dataFile}`);
    finalState = await upserter.runStreaming(tierInfo.dataFile, `tier${TIER}`);
  } else {
    // Tiers 1 & 2 are small enough to load fully
    const allContacts = JSON.parse(readFileSync(tierInfo.dataFile, 'utf-8'));
    logger.info(`Loaded ${allContacts.length} contacts from ${tierInfo.dataFile}`);
    finalState = await upserter.run(allContacts, `tier${TIER}`);
  }

  logger.info(`=== Tier ${TIER} Complete ===`, {
    succeeded: finalState.succeeded,
    failed:    finalState.failed,
    skipped:   finalState.skipped,
    started:   finalState.startedAt,
    finished:  finalState.completedAt,
  });

  if (finalState.failed > 0) {
    logger.warn(`${finalState.failed} contacts failed — check data/checkpoints/tier-${TIER}-checkpoint.json for details`);
    process.exit(1);
  }
}

main().catch(err => {
  logger.error(`Tier ${TIER} migration crashed`, { error: err.message, stack: err.stack });
  process.exit(1);
});
