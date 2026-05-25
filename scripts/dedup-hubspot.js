/**
 * HubSpot Duplicate Detection & Merge
 *
 * Phase 1 --pull:
 *   Paginates all HubSpot contacts, groups by normalized name, classifies pairs
 *   as auto-merge (clear email typo) or manual-review (ambiguous).
 *   Output: data/reports/dedup-pairs.json + data/reports/dedup-manual-review.csv
 *
 * Phase 2 --dry-run:
 *   Reads pairs report, prints what would be merged without touching HubSpot.
 *
 * Phase 3 --merge:
 *   Executes auto-merge pairs via HubSpot merge API. Checkpoints after every
 *   10 merges — safe to resume with --merge --resume.
 *
 * Usage:
 *   npm run dedup:pull
 *   npm run dedup:dry-run
 *   npm run dedup:merge
 *   npm run dedup:merge -- --resume
 */

import dotenv from 'dotenv';
import {
  writeFileSync, readFileSync, mkdirSync, existsSync, createWriteStream, createReadStream,
} from 'fs';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../src/utils/config.js';
import { logger } from '../src/utils/logger.js';
import axios from 'axios';

dotenv.config();

const __dirname     = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR   = join(__dirname, '../data/reports');
const CP_DIR        = join(__dirname, '../data/checkpoints');
const CONTACTS_NDJSON = join(CP_DIR,      'dedup-contacts.ndjson');
const PAIRS_FILE    = join(REPORTS_DIR,   'dedup-pairs.json');
const MANUAL_CSV    = join(REPORTS_DIR,   'dedup-manual-review.csv');
const MERGE_CP_FILE = join(CP_DIR,        'dedup-merge-checkpoint.json');

const PULL    = process.argv.includes('--pull');
const ANALYZE = process.argv.includes('--analyze');
const MERGE   = process.argv.includes('--merge');
const DRY_RUN = process.argv.includes('--dry-run');
const RESUME  = process.argv.includes('--resume');

const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Levenshtein distance ──────────────────────────────────────────────────────

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ── Name + email helpers ──────────────────────────────────────────────────────

const COMMON_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'aol.com', 'icloud.com', 'me.com', 'live.com', 'msn.com',
]);

/**
 * @param {Object} c - HubSpot contact object
 * @returns {string|null}
 */
function normalizedName(c) {
  const first = (c.properties?.firstname || '').trim().toLowerCase();
  const last  = (c.properties?.lastname  || '').trim().toLowerCase();
  if (!first && !last) return null;
  return `${first}|${last}`;
}

/**
 * @param {string} domain
 * @returns {boolean}
 */
function isCommonDomain(domain) {
  return COMMON_DOMAINS.has(domain);
}

// ── Pair classification ───────────────────────────────────────────────────────

/**
 * Determine if two same-name contacts are duplicates and how to handle them.
 * Returns null if they are clearly NOT duplicates.
 *
 * Same name alone is NOT enough — the database has thousands of people named
 * "John Smith". A second corroborating signal (email typo, same phone, or same
 * email local-part) is required before flagging a pair.
 *
 * @param {Object} c1
 * @param {Object} c2
 * @returns {{ classification: string, reason: string } | null}
 */
function classifyPair(c1, c2) {
  const e1 = (c1.properties?.email || '').toLowerCase().trim();
  const e2 = (c2.properties?.email || '').toLowerCase().trim();
  const p1 = (c1.properties?.phone || '').replace(/\D/g, '');
  const p2 = (c2.properties?.phone || '').replace(/\D/g, '');

  // One has no email — can only merge if they also share a phone (otherwise too risky)
  if (!e1 || !e2) {
    if (p1 && p2 && p1 === p2 && p1.length >= 10) {
      return { classification: 'auto-merge', reason: 'same_phone_one_no_email' };
    }
    return null;
  }

  if (e1 === e2) return null;

  const [local1 = '', domain1 = ''] = e1.split('@');
  const [local2 = '', domain2 = ''] = e2.split('@');

  // Same local part, typo domain (e.g. gmail.com vs gmsil.com)
  if (local1 === local2 && levenshtein(domain1, domain2) <= 2) {
    return { classification: 'auto-merge', reason: 'domain_typo' };
  }

  // Same domain, typo local part (e.g. joh@gmail.com vs john@gmail.com)
  if (domain1 === domain2 && levenshtein(local1, local2) <= 1) {
    return { classification: 'auto-merge', reason: 'local_typo' };
  }

  // Overall email very close (≤ 2 edits)
  if (levenshtein(e1, e2) <= 2) {
    return { classification: 'auto-merge', reason: 'email_typo' };
  }

  // Same phone number + same name = very strong signal, different email
  // Primary chosen by most recent hs_last_activity_date (per Andy's request, 2026-05-24)
  if (p1 && p2 && p1 === p2 && p1.length >= 10) {
    return { classification: 'auto-merge', reason: 'same_phone_different_email' };
  }

  // Same email local part, different domain (e.g. john@gmail.com vs john@yahoo.com)
  if (local1 === local2 && local1.length >= 4) {
    return { classification: 'manual-review', reason: 'same_local_different_domain' };
  }

  // Email distance 3–4 (possible typo but not certain)
  if (levenshtein(e1, e2) <= 4) {
    return { classification: 'manual-review', reason: 'possible_email_typo' };
  }

  // No corroborating signal — different people who share a name
  return null;
}

