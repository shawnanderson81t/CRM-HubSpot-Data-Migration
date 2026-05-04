import 'dotenv/config';

/**
 * Load and validate environment configuration
 * @returns {Object} Validated config object
 */
export function loadConfig() {
  const required = ['GHL_ENGAGER_SECRET_KEY', 'GHL_LOCATION_ID', 'HUBSPOT_API_KEY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return {
    ghl: {
      engagerSecretKey: process.env.GHL_ENGAGER_SECRET_KEY,
      locationId: process.env.GHL_LOCATION_ID,
    },
    hubspot: {
      apiKey: process.env.HUBSPOT_API_KEY,
      baseUrl: process.env.HUBSPOT_BASE_URL || 'https://api.hubapi.com',
      portalId: process.env.HUBSPOT_PORTAL_ID,
    },
    migration: {
      batchSize: parseInt(process.env.BATCH_SIZE || '100'),
      batchDelayMs: parseInt(process.env.BATCH_DELAY_MS || '1500'),
      maxConcurrent: parseInt(process.env.MAX_CONCURRENT_REQUESTS || '10'),
      rateLimitPerSecond: parseInt(process.env.RATE_LIMIT_PER_SECOND || '10'),
    },
    paths: {
      checkpointDir: process.env.CHECKPOINT_DIR || './data/checkpoints',
      logDir: process.env.LOG_DIR || './logs',
    },
  };
}
