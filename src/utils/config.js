import 'dotenv/config';

/**
 * Load and validate environment configuration
 * @returns {Object} Validated config object
 */
export function loadConfig() {
  const required = ['GHL_API_KEY', 'GHL_LOCATION_ID', 'HUBSPOT_API_KEY'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return {
    ghl: {
      apiKey: process.env.GHL_API_KEY,
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
      concurrency: parseInt(process.env.MIGRATION_CONCURRENCY || '1'),
      maxConcurrent: parseInt(process.env.MAX_CONCURRENT_REQUESTS || '10'),
      rateLimitPerSecond: parseInt(process.env.RATE_LIMIT_PER_SECOND || '10'),
    },
    paths: {
      checkpointDir: process.env.CHECKPOINT_DIR || './data/checkpoints',
      logDir: process.env.LOG_DIR || './logs',
    },
    sync: {
      statePath: process.env.SYNC_STATE_PATH || './data/sync-state.json',
      lockPath:  process.env.SYNC_LOCK_PATH  || './data/sync.lock',
      // First run only (no watermark yet): how far back to look.
      defaultLookbackHours: parseInt(process.env.SYNC_DEFAULT_LOOKBACK_HOURS || '24', 10),
      // Reverse-sync loop guard — contacts written back into GHL from HubSpot.
      excludeTags: (process.env.SYNC_EXCLUDE_TAGS || 'hs-to-hl,hs-transfer')
        .split(',').map(s => s.trim()).filter(Boolean),
      // 09:00 UTC = 2:00 AM MST (used only by the optional --schedule loop).
      scheduleUtcHour: parseInt(process.env.SYNC_SCHEDULE_UTC_HOUR || '9', 10),
      // Above this per-run failure rate the run is treated as failed (watermark held + alert).
      maxFailureRate: parseFloat(process.env.SYNC_MAX_FAILURE_RATE || '0.1'),
    },
  };
}
