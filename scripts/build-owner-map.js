import 'dotenv/config';
import { writeFileSync, readFileSync } from 'fs';
import axios from 'axios';
import { loadConfig } from '../src/utils/config.js';
import { HubSpotClient } from '../src/load/hubspotClient.js';
import { logger } from '../src/utils/logger.js';

/**
 * Build the GHL userId → HubSpot ownerId lookup table.
 *
 * Strategy (tries in order):
 *   1. GET /locations/{locationId}/users  (location-scoped, most likely to work)
 *   2. GET /users/{id} for each unique assignedTo found in contacts sample
 *      (fallback when bulk user list is blocked by token scope)
 *
 * Output: data/owner-map.json  { "ghlUserId": "hubspotOwnerId" }
 *
 * Run before migrate-tier.js or pilot-run.js.
 */

const GHL_BASE = 'https://services.leadconnectorhq.com';

/**
 * Attempt 1: GET /locations/{locationId}/users
 * @param {Object} config
 * @returns {Promise<Array|null>} users array or null if not allowed
 */
async function fetchLocationUsers(config) {
  try {
    const { data } = await axios.get(
      `${GHL_BASE}/locations/${config.ghl.locationId}/users`,
      {
        headers: {
          Authorization: `Bearer ${config.ghl.apiKey}`,
          Version: '2021-07-28',
        },
      }
    );
    const users = data.users || data || [];
    logger.info(`Location users endpoint: ${users.length} users`);
    return Array.isArray(users) ? users : [];
  } catch (err) {
    logger.warn(`Location users endpoint failed (${err.response?.status}) — trying fallback`);
    return null;
  }
}

/**
 * Attempt 2: collect unique assignedTo IDs from the contacts sample file,
 * then look up each user individually via GET /users/{id}.
 * @param {Object} config
 * @returns {Promise<Array>}
 */
async function fetchUsersFromSample(config) {
  let contacts;
  try {
    contacts = JSON.parse(readFileSync('./data/samples/workshop-buyers-sample.json', 'utf-8'));
  } catch {
    logger.error('Cannot read workshop-buyers-sample.json — run extract:wb first');
    return [];
  }

  const userIds = [...new Set(contacts.map(c => c.assignedTo).filter(Boolean))];
  logger.info(`Found ${userIds.length} unique assignedTo IDs in sample contacts`);

  const users = [];
  for (const id of userIds) {
    try {
      const { data } = await axios.get(`${GHL_BASE}/users/${id}`, {
        headers: {
          Authorization: `Bearer ${config.ghl.apiKey}`,
          Version: '2021-07-28',
        },
      });
      users.push(data);
      logger.info(`  Fetched user: ${data.name || data.email} (${id})`);
    } catch (err) {
      logger.warn(`  Cannot fetch user ${id}: ${err.response?.status} — skipping`);
    }
  }
  return users;
}

async function main() {
  const config = loadConfig();

  // Step 1: Try to get GHL users
  let ghlUsers = await fetchLocationUsers(config);
  if (!ghlUsers || ghlUsers.length === 0) {
    ghlUsers = await fetchUsersFromSample(config);
  }

  if (ghlUsers.length === 0) {
    logger.error('Could not retrieve any GHL users via either method.');
    logger.error('The token may not have users scope. Contact Andy to check GHL integration permissions.');
    process.exit(1);
  }

  // Step 2: Fetch HubSpot owners
  const hsClient = new HubSpotClient(config);
  const hsOwners = await hsClient.getOwners();
  logger.info(`HubSpot owners fetched: ${hsOwners.length}`);

  // Step 3: Index HubSpot owners by email
  const ownerByEmail = new Map();
  for (const owner of hsOwners) {
    if (owner.email) ownerByEmail.set(owner.email.toLowerCase(), owner.id);
  }

  // Step 4: Match GHL users → HubSpot owners by email
  const ownerMap = {};
  const unmatched = [];

  for (const user of ghlUsers) {
    const email = (user.email || '').toLowerCase();
    if (email && ownerByEmail.has(email)) {
      ownerMap[user.id] = ownerByEmail.get(email);
      logger.info(`Matched: ${user.name || user.email} (${user.id}) → HS owner ${ownerMap[user.id]}`);
    } else {
      unmatched.push({ id: user.id, name: user.name, email: user.email });
    }
  }

  if (unmatched.length > 0) {
    logger.warn(`${unmatched.length} GHL users with no HubSpot owner match:`);
    for (const u of unmatched) {
      logger.warn(`  ${u.name} (${u.id}) — email: ${u.email || 'none'}`);
    }
  }

  // Step 5: Write output
  writeFileSync('./data/owner-map.json', JSON.stringify(ownerMap, null, 2));

  console.log('\nOwner map summary:');
  console.log(`  GHL users found:  ${ghlUsers.length}`);
  console.log(`  HubSpot owners:   ${hsOwners.length}`);
  console.log(`  Matched:          ${Object.keys(ownerMap).length}`);
  console.log(`  Unmatched:        ${unmatched.length}`);
  console.log(`  Written to:       data/owner-map.json`);
}

main().catch(err => {
  logger.error('build-owner-map failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
