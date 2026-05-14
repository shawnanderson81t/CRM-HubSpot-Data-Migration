import 'dotenv/config';
import { writeFileSync } from 'fs';
import axios from 'axios';
import { loadConfig } from '../src/utils/config.js';
import { logger } from '../src/utils/logger.js';

/**
 * Pull a sample of GHL opportunities to inspect their field structure.
 * Specifically: looking for "lead disposition" — how sales reps record
 * call outcomes (Not Interested, Recycled, Saved, etc.).
 *
 * Usage:
 *   node scripts/sample-opportunity.js             # 5 opportunities (default)
 *   node scripts/sample-opportunity.js --count=20
 *
 * Output: data/samples/opportunity-sample.json
 *
 * After running, inspect the JSON and look for:
 *   - status / leadStatus / disposition field on the opportunity object
 *   - customFields array on the opportunity
 *   - monetaryValue, assignedTo, pipelineStageId
 */

const COUNT = parseInt(
  process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '5'
);

const WORKSHOP_PIPELINE_ID = 'sJF6NWKqQAF4qZGBK3cq';

async function main() {
  const config = loadConfig();

  const { data } = await axios.get(
    'https://services.leadconnectorhq.com/opportunities/search',
    {
      headers: {
        Authorization: `Bearer ${config.ghl.apiKey}`,
        Version: '2021-07-28',
      },
      params: {
        location_id:  config.ghl.locationId,
        pipeline_id:  WORKSHOP_PIPELINE_ID,
        limit:        COUNT,
        page:         1,
      },
    }
  );

  const opportunities = data.opportunities || [];
  logger.info(`Fetched ${opportunities.length} opportunities`);

  const outPath = './data/samples/opportunity-sample.json';
  writeFileSync(outPath, JSON.stringify(opportunities, null, 2));
  logger.info(`Saved to ${outPath}`);

  // Print top-level keys of first opportunity so we can see the structure immediately
  if (opportunities.length > 0) {
    console.log('\n--- Top-level fields on opportunity[0] ---');
    for (const [key, val] of Object.entries(opportunities[0])) {
      const display = Array.isArray(val)
        ? `Array(${val.length})`
        : typeof val === 'object' && val !== null
          ? `Object(${Object.keys(val).join(', ')})`
          : String(val).slice(0, 80);
      console.log(`  ${key}: ${display}`);
    }
  }
}

main().catch(err => {
  logger.error('sample-opportunity failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