/**
 * Choose which contact to keep (primary) and which to merge away.
 * Prefers: valid/common domain > has email > most recently active (hs_last_activity_date).
 * Using most recently active aligns with Andy's preference for same_phone_different_email pairs
 * and is a sensible default for all pair types.
 *
 * @param {Object} c1
 * @param {Object} c2
 * @returns {{ primary: Object, toMerge: Object }}
 */
function choosePrimary(c1, c2) {
  const e1 = (c1.properties?.email || '').toLowerCase().trim();
  const e2 = (c2.properties?.email || '').toLowerCase().trim();
  const [, domain1 = ''] = e1.split('@');
  const [, domain2 = ''] = e2.split('@');

  const d1ok = isCommonDomain(domain1);
  const d2ok = isCommonDomain(domain2);
  if (d1ok && !d2ok) return { primary: c1, toMerge: c2 };
  if (d2ok && !d1ok) return { primary: c2, toMerge: c1 };

  if (e1 && !e2) return { primary: c1, toMerge: c2 };
  if (e2 && !e1) return { primary: c2, toMerge: c1 };

  // Keep the most recently active contact (most recently used = primary)
  const a1 = new Date(c1.properties?.hs_last_activity_date || c1.properties?.createdate || 0).getTime();
  const a2 = new Date(c2.properties?.hs_last_activity_date || c2.properties?.createdate || 0).getTime();
  return a1 >= a2 ? { primary: c1, toMerge: c2 } : { primary: c2, toMerge: c1 };
}

// ── HubSpot API with retry ────────────────────────────────────────────────────

/**
 * @param {Function} fn
 * @param {string} label
 */
