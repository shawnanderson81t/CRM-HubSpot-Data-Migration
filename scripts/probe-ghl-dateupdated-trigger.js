/**
 * THROWAWAY PROBE #2 — does a TAG edit bump a contact's `dateUpdated` in GHL?
 * ------------------------------------------------------------------------------
 * Probe #1 (probe-ghl-modified-filter.js) proved POST /contacts/search can filter
 * on `dateUpdated`. But it only proved `dateUpdated` moves when a contact is
 * created/edited generally — NOT specifically that changing a TAG bumps it. Tags
 * are a primary field the nightly sync must carry (Alex's locked requirements).
 * If a tag-only change does NOT bump `dateUpdated`, the delta would silently miss
 * exactly the edits it exists to catch. This closes that gap before I build
 * getContactsChangedSince(date).
 *
 * READ-ONLY on my side. The only request this makes is GET /contacts/{id}
 * (via GHLClient.getContact). It never writes. The single write involved is the
 * tag YOU add by hand in the GHL UI during the test — see steps below.
 *
 * HOW TO RUN (on the US remote, after fetch/reset):
 *   1. Pick a SAFE contact to test — ideally a disposable/test contact, or any
 *      contact you don't mind adding a temporary tag to and removing after.
 *      Grab its GHL contact ID (from the GHL UI URL, or from probe #1's sample).
 *   2. Start the probe:
 *        node scripts/probe-ghl-dateupdated-trigger.js --contact=<CONTACT_ID>
 *   3. When it prints the baseline and says "watching", switch to the GHL UI and
 *      ADD a temporary tag to that contact (e.g. `zz-sync-probe`) and save.
 *   4. The probe polls the contact (read-only) for up to 3 minutes and reports
 *      the moment `dateUpdated` changes — confirming (or not) that a tag edit
 *      bumps it. Remove the temporary tag afterwards.
 *
 * Options:
 *   --contact=<id>     (required) GHL contact ID to watch
 *   --timeout=<sec>    how long to watch before giving up (default 180)
 *   --interval=<sec>   poll interval (default 5)
 */

import dotenv from 'dotenv';
import { GHLClient } from '../src/extract/ghlClient.js';
import { loadConfig } from '../src/utils/config.js';

dotenv.config();

const sleep = ms => new Promise(r => setTimeout(r, ms));

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const CONTACT_ID = arg('contact');
const TIMEOUT_S  = Math.max(10, parseInt(arg('timeout', '180'), 10) || 180);
const INTERVAL_S = Math.max(2, parseInt(arg('interval', '5'), 10) || 5);

/** Normalise a tags array to a comparable sorted list of strings. */
function tagList(contact) {
  return [...(contact.tags ?? [])].map(String).sort();
}

/** Show what changed between two tag lists. */
function diffTags(before, after) {
  const b = new Set(before), a = new Set(after);
  const added   = after.filter(t => !b.has(t));
  const removed = before.filter(t => !a.has(t));
  return { added, removed };
}

async function main() {
  if (!CONTACT_ID) {
    console.error('\n  Missing --contact=<id>. Pass a GHL contact ID to watch.');
    console.error('  Example: node scripts/probe-ghl-dateupdated-trigger.js --contact=JsYWOBbHEwhMG0zP3Jz2\n');
    process.exit(1);
  }

  const config = loadConfig();
  const ghl = new GHLClient({ apiKey: config.ghl.apiKey, locationId: config.ghl.locationId });

  console.log('\n=== GHL dateUpdated Tag-Trigger Probe (READ-ONLY) ===');
  console.log(`  Contact : ${CONTACT_ID}`);
  console.log(`  Watching: up to ${TIMEOUT_S}s, polling every ${INTERVAL_S}s\n`);

  // --- baseline snapshot ------------------------------------------------------
  let baseline;
  try {
    baseline = await ghl.getContact(CONTACT_ID);
  } catch (err) {
    console.error(`  Could not read contact ${CONTACT_ID}: ${err.message}`);
    process.exit(1);
  }

  const baseUpdated = baseline.dateUpdated ?? null;
  const baseTags    = tagList(baseline);
  const name = `${baseline.firstName ?? ''} ${baseline.lastName ?? ''}`.trim() || '(no name)';

  console.log(`  Baseline:`);
  console.log(`    name        : ${name}`);
  console.log(`    email       : ${baseline.email ?? '(none)'}`);
  console.log(`    dateUpdated : ${baseUpdated}`);
  console.log(`    tags        : [${baseTags.join(', ')}]`);
  console.log('\n  >>> NOW: in the GHL UI, add a temporary tag to this contact (e.g. "zz-sync-probe") and save.');
  console.log('      I am watching for dateUpdated to change...\n');

  // --- poll (read-only) -------------------------------------------------------
  const deadline = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    await sleep(INTERVAL_S * 1000);

    let current;
    try {
      current = await ghl.getContact(CONTACT_ID);
    } catch (err) {
      console.log(`    (read failed, will retry): ${err.message}`);
      continue;
    }

    const curUpdated = current.dateUpdated ?? null;
    const curTags    = tagList(current);
    const remaining  = Math.round((deadline - Date.now()) / 1000);

    if (curUpdated !== baseUpdated) {
      const { added, removed } = diffTags(baseTags, curTags);
      const deltaMs = Date.parse(curUpdated) - Date.parse(baseUpdated);

      console.log(`  ✅ dateUpdated CHANGED.`);
      console.log(`     before : ${baseUpdated}`);
      console.log(`     after  : ${curUpdated}   (+${Number.isFinite(deltaMs) ? Math.round(deltaMs / 1000) + 's' : 'n/a'})`);
      console.log(`     tags added   : [${added.join(', ') || 'none'}]`);
      console.log(`     tags removed : [${removed.join(', ') || 'none'}]`);

      console.log('\n=== VERDICT ===');
      if (added.length || removed.length) {
        console.log('  ✅ A TAG edit bumped dateUpdated. The nightly delta WILL catch tag changes.');
        console.log('     Safe to build getContactsChangedSince(date) on dateUpdated for tag sync.');
      } else {
        console.log('  ⚠️  dateUpdated changed but the tag list did NOT — something else touched this');
        console.log('     contact during the watch (background process / reverse-sync?). Re-run on a');
        console.log('     quiet contact and confirm the change lines up with YOUR tag edit.');
      }
      process.exit(0);
    }

    process.stdout.write(`\r    watching... dateUpdated still ${curUpdated}  (${remaining}s left)   `);
  }

  // --- timed out --------------------------------------------------------------
  console.log('\n\n=== VERDICT ===');
  console.log('  ❌ dateUpdated did NOT change within the watch window.');
  console.log('     Either the tag edit was not saved in time, OR a tag-only change does not bump');
  console.log('     dateUpdated. Before trusting the delta for tag sync:');
  console.log('       - re-run with a longer --timeout and make sure you SAVE the tag in the UI, and');
  console.log('       - if it still does not move, a tag-only edit does NOT bump dateUpdated → the');
  console.log('         sync needs a tag-aware fallback (periodic full tag re-scan, or webhooks).');
  process.exit(2);
}

main().catch(err => {
  console.error('\nProbe crashed:', err.message);
  process.exit(1);
});
