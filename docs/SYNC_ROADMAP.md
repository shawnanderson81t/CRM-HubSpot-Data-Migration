# GoHighLevel → HubSpot Daily Sync — Implementation Roadmap

**Prepared by:** Shawn Anderson
**Date:** June 4, 2026
**Status:** Planning — for client review

---

## Executive Summary

The one-time migration moved 910,784 contacts from GoHighLevel (Engager) into HubSpot. That job
is done. But Engager keeps changing every day — new registrations, new buyers, updated tags,
moved opportunity stages — and none of that is reaching HubSpot anymore. The gap has been growing
since the migration snapshot of May 20.

This roadmap converts the migration engine we already built into an **automated daily sync** that
runs every night at 2:00 AM MST. Each run pulls only what changed in Engager since the previous
run and applies it to HubSpot, with three guarantees the team cares about:

1. **It never clobbers your team's work.** If someone edits a contact by hand in HubSpot, the sync
   leaves that edit alone. GHL wins on brand-new contacts and brand-new activity; HubSpot wins on
   anything your team has touched.
2. **It never wipes data with blanks.** A missing value in GHL never overwrites a real value in
   HubSpot. (This rule is already enforced in the existing code.)
3. **It tells you what it did.** Every morning you get an email summarizing what synced, what
   failed, and anything that needs a human — plus a structured log file you and the project owner
   can open at any time.

**The good news on cost:** roughly 70–80% of what this needs already exists and has been proven at
910K-contact scale — the GHL client, the HubSpot client, the field mapper, the deduplication, the
retry/backoff, and the resume-on-failure checkpointing. The genuinely new work is the "what changed
since yesterday" detection, the conflict-resolution rules, the scheduler, and the daily email.

**Honest scope note:** syncing **contact fields** (tags, geolocation, UTM, custom fields) is the
reuse-heavy part. Syncing **opportunity/deal stages and activity notes** is essentially new
construction — the migration never touched deals or notes. I've separated those into their own
phase so the cost driver is visible and you can decide whether to include them now or as a
follow-on.

**Estimated effort:** 10–12 working days for the contact sync core; 13–16 days if opportunity
stages and activity notes are included.

---

## Part 1 — Current State: What Exists Today

### Entry points
| Script | Role |
|---|---|
| `scripts/migrate-tier.js` | Main runner. Loads a tier's contact file and drives the upsert. Tier 3 streams a 3.4GB file line-by-line to avoid running out of memory. |
| `scripts/extract-*.js` | Three tier-specific extractors (pipeline query, date-range search, cursor pagination). |
| `scripts/dedup-hubspot.js` | Standalone deduplication: pull → analyze → dry-run → merge, with its own checkpoint. |
| `scripts/migration-report.js` | Reads a checkpoint and prints/saves a run summary. |
| `scripts/build-owner-map.js` | Matches GHL users to HubSpot owners by email. |

### The ETL flow as it runs today
```
  GHL API  ──extract──▶  data/*.json (or NDJSON on disk)
                              │
                              ▼
   Transform:  cleaner.js  →  fieldMapper.js  →  geoResolver.js
   (sanitize)     (GHL fields → HubSpot props)   (event tag → market_city)
                              │
                              ▼
   Load (BatchUpserter):
     • batchReadContacts ×4 in parallel (email / phone / hs_object_id / engager_contact_id)
     • deduplicateBatch → { updates, inserts, unresolvable }
     • batchUpdateContacts  (existing records — identity fields stripped to avoid conflicts)
     • batchCreateContacts  (new records — one-by-one fallback on 400/409)
                              │
                              ▼
   checkpoint.js  →  per-run JSON state (resume-safe)
   logger.js      →  logs/combined.log + logs/error.log
```

### What's already solid (verified in code)
- **GHL client** (`src/extract/ghlClient.js`): cursor pagination (`getContacts`), single fetch
  (`getContact`), tags, custom fields, opportunities, pipeline stages. Retry on 429 + network
  errors, respects `Retry-After`, 5 attempts.
- **HubSpot client** (`src/load/hubspotClient.js`): batch update/create/read, contact-to-contact
  associations (`createAssociation`, v4 — already supports the `guest_of` link), owners, property
  creation. Exponential backoff on 429/5xx. Sophisticated 400/409 fallbacks (per-record retry,
  `INVALID_OPTION` field stripping, uniqueness-conflict recovery).
- **Deduplication** (`src/transform/deduplicator.js`): match chain is **HS contact ID → email →
  phone** — already exactly the email-primary / phone-secondary rule the sync requires.
- **Null-safety**: the mapper builds properties with a `setIfPresent` pattern and the upserter
  strips identity fields from updates — blank GHL values are not written over existing HubSpot data.
- **Checkpointing** (`src/load/checkpoint.js`): per-run JSON with `lastBatch`, `updated`,
  `inserted`, `failed`, `skipped`, `failedRecords[]`. Any interrupted run resumes from the last
  completed batch.