async function withRetry(fn, label = '') {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status     = err.response?.status;
      const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0');
      const retryable  = RETRYABLE.has(status) || !status;
      if (retryable && attempt < 6) {
        const delay = retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt;
        logger.warn(`HubSpot ${status ?? 'network'} [${label}] — retry ${attempt} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

// ── Phase 1a: Pull all contacts from HubSpot ─────────────────────────────────

/**
 * @param {import('axios').AxiosInstance} client
 * @returns {Promise<number>} total contacts pulled
 */
async function pullContacts(client) {
  console.log('\n  Pulling all HubSpot contacts (this may take 10-15 min)...');
  mkdirSync(CP_DIR, { recursive: true });

  const ws    = createWriteStream(CONTACTS_NDJSON);
  const PROPS = 'firstname,lastname,email,phone,createdate,hs_last_activity_date';
  let after   = undefined;
  let total   = 0;

  while (true) {
    const params = { limit: 100, properties: PROPS };
    if (after) params.after = after;

    const { data } = await withRetry(
      () => client.get('/crm/v3/objects/contacts', { params }),
      'GET contacts'
    );

    for (const c of data.results ?? []) {
      ws.write(JSON.stringify(c) + '\n');
      total++;
    }

    process.stdout.write(`\r  Pulled ${total.toLocaleString()} contacts...`);

    after = data.paging?.next?.after;
    if (!after) break;
    await sleep(120); // stay under rate limit
  }

  await new Promise((res, rej) => ws.end(err => err ? rej(err) : res()));
  console.log(`\n  Done — ${total.toLocaleString()} contacts saved to checkpoint`);
  return total;
}

// ── Phase 1b: Group by name and find pairs ────────────────────────────────────

/**
 * @returns {Promise<{ autoMerge: Array, manualReview: Array }>}
 */
async function findDuplicatePairs() {
  console.log('\n  Grouping contacts by name...');

  const byName = new Map();
  const rl = createInterface({ input: createReadStream(CONTACTS_NDJSON), crlfDelay: Infinity });
  let count = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let c;
    try { c = JSON.parse(line); } catch { continue; }
    const name = normalizedName(c);
    if (!name) { count++; continue; }
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(c);
    count++;
  }

  console.log(`  Grouped ${count.toLocaleString()} contacts into ${byName.size.toLocaleString()} name groups`);
  console.log('  Identifying duplicate pairs...');

  const autoMerge   = [];
  const manualReview = [];

  for (const [, contacts] of byName) {
    if (contacts.length < 2) continue;
    for (let i = 0; i < contacts.length; i++) {
      for (let j = i + 1; j < contacts.length; j++) {
        const result = classifyPair(contacts[i], contacts[j]);
        if (!result) continue;
        const { primary, toMerge } = choosePrimary(contacts[i], contacts[j]);
        const pair = {
          primary: {
            id:        primary.id,
            email:     primary.properties?.email  || '',
            firstname: primary.properties?.firstname || '',
            lastname:  primary.properties?.lastname  || '',
            createdAt: primary.properties?.createdate || '',
          },
          toMerge: {
            id:        toMerge.id,
            email:     toMerge.properties?.email  || '',
            firstname: toMerge.properties?.firstname || '',
            lastname:  toMerge.properties?.lastname  || '',
            createdAt: toMerge.properties?.createdate || '',
          },
          reason:         result.reason,
          classification: result.classification,
        };
        if (result.classification === 'auto-merge') autoMerge.push(pair);
        else manualReview.push(pair);
      }
    }
  }

  return { autoMerge, manualReview };
}

// ── Phase 1c: Write report files ──────────────────────────────────────────────

/**
 * @param {{ autoMerge: Array, manualReview: Array }} pairs
 */
function writePairsReport({ autoMerge, manualReview }) {
  mkdirSync(REPORTS_DIR, { recursive: true });

  writeFileSync(PAIRS_FILE, JSON.stringify({
    generatedAt:       new Date().toISOString(),
    totalPairs:        autoMerge.length + manualReview.length,
    autoMergePairs:    autoMerge.length,
    manualReviewPairs: manualReview.length,
    autoMerge,
    manualReview,
  }, null, 2));

  const csvLines = [
    'primary_id,primary_email,primary_name,duplicate_id,duplicate_email,duplicate_name,reason',
    ...manualReview.map(p =>
      `${p.primary.id},"${p.primary.email}","${p.primary.firstname} ${p.primary.lastname}",` +
      `${p.toMerge.id},"${p.toMerge.email}","${p.toMerge.firstname} ${p.toMerge.lastname}","${p.reason}"`
    ),
  ];
  writeFileSync(MANUAL_CSV, csvLines.join('\n'));

  console.log('\n  ── Duplicate Pairs Found ──────────────────────────────');
  console.log(`  Auto-merge  (clear typos)  : ${autoMerge.length.toLocaleString()}`);
  console.log(`  Manual review (ambiguous)  : ${manualReview.length.toLocaleString()}`);
  console.log(`  Total                      : ${(autoMerge.length + manualReview.length).toLocaleString()}`);
  console.log('\n  Files written:');
  console.log('    data/reports/dedup-pairs.json          — full pairs list (for merge script)');
  console.log('    data/reports/dedup-manual-review.csv   — ambiguous pairs for client review');
}

// ── Phase 2: Merge ────────────────────────────────────────────────────────────

/**
 * @param {import('axios').AxiosInstance} client
 * @param {boolean} dryRun
 */
async function mergeDuplicates(client, dryRun) {
  if (!existsSync(PAIRS_FILE)) {
    console.error('No pairs file found. Run npm run dedup:pull first.');
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(PAIRS_FILE, 'utf-8'));
  const pairs  = report.autoMerge;

  let startIndex   = 0;
  let mergedCount  = 0;
  let failedCount  = 0;
  const failedRecords = [];

  if (RESUME && existsSync(MERGE_CP_FILE)) {
    const cp = JSON.parse(readFileSync(MERGE_CP_FILE, 'utf-8'));
    startIndex   = cp.lastIndex + 1;
    mergedCount  = cp.merged;
    failedCount  = cp.failed;
    failedRecords.push(...(cp.failedRecords ?? []));
    console.log(`\n  Resuming from pair ${startIndex} (${mergedCount} already merged)`);
  }

  const saveCheckpoint = (idx) => {
    writeFileSync(MERGE_CP_FILE, JSON.stringify({ lastIndex: idx, merged: mergedCount, failed: failedCount, failedRecords }));
  };

  const remaining = pairs.length - startIndex;
  console.log(`\n  ${dryRun ? '[DRY RUN] ' : ''}Processing ${remaining.toLocaleString()} auto-merge pairs...`);

  for (let i = startIndex; i < pairs.length; i++) {
    const { primary, toMerge, reason } = pairs[i];

    if (dryRun) {
      console.log(`  [DRY RUN] ${toMerge.email || toMerge.id}  →  ${primary.email || primary.id}`);
      mergedCount++;
      continue;
    }

    try {
      await withRetry(
        () => client.post('/crm/v3/objects/contacts/merge', {
          primaryObjectId: primary.id,
          objectIdToMerge: toMerge.id,
        }),
        `merge ${toMerge.id}→${primary.id}`
      );
      mergedCount++;
    } catch (err) {
      const errorMsg = err.response?.data?.message || err.message;
      logger.warn(`merge failed: ${toMerge.id}→${primary.id} — ${errorMsg}`);
      failedRecords.push({
        reason,
        primaryId:    primary.id,
        primaryEmail: primary.email,
        primaryName:  `${primary.firstname} ${primary.lastname}`.trim(),
        toMergeId:    toMerge.id,
        toMergeEmail: toMerge.email,
        toMergeName:  `${toMerge.firstname} ${toMerge.lastname}`.trim(),
        error:        errorMsg,
      });
      failedCount++;
    }

    if (i % 10 === 0) {
      saveCheckpoint(i);
      process.stdout.write(`\r  Merged ${mergedCount}/${pairs.length} (${failedCount} failed)...`);
    }

    await sleep(200);
  }

  saveCheckpoint(pairs.length - 1);

  // Write failed records report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const mergeReportPath = join(REPORTS_DIR, `dedup-merge-report-${ts}.json`);
  writeFileSync(mergeReportPath, JSON.stringify({
    generatedAt:    new Date().toISOString(),
    totalPairs:     pairs.length,
    merged:         mergedCount,
    failed:         failedCount,
    skipped:        report.manualReviewPairs,
    failedRecords,
  }, null, 2));

  console.log('\n\n  ── Merge Complete ────────────────────────────────────');
  console.log(`  Merged  : ${mergedCount.toLocaleString()}`);
  console.log(`  Failed  : ${failedCount.toLocaleString()}`);
  console.log(`  Skipped : ${report.manualReviewPairs.toLocaleString()} manual-review pairs`);
  console.log('            → see data/reports/dedup-manual-review.csv for client review');
  console.log(`\n  Report saved to: ${mergeReportPath}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const client = axios.create({
    baseURL: config.hubspot.baseUrl,
    headers: {
      Authorization: `Bearer ${config.hubspot.apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (PULL) {
    await pullContacts(client);
    const { autoMerge, manualReview } = await findDuplicatePairs();
    writePairsReport({ autoMerge, manualReview });
  } else if (ANALYZE) {
    // Re-run analysis on already-pulled data — no API calls needed
    if (!existsSync(CONTACTS_NDJSON)) {
      console.error('No local contacts data found. Run npm run dedup:pull first.');
      process.exit(1);
    }
    const { autoMerge, manualReview } = await findDuplicatePairs();
    writePairsReport({ autoMerge, manualReview });
  } else if (MERGE || DRY_RUN) {
    await mergeDuplicates(client, DRY_RUN);
  } else {
    console.log('\nUsage:');
    console.log('  npm run dedup:pull      pull contacts & identify duplicate pairs');
    console.log('  npm run dedup:analyze   re-run analysis on already-pulled data (no API call)');
    console.log('  npm run dedup:dry-run   preview merges without touching HubSpot');
    console.log('  npm run dedup:merge     execute auto-merge pairs');
  }
}

main().catch(err => {
  logger.error('dedup-hubspot failed', { error: err.message });
  console.error('\nFatal:', err.message);
  process.exit(1);
});
