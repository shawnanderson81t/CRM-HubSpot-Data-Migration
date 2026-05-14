import 'dotenv/config';
import { writeFileSync } from 'fs';
import axios from 'axios';
import { loadConfig } from '../src/utils/config.js';
import { HubSpotClient } from '../src/load/hubspotClient.js';
import { logger } from '../src/utils/logger.js';

/**
 * Build the GHL userId → HubSpot ownerId lookup table.
 *
 * Steps:
 *   1. Pull all GHL users for this location
 *   2. Pull all HubSpot owners
 *   3. Match by email address (case-insensitive)
 *   4. Write data/owner-map.json
 *
 * Run this once before migrate-tier.js or pilot-run.js.
 * Re-run whenever reps are added to the GHL account.
 *
 * Output format: { "ghlUserId": "hubspotOwnerId", ... }
 */

async function getGhlUsers(config) {
  const { data } = await axios.get('https://services.leadconnectorhq.com/users/', {
    headers: {
      Authorization: `Bearer ${config.ghl.apiKey}`,
      Version: '2021-07-28',
    },
    params: { locationId: config.ghl.locationId },
  });

  // API returns { users: [...] }
  const users = data.users || [];
  logger.info(`GHL users fetched: ${users.length}`);
  return users;
}

async function main() {
  const config = loadConfig();

  // 1. Fetch GHL users
  let ghlUsers;
  try {
    ghlUsers = await getGhlUsers(config);
  } catch (err) {
    logger.error('Failed to fetch GHL users', {
      status: err.response?.status,
      detail: err.response?.data,
    });
    process.exit(1);
  }

  // 2. Fetch HubSpot owners
  const hsClient = new HubSpotClient(config);
  const hsOwners = await hsClient.getOwners();
  logger.info(`HubSpot owners fetched: ${hsOwners.length}`);

  // 3. Index HubSpot owners by email (lowercase)
  const ownerByEmail = new Map();
  for (const owner of hsOwners) {
    if (owner.email) ownerByEmail.set(owner.email.toLowerCase(), owner.id);
  }

  // 4. Match GHL users → HubSpot owners by email
  const ownerMap = {};
  const unmatched = [];

  for (const user of ghlUsers) {
    const email = (user.email || '').toLowerCase();
    if (email && ownerByEmail.has(email)) {
      ownerMap[user.id] = ownerByEmail.get(email);
      logger.info(`Matched: GHL ${user.name} (${user.id}) → HS owner ${ownerMap[user.id]}`);
    } else {
      unmatched.push({ id: user.id, name: user.name, email: user.email });
    }
  }

  if (unmatched.length > 0) {
    logger.warn(`${unmatched.length} GHL users had no matching HubSpot owner:`, unmatched);
  }

  // 5. Write output
  writeFileSync('./data/owner-map.json', JSON.stringify(ownerMap, null, 2));
  logger.info(`Owner map written to data/owner-map.json — ${Object.keys(ownerMap).length} entries`);

  // Summary
  console.log(`\nOwner map summary:`);
  console.log(`  GHL users:        ${ghlUsers.length}`);
  console.log(`  HubSpot owners:   ${hsOwners.length}`);
  console.log(`  Matched:          ${Object.keys(ownerMap).length}`);
  console.log(`  Unmatched:        ${unmatched.length}`);
}

main().catch(err => {
  logger.error('build-owner-map failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