- **Logging**: structured Winston output to file.

### What does NOT exist yet
- No scheduler — every run is launched by hand.
- No delta detection — extraction always walks the **whole** dataset.
- No conflict-resolution logic — today HubSpot is protected only passively (blanks/identity fields
  aren't written); there's no rule that says "don't touch a field a human edited."
- No daily summary email and no failure alert.
- No opportunity/deal-stage sync and no activity-note sync — the migration was contacts-only.

---

## Part 2 — Gap Analysis: Migration → Daily Sync

| Capability | Today | Needed for sync | Build size |
|---|---|---|---|
| Trigger | Manual | Cron, 2:00 AM MST | Small |
| Data scope | Entire dataset | Only contacts changed since last run | **Medium — key risk** |
| Dedup (email→phone) | ✅ Done | Same | None |
| Never overwrite with blanks | ✅ Done | Same | None |
| Conflict resolution | Passive only | Explicit HubSpot-wins-on-manual-edit | Medium |
| Idempotency | Per-batch resume | Full re-run safety | Small |
| Retry / backoff | ✅ Done | Same | None |
| Structured logging | ✅ Done | Same + retention | None |
| Daily summary email | ❌ | Email at end of run | Small |
| Failure alert | ❌ | Email on crash / high failure rate | Small |
| Tag sync | ✅ (via field mapper) | Same | None |
| Geolocation sync | ✅ (geoResolver) | Same | None |
| UTM field sync | ✅ (mapped to utm_source/medium) | Same | None |
| Contact associations | ✅ (guest_of supported) | Re-validate on sync | Small |
| Opportunity stage sync | ❌ | New — deals were never migrated | **Large** |
| Activity note sync | ❌ | New — engagements never built | **Large** |

### The four gaps that actually require thought

**1. "What changed since last run?" (delta detection) — the critical unknown**
The contacts list endpoint we use today (`/contacts/` with `startAfterId`) has no date filter. The
date-filtered path is `POST /contacts/search`, which we already proved during Tier 2 using a
**`dateAdded` range** filter (`{ field, operator: 'range', value: { gte, lte } }`). For a sync we
need **`dateUpdated`** (modification time), not `dateAdded` (creation time) — otherwise we'd miss
contacts that were edited but not newly created. **Whether GHL's search supports filtering on a
modification timestamp is the single most important thing to confirm before building.** Mitigations
exist either way (see Risks), but this drives the Phase 2 estimate.

**2. Conflict resolution — "did a human edit this in HubSpot?"**
HubSpot records the *source* of every property write (`CRM_UI`, `API`, `IMPORT`, …) in its property
history. Two ways to honor "HubSpot wins on manual edits":
- **Field-ownership allowlist (recommended for v1):** define which fields are GHL-owned (tags,
  geolocation, UTM, event/buyer custom fields) vs HubSpot-owned (anything the sales team edits by
  hand). The sync only ever writes GHL-owned fields. Simple, fast, no extra API calls, and it
  builds naturally on the existing upserter, which already refuses to overwrite identity fields.
- **Property-history check (v2, if needed):** for contested fields, call HubSpot's property history
  and skip any field whose last write came from `CRM_UI`. More precise, but a per-contact call —
  only worth it for a small set of fields.

**3. Scheduling + idempotency**
A `node-cron` job on a server that's always on, plus a PID/lock file so two runs never overlap, plus
a `sync-state.json` that records `lastSyncAt` only after a clean finish (so a failed run re-pulls the
same window tomorrow rather than skipping it).

**4. Daily summary email + alert**
A small mailer (nodemailer or a transactional service) that sends the end-of-run summary, and an
immediate alert if the run crashes or the failure rate crosses a threshold.

---

## Part 3 — Phased Plan

> Estimates are working days. Items marked **(client)** are decisions/access I need from your side,
> not build time.

### Phase 0 — Decisions & Access — 0.5 day (mostly client)
- Confirm GHL search supports a **modification-date** filter (or agree on the fallback).
- Confirm the **field-ownership list**: which HubSpot fields are sales-team-owned and off-limits.
- Confirm **where the cron runs** (the existing US remote machine is the natural home).
- Confirm whether the Engager→HubSpot reverse routing (`hs-to-hl` tag) is still active.
- **Deliverable:** a one-page decisions sheet that unblocks the build.

### Phase 1 — Backfill (close the May 20 gap) — 1.5 days
- Run the existing pipeline over everything created/updated in GHL since May 20.
- Reconcile HubSpot counts before/after; write the first `sync-state.json` baseline.
- **Deliverable:** HubSpot current as of go-live; baseline state file; backfill report.

### Phase 2 — Delta Extraction Engine — 2.5 days *(carries the main risk)*
- Add `getContactsChangedSince(date)` to the GHL client (search API + monthly/daily chunking, reusing
  the Tier 2 chunking approach to stay under GHL's 10K-per-query cap).
- New `scripts/sync-extract.js` writes the day's delta to an NDJSON checkpoint.
- `lastSyncAt` advances only on success; failed windows are retried next run.
- **Deliverable:** incremental extractor that pulls only what changed.

### Phase 3 — Conflict Resolution — 2 days
- New `src/transform/conflictResolver.js` implementing the field-ownership allowlist (v1).
- Hook it into `batchUpserter` just before update payloads are built.
- Optional property-history check wired behind a config flag for a small set of contested fields.
- **Deliverable:** HubSpot manual edits provably protected (verified by test in Phase 6).

### Phase 4 — Scheduler & Idempotency — 2 days
- New `scripts/sync-runner.js` orchestrator: extract → transform → upsert → report.
- `node-cron` at `0 9 * * *` UTC (= 2:00 AM MST); PID lock prevents overlap.
- `sync-state.json` for `lastSyncAt` + run history; full re-run safety.
- **Deliverable:** hands-off nightly run with overlap protection.

### Phase 5 — Logging, Summary Email & Alerts — 1.5 days
- New `src/utils/mailer.js`: end-of-run HTML summary (synced / created / updated / failed / skipped /
  duration) + immediate alert on crash or failure-rate breach. Recipients via `.env`.
- Confirm log file location/retention is accessible to you and the project owner.
- **Deliverable:** a sample summary email sent to you and Alex for sign-off.

### Phase 6 — Dry-Run, Validation & Go-Live — 2 days
- Run 3 nights in **dry-run** (log what *would* change, touch nothing).
- Daily GHL-vs-HubSpot count reconciliation; 50-contact field spot-check.
- Conflict test: hand-edit a HubSpot field, confirm the sync leaves it alone.
- First live run, monitored; handoff doc for Andy and the team.
- **Deliverable:** verified, production-ready nightly sync.

### Phase 7 *(optional)* — Opportunity Stages + Activity Notes — 3–4 days
- **New build** (deals/engagements were never in migration scope): map GHL opportunity stages →
  HubSpot deal stages; map GHL activity notes → HubSpot engagement notes; re-validate associations.
- Recommend delivering Phases 1–6 first and treating this as a fast follow-on once the contact sync
  is stable.
- **Deliverable:** deal-stage and note sync layered onto the nightly run.

---

## Part 4 — Reusable vs. Net-New

### Reuse as-is (no changes)
`fieldMapper.js` · `cleaner.js` · `geoResolver.js` · `deduplicator.js` · `hubspotClient.js`
(incl. associations) · `logger.js` · retry/backoff in both clients · `config.js`

### Reuse with a small addition
`ghlClient.js` — add `getContactsChangedSince(date)` · `batchUpserter.js` — add a conflict-resolution
hook · `checkpoint.js` — extend for sync state

### Net-new
`scripts/sync-extract.js` · `scripts/sync-runner.js` (cron + lock) ·
`src/transform/conflictResolver.js` · `src/utils/mailer.js` · `data/sync-state.json` ·
*(Phase 7)* deal-stage + note sync modules

---

## Part 5 — Risks & Open Questions

| # | Risk / Question | Impact | Mitigation |
|---|---|---|---|
| 1 | **Does GHL search filter on modification date** (not just creation date)? | High — defines delta detection | If no: pull by `dateAdded` for new contacts, plus a rolling N-day re-scan window for edits; or use GHL webhooks if available. |
| 2 | **Which HubSpot fields are sales-team-owned?** | High — drives conflict rules | Phase 0 decisions sheet with Andy. Default: only GHL-owned fields are ever written. |
| 3 | **Where does the cron run?** | Medium — hosting/setup | Existing US remote machine if it stays on 24/7; otherwise a small VPS/cloud function (adds setup + hosting cost). |
| 4 | **Is the `hs-to-hl` reverse sync still active?** | Medium — loop risk | Filter out `hs-to-hl` / `hs-transfer` tagged contacts (same guard already used in the Tier 3 extractor). |
| 5 | **Opportunity/note sync is new construction** | Medium — cost driver | Keep in optional Phase 7; deliver contact sync first. |
| 6 | High-activity days exceeding GHL's 10K/query cap | Low | Daily window already small; split into hourly chunks if needed (chunking already proven in Tier 2). |

---

## Timeline at a Glance

| Phase | Scope | Days | Cumulative |
|---|---|---|---|
| 0 | Decisions & access | 0.5 | 0.5 |
| 1 | Backfill | 1.5 | 2 |
| 2 | Delta extraction | 2.5 | 4.5 |
| 3 | Conflict resolution | 2 | 6.5 |
| 4 | Scheduler & idempotency | 2 | 8.5 |
| 5 | Logging, email, alerts | 1.5 | 10 |
| 6 | Dry-run, validation, go-live | 2 | 12 |
| 7 | *(optional)* opportunity + notes | 3–4 | 15–16 |

**Contact sync core: ~10–12 days. With opportunity stages + activity notes: ~13–16 days.**

---

*Prepared by Shawn Anderson · shawnanderson81work@outlook.com*
