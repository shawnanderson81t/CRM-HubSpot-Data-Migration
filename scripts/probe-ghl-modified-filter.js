/**
 * THROWAWAY PROBE — does GHL's POST /contacts/search filter on a MODIFICATION date?
 * ------------------------------------------------------------------------------
 * Blocks Phase 2 (Delta Extraction Engine). The migration only ever proved a
 * `dateAdded` (creation-time) range filter. A daily sync needs `dateUpdated`
 * (modification-time) so we don't miss contacts that were EDITED but not newly
 * created. This script confirms whether such a filter exists before we design
 * getContactsChangedSince(date).
 *
 * READ-ONLY. The only request it makes is POST /contacts/search (a read despite
 * the verb). It never writes, updates, merges, or deletes anything.
 *
 * What it does:
 *   1. CONTROL A — unfiltered search → baseline `total` (all contacts).
 *   2. CONTROL B — dateAdded range over a recent window → count of contacts
 *      *created* in that window (the filter we already trust).
 *   3. TESTS     — the same recent window applied to candidate modification-date
 *      field names (dateUpdated, dateModified, lastUpdated, updatedAt,
 *      last_modified) with operator 'range'.
 *
 * Why the controls matter: GHL may ACCEPT an unknown field name and silently
 * ignore it, returning the full unfiltered total (200, but the filter did
 * nothing). So for every candidate that returns 200 we don't just trust the
 * status — we inspect the returned contacts' own dateAdded / dateUpdated values
 * and check that:
 *     - their dateUpdated actually falls inside the requested window, and
 *     - some were created BEFORE the window (old contact, recent edit).
 * That combination is the real proof a modification filter works.
 *
 * Usage (on the US remote machine, after fetch/reset):
 *   node scripts/probe-ghl-modified-filter.js
 *   node scripts/probe-ghl-modified-filter.js --days=2     // narrower window
 *
 * Output: prints a verdict to the console and writes the raw findings to
 *   data/reports/ghl-modified-filter-probe-[ts].json
 */

import dotenv from 'dotenv';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { loadConfig } from '../src/utils/config.js';

dotenv.config();

const __dirname   = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(__dirname, '../data/reports');

const PAGE_LIMIT = 10; // we only need `total` + a small sample, not full pages

// --- window: last N days (default 7) -----------------------------------------
const daysArg  = process.argv.find(a => a.startsWith('--days='));
const DAYS_BACK = daysArg ? Math.max(1, parseInt(daysArg.split('=')[1], 10) || 7) : 7;

const now = new Date();
const WINDOW = {
  gte: new Date(now.getTime() - DAYS_BACK * 24 * 60 * 60 * 1000).toISOString(),
  lte: now.toISOString(),
};

/**
 * Candidate modification-date field names to probe (range operator each).
 * dateUpdated is by far the likeliest — it's the field name GHL returns on the
 * contact object itself — but the search layer sometimes names filters
 * differently from the response, so we try the common variants too.
 */
const CANDIDATES = ['dateUpdated', 'dateModified', 'lastUpdated', 'updatedAt', 'last_modified'];

/**
 * Issue one POST /contacts/search and return a normalised result.
 * @param {import('axios').AxiosInstance} client
 * @param {string} locationId
 * @param {Array<Object>} filters - GHL search filter array (may be empty)
 * @returns {Promise<{ status: number, total: number|null, contacts: Array, error: string|null }>}
 */
async function search(client, locationId, filters) {
  try {
    const res = await client.post('/contacts/search', {
      locationId,
      filters,
      pageLimit: PAGE_LIMIT,
      page: 1,
    });
    return {
      status: res.status,
      total: res.data?.total ?? null,
      contacts: res.data?.contacts ?? [],
      error: null,
    };
  } catch (err) {
    const status = err.response?.status ?? 0;
    // Surface GHL's own message — it usually names the offending field.
    const body = err.response?.data;
    const message = typeof body === 'object' ? JSON.stringify(body) : (body || err.message);
    return { status, total: null, contacts: [], error: message };
  }
}

/**
 * Parse a GHL date value (epoch ms number, numeric string, or ISO string) to ms.
 * @param {*} v
 * @returns {number|null}
 */
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (/^\d+$/.test(String(v))) return parseInt(v, 10);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * For a candidate that returned 200, decide whether the filter was actually
 * honoured by inspecting the returned contacts' own date fields.
 * @param {Array} contacts
 * @returns {{ sampled: number, updatedInWindow: number, createdBeforeWindow: number, samples: Array }}
 */
function verifyHonoured(contacts) {
  const gteMs = Date.parse(WINDOW.gte);
  const lteMs = Date.parse(WINDOW.lte);
  let updatedInWindow = 0;
  let createdBeforeWindow = 0;
  const samples = [];

  for (const c of contacts.slice(0, 5)) {
    const upd = toMs(c.dateUpdated ?? c.dateModified ?? c.updatedAt);
    const add = toMs(c.dateAdded ?? c.createdAt);
    if (upd != null && upd >= gteMs && upd <= lteMs) updatedInWindow++;
    if (add != null && add < gteMs) createdBeforeWindow++;
    samples.push({
      id: c.id,
      dateAdded: c.dateAdded ?? c.createdAt ?? null,
      dateUpdated: c.dateUpdated ?? c.dateModified ?? c.updatedAt ?? null,
    });
  }
  return { sampled: samples.length, updatedInWindow, createdBeforeWindow, samples };
}

