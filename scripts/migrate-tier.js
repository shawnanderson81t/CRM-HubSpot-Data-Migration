import 'dotenv/config';
import { loadConfig } from '../src/utils/config.js';
import { Checkpoint } from '../src/load/checkpoint.js';
import { logger } from '../src/utils/logger.js';

/**
 * Run migration for a specific tier
 *
 * Usage:
 *   node scripts/migrate-tier.js --tier=1    # Workshop Buyers (~10K)
 *   node scripts/migrate-tier.js --tier=2    # Preview Buyers (~40K)
 *   node scripts/migrate-tier.js --tier=3    # General Registrants (~800K)
 *
 * Supports resume: if interrupted, re-run same command to continue from last checkpoint
 */

const TIER = parseInt(
  process.argv.find(a => a.startsWith('--tier='))?.split('=')[1] || '1'
);

const TIER_CONFIG = {
  1: { name: 'Workshop Buyers', estimatedCount: 10000, batchSize: 100 },
  2: { name: 'Preview Buyers', estimatedCount: 40000, batchSize: 100 },
  3: { name: 'General Registrants', estimatedCount: 800000, batchSize: 100 },
};

async function main() {
  const config = loadConfig();
  const tierInfo = TIER_CONFIG[TIER];

  if (!tierInfo) {
    logger.error(`Invalid tier: ${TIER}. Use --tier=1, --tier=2, or --tier=3`);
    process.exit(1);
  }

  logger.info(`Starting Tier ${TIER}: ${tierInfo.name} (~${tierInfo.estimatedCount} contacts)`);

  // Initialize checkpoint for resume support
  const totalBatches = Math.ceil(tierInfo.estimatedCount / tierInfo.batchSize);
  const checkpoint = new Checkpoint(TIER, config.paths.checkpointDir);
  const state = checkpoint.load(totalBatches);

  const startBatch = state.lastBatch + 1;
  logger.info(`Resuming from batch ${startBatch}/${totalBatches}`);

  // TODO: Implement the actual migration loop
  // for (let i = startBatch; i < totalBatches; i++) {
  //   1. Extract batch of contacts from GHL (offset = i * batchSize)
  //   2. Clean each record
  //   3. Map fields
  //   4. Deduplicate against HubSpot
  //   5. Batch upsert to HubSpot
  //   6. Log results
  //   7. Update checkpoint
  //   8. Wait (batchDelayMs) to respect rate limits
  // }

  checkpoint.complete(state);
  logger.info(`Tier ${TIER} migration complete`);
}

main().catch((e) => {
  logger.error(`Tier ${TIER} migration failed`, { error: e.message, stack: e.stack });
  process.exit(1);
});
