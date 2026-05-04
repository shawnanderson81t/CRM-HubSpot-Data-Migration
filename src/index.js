import 'dotenv/config';
import { logger } from './utils/logger.js';
import { loadConfig } from './utils/config.js';

/**
 * Main migration orchestrator
 * Usage: node src/index.js --tier=1 --batch-size=100
 */
async function main() {
  const config = loadConfig();
  const tier = parseInt(process.argv.find(a => a.startsWith('--tier='))?.split('=')[1] || '1');

  logger.info(`Starting migration for Tier ${tier}`, { config: { ...config, hubspotToken: '***' } });

  try {
    // Step 1: Extract from GHL
    // Step 2: Transform (map fields, clean, deduplicate)
    // Step 3: Load into HubSpot (batch upsert with checkpointing)
    // Step 4: Build associations (guest_of)
    // Step 5: Validate

    logger.info(`Tier ${tier} migration complete`);
  } catch (error) {
    logger.error('Migration failed', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

main();