async function main() {
  const config = loadConfig();
  const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
  const GHL_VERSION  = process.env.GHL_VERSION  || '2021-07-28';
  const locationId   = config.ghl.locationId;

  const client = axios.create({
    baseURL: GHL_BASE_URL,
    headers: {
      Authorization: `Bearer ${config.ghl.apiKey}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
    },
  });

  console.log('\n=== GHL Modification-Date Filter Probe (READ-ONLY) ===');
  console.log(`  Window : last ${DAYS_BACK} day(s)`);
  console.log(`           gte=${WINDOW.gte}`);
  console.log(`           lte=${WINDOW.lte}\n`);

  // --- CONTROL A: unfiltered baseline ----------------------------------------
  const baseline = await search(client, locationId, []);
  if (baseline.error) {
    console.error(`  CONTROL A (unfiltered) FAILED — HTTP ${baseline.status}: ${baseline.error}`);
    console.error('  Cannot establish a baseline; check API key / locationId / connectivity. Aborting.');
    process.exit(1);
  }
  console.log(`  CONTROL A  unfiltered baseline total : ${baseline.total}   (HTTP ${baseline.status})`);

  // --- CONTROL B: dateAdded range (the filter we already trust) ---------------
  const addedFilter = [{ field: 'dateAdded', operator: 'range', value: { gte: WINDOW.gte, lte: WINDOW.lte } }];
  const added = await search(client, locationId, addedFilter);
  if (added.error) {
    console.log(`  CONTROL B  dateAdded in window       : ERROR HTTP ${added.status} — ${added.error}`);
  } else {
    console.log(`  CONTROL B  dateAdded in window       : ${added.total}   (HTTP ${added.status})  <- contacts CREATED in window`);
  }

  // --- TESTS: candidate modification-date fields ------------------------------
  console.log('\n  Candidate modification-date fields (operator: range, same window):\n');
  const results = [];
  for (const field of CANDIDATES) {
    const filters = [{ field, operator: 'range', value: { gte: WINDOW.gte, lte: WINDOW.lte } }];
    const r = await search(client, locationId, filters);

    if (r.error) {
      console.log(`    ${field.padEnd(14)} HTTP ${r.status}  REJECTED  ${r.error}`);
      results.push({ field, status: r.status, accepted: false, error: r.error });
      continue;
    }

    const ignored = baseline.total != null && r.total === baseline.total;
    const verify  = verifyHonoured(r.contacts);

    let interpretation;
    if (ignored) {
      interpretation = 'ACCEPTED BUT IGNORED (total == unfiltered baseline — filter had no effect)';
    } else if (verify.updatedInWindow > 0) {
      interpretation = 'HONOURED (returned contacts have dateUpdated inside the window)';
    } else {
      interpretation = 'ACCEPTED — total differs from baseline, but could not confirm dateUpdated on samples';
    }

    console.log(`    ${field.padEnd(14)} HTTP ${r.status}  total=${r.total}  ${interpretation}`);
    if (!ignored && verify.sampled > 0) {
      console.log(`        sample: ${verify.updatedInWindow}/${verify.sampled} updated-in-window, ` +
                  `${verify.createdBeforeWindow}/${verify.sampled} created-before-window (= old contact, recent edit)`);
      for (const s of verify.samples) {
        console.log(`          ${String(s.id).padEnd(26)} added=${s.dateAdded}  updated=${s.dateUpdated}`);
      }
    }

    results.push({
      field, status: r.status, accepted: true,
      total: r.total, ignored, verify,
    });
  }

  // --- VERDICT ----------------------------------------------------------------
  const honoured = results.find(r => r.accepted && !r.ignored && r.verify?.updatedInWindow > 0);
  const acceptedDiff = results.find(r => r.accepted && !r.ignored);

  console.log('\n=== VERDICT ===');
  if (honoured) {
    console.log(`  ✅ GHL DOES filter on modification date via field "${honoured.field}".`);
    console.log('     Build getContactsChangedSince(date) on this field with operator:range,');
    console.log('     reusing the Tier 2 monthly/daily chunking to stay under the 10K-per-query cap.');
  } else if (acceptedDiff) {
    console.log(`  ⚠️  Field "${acceptedDiff.field}" was ACCEPTED and changed the result count, but the`);
    console.log('     probe could not confirm via sample dates that it filters on modification time.');
    console.log('     Re-run with --days=2 and eyeball the sample dateUpdated values above before trusting it.');
  } else if (results.some(r => r.accepted && r.ignored)) {
    console.log('  ❌ Candidate field(s) were accepted but IGNORED (count == unfiltered baseline).');
    console.log('     No real modification-date filter. Fall back to: dateAdded for new contacts +');
    console.log('     a rolling N-day re-scan for edits, or GHL webhooks if available.');
  } else {
    console.log('  ❌ All candidate fields were REJECTED (4xx). No modification-date filter on search.');
    console.log('     Fall back to: dateAdded for new contacts + a rolling N-day re-scan for edits,');
    console.log('     or GHL webhooks if available. (Check the rejection messages above — they may');
    console.log('     name the only accepted filter fields.)');
  }

  // --- write raw findings -----------------------------------------------------
  const report = {
    timestamp: new Date().toISOString(),
    window: WINDOW,
    daysBack: DAYS_BACK,
    control: {
      unfilteredBaselineTotal: baseline.total,
      dateAddedInWindowTotal: added.error ? null : added.total,
    },
    candidates: results,
    verdict: honoured
      ? `supported via ${honoured.field}`
      : acceptedDiff
        ? `inconclusive via ${acceptedDiff.field} — manual check needed`
        : 'not supported — use fallback',
  };
  mkdirSync(REPORTS_DIR, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g, '-');
  const out  = join(REPORTS_DIR, `ghl-modified-filter-probe-${ts}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n  Raw findings written to: ${out}\n`);
}

main().catch(err => {
  console.error('\nProbe crashed:', err.message);
  process.exit(1);
});
