# GHL → HubSpot Daily Sync — Project Roadmap

**Prepared by:** Shawn Anderson
**Date:** June 4, 2026
**Version:** 1.0

---

## Executive Summary

The one-time data migration from GoHighLevel (Engager) to HubSpot is complete — 910,784 contacts
successfully transferred. However, new contacts and updates entering GoHighLevel daily are not
reflected in HubSpot, and this gap compounds every day.

This roadmap covers converting the existing migration pipeline into a **fully automated daily sync**
that runs at 2:00 AM MST, pulls only what changed in GHL since the previous run, and pushes it
into HubSpot — creating new contacts and enriching existing ones, without ever overwriting data
your team has manually updated in HubSpot.

**Estimated total effort:** 12 working days
**Recommended start:** Immediately
**Risk level:** Low — approximately 80% of the required components already exist and are
battle-tested on 910K contacts.

---

## Part 1 — Current State: What the Migration Does Today

### Entry Points
| Script | Purpose |
|---|---|
| `scripts/migrate-tier.js` | Main execution — loads contacts file, runs BatchUpserter |
| `scripts/extract-workshop-buyers.js` | Pulls Tier 1 from GHL pipeline opportunities |
| `scripts/extract-preview-buyers.js` | Pulls Tier 2 via monthly date-range search chunks |
| `scripts/extract-registrants.js` | Pulls Tier 3 via cursor pagination |
| `scripts/dedup-hubspot.js` | Standalone dedup: pull → analyze → dry-run → merge |

### ETL Flow (Current)

```
GHL API (read)
    ↓
Extract — cursor pagination / search API / pipeline query
    ↓  [writes to data/*.json or NDJSON on disk]
Transform
  ├── cleaner.js        — strips placeholders, normalises email/phone, HTML sanitise
  ├── fieldMapper.js    — maps ~40 GHL fields + custom field IDs → HubSpot properties
  ├── geoResolver.js    — event tags (YYYYMMDD_CITYCODE) → market_city values
  └── deduplicator.js   — match chain: HS contact ID → email → phone
    ↓
Load — BatchUpserter
  ├── batchReadContacts  — look up existing HS records (email / phone / HS ID / GHL ID)
  ├── batchUpdateContacts — update matched records (strips identity fields to avoid conflicts)
  └── batchCreateContacts — insert net-new records (with one-by-one fallback on 400)
    ↓
checkpoint.js — JSON state file per tier (resume-safe on failure)
```

### Rate-Limit & Retry Handling
- **GHL client** (`ghlClient.js`): retry on 429 + SSL/network errors, respects `Retry-After` header,
  exponential backoff up to 5 attempts
- **HubSpot client** (`hubspotClient.js`): same pattern, up to 5 retries, handles `INVALID_OPTION`
  by stripping the offending field and retrying the batch
- **Dedup script**: `withRetry()` covers 429, 502, 503, 504

### Checkpointing
`checkpoint.js` writes a JSON file after every batch with: `lastBatch`, `succeeded`, `updated`,
`inserted`, `failed`, `skipped`, `failedRecords[]`. Any interrupted run resumes from the last
completed batch — no re-processing of already-handled contacts.

### Logging
Winston logger writes structured JSON to `./logs/combined.log` and `./logs/error.log`.
Every batch logs: contacts processed / updated / inserted / failed / skipped with reasons.

### What Is NOT Currently Supported
- No scheduler — runs are triggered manually
- No delta detection — always processes the full dataset
- No conflict resolution — HubSpot vs GHL field ownership not tracked
- No summary email at end of run
- No structured alert on failure

---

## Part 2 — Gap Analysis: One-Time Migration → Daily Sync

| Capability | Migration (today) | Daily Sync (needed) |
|---|---|---|
| Trigger | Manual | Cron — 2:00 AM MST daily |
| Data scope | Full dataset each run | Delta only — contacts changed since last sync |
| GHL extraction | Cursor / pipeline / search | Search API with `dateUpdated` filter |
| Conflict resolution | None (HubSpot wins by default via non-overwrite) | Explicit: HubSpot wins on manual edits, GHL wins on new activity |
| Deduplication | Email → phone → HS ID match chain | Same — already correct |
| Null handling | Never overwrite with blank | Same — already enforced |
| Idempotency | Partial (checkpoint per batch) | Full — safe to re-run any day's sync |
| Logging | File-based structured logs | Same + daily summary report |
| Alerting | None | Email summary at end of run |
| Scheduling | None | Node-cron or system cron (server) |

### Key Gaps to Close

**1. Delta Detection — "Changed since last run"**
The GHL Search API supports a `dateUpdated` range filter. The sync will store a `lastSyncAt`
timestamp after each successful run and query GHL for contacts where `dateUpdated >= lastSyncAt`.
This is the most critical new component.

**2. Conflict Resolution**
HubSpot tracks property change history including the source of each write. The plan:
- Fields updated by a HubSpot user (source = `CRM_UI`) → HubSpot wins, do not overwrite
- Fields that are blank in HubSpot or last written by our pipeline (source = `API`) → GHL wins
- New contacts in GHL with no HubSpot record → always create
- New activity (tags added, stage changes) → always sync regardless of source

**3. Scheduler**
A `node-cron` job running on the same remote server used for the migration. Triggers the sync
engine at 2:00 AM MST daily and writes a PID lock file to prevent overlapping runs.

**4. Summary Email**
At the end of each run, send a structured email (via nodemailer or a transactional service like
SendGrid) reporting: contacts synced, created, updated, failed, skipped, and any errors
requiring attention.

**5. Opportunity / Activity Sync (new scope)**
The migration covered contacts only. The daily sync will also need to handle:
- GHL opportunity stage changes → HubSpot deal stage updates
- Activity notes from GHL → HubSpot engagement notes
- UTM fields from new registrations → HubSpot contact properties

---

## Part 3 — Phased Roadmap

### Phase 1 — Backfill & Foundation (Days 1–2)
**Goal:** Close the May 20 → today gap and set up the sync state baseline.

**Tasks:**
- Run a one-time backfill pulling all GHL contacts updated since May 20
- Verify HubSpot contact counts before and after
- Write `lastSyncAt` state file with today's timestamp as the sync baseline

**Deliverables:**
- HubSpot fully current as of go-live date
- `data/sync-state.json` — baseline sync state file
- Backfill report (contacts created / updated / failed)

**Effort:** 2 days

---

### Phase 2 — Delta Extraction Engine (Days 3–4)
**Goal:** Replace full-dataset extraction with incremental "changed since last run" pulling.

**Tasks:**
- Build `scripts/sync-extract.js` — queries GHL Search API with `dateUpdated >= lastSyncAt`
- Handle GHL's 10K-per-query cap via monthly date-range chunking (already proven in Tier 2)
- Write delta contacts to NDJSON checkpoint file
- Update `lastSyncAt` only after successful run completion

**Deliverables:**
- `scripts/sync-extract.js` — incremental GHL extractor
- Handles partial failures — retries failed windows on next run

**Effort:** 2 days

---

### Phase 3 — Conflict Resolution Layer (Days 5–6)
**Goal:** Implement HubSpot-wins / GHL-wins rules before any field is written.

**Tasks:**
- For each contact being updated: fetch HubSpot property history for key fields
  (`GET /crm/v3/objects/contacts/{id}/property-history?properties=email,phone,...`)
- If last write source is `CRM_UI` → skip that field (HubSpot team updated it manually)
- If last write source is `API` or field is blank → allow GHL value through
- Extend `batchUpserter.js` with a `resolveConflicts(ghlProps, hsContact)` step

**Deliverables:**
- `src/transform/conflictResolver.js` — new module
- Updated `batchUpserter.js` with conflict resolution step

**Effort:** 2 days

---

### Phase 4 — Scheduler & Idempotency (Days 7–8)
**Goal:** Automated daily trigger with overlap protection and full idempotency.

**Tasks:**
- Build `scripts/sync-runner.js` — the main sync orchestrator
- Integrate `node-cron` for 2:00 AM MST scheduling (`0 9 * * *` UTC)
- PID lock file — prevents a second run starting if previous run is still active
- On completion: write `lastSyncAt`, clear PID lock
- On failure: write error to log, send alert, preserve `lastSyncAt` (re-run next day picks up same window)

**Deliverables:**
- `scripts/sync-runner.js` — orchestrator
- Cron setup instructions for remote server
- Idempotency verified: re-running same day's sync produces identical HubSpot state

**Effort:** 2 days

---

### Phase 5 — Summary Email & Alerting (Days 9–10)
**Goal:** Daily visibility into sync health without manual log checking.

**Tasks:**
- Build `src/utils/mailer.js` — sends structured HTML email via nodemailer / SendGrid
- End-of-run summary: contacts synced, created, updated, failed, skipped, run duration
- On-failure alert: immediate email if run crashes or failure rate exceeds threshold (e.g. >5%)
- Email recipients configurable via `.env`

**Deliverables:**
- `src/utils/mailer.js`
- Daily summary email template
- Failure alert email template
- Sample report emailed to Shawn + Alex for sign-off

**Effort:** 2 days

---

### Phase 6 — Testing, Validation & Go-Live (Days 11–12)
**Goal:** Confirm the sync is correct and production-ready before handing off.

**Tasks:**
- Run sync in dry-run mode for 3 consecutive days — log what would change without touching HubSpot
- Compare GHL contact counts vs HubSpot contact counts daily
- Validate a sample of 50 contacts: GHL values match HubSpot values for all synced fields
- Confirm conflict resolution working: manually update a HubSpot field, verify sync does not overwrite it
- First live run — monitor in real time
- Handoff documentation

**Deliverables:**
- 3-day dry-run log showing sync is healthy
- Validation report (50 contact spot-check)
- Handoff doc for Andy and the internal team
- First successful live run confirmed

**Effort:** 2 days

---

## Part 4 — Reusable vs. Net-New Components

### Reusable As-Is
| Component | File | Notes |
|---|---|---|
| GHL API client | `src/extract/ghlClient.js` | Add one method: `getContactsSince(date)` |
| HubSpot API client | `src/load/hubspotClient.js` | No changes needed |
| Field mapper | `src/transform/fieldMapper.js` | No changes needed |
| Data cleaner | `src/transform/cleaner.js` | No changes needed |
| Geo resolver | `src/transform/geoResolver.js` | No changes needed |
| Deduplicator | `src/transform/deduplicator.js` | No changes needed |
| Batch upserter | `src/load/batchUpserter.js` | Add conflict resolution hook |
| Checkpoint system | `src/load/checkpoint.js` | Extend for sync state |
| Logger | `src/utils/logger.js` | No changes needed |
| Rate limit / retry | Both clients | No changes needed |

### Net-New Components
| Component | File | Purpose |
|---|---|---|
| Sync extractor | `scripts/sync-extract.js` | Delta pull from GHL since lastSyncAt |
| Sync runner | `scripts/sync-runner.js` | Orchestrator + cron + PID lock |
| Conflict resolver | `src/transform/conflictResolver.js` | HubSpot vs GHL field ownership |
| Mailer | `src/utils/mailer.js` | Daily summary + failure alerts |
| Sync state | `data/sync-state.json` | Stores lastSyncAt + run history |

---

## Part 5 — Key Technical Risks & Open Questions

### Risk 1 — Detecting Manually-Updated HubSpot Fields
**Problem:** HubSpot's property history API (`GET /crm/v3/objects/contacts/{id}/property-history`)
returns the source of each write but is a per-contact call — expensive at scale.

**Options:**
- Fetch property history only for fields where GHL value differs from current HubSpot value
  (reduces calls dramatically)
- Maintain a list of "HubSpot-owned" fields that the sync never touches regardless of source
  (simpler, less API-intensive — recommended for initial version)

**Resolution needed:** Confirm with Andy which fields are "HubSpot-owned" (managed by the sales
team in the UI) vs "GHL-owned" (always sourced from Engager).

---

### Risk 2 — GHL Delta Query Reliability
**Problem:** GHL's `dateUpdated` filter on the Search API caps at 10K results per query window.
For days with high contact activity (post-event), a single day's window could exceed 10K.

**Mitigation:** Already solved during Tier 2 — monthly chunking strategy can be applied to
daily windows by splitting into hour-level chunks if needed. Low risk.

---

### Risk 3 — Where the Cron Runs
**Problem:** The sync must run on a server that stays on 24/7 and has access to both GHL and
HubSpot APIs. The current remote machine used for the migration is a candidate.

**Resolution needed:** Confirm with Alex/Andy whether the migration server stays available
long-term, or whether a cloud deployment (AWS Lambda, a small VPS, or Railway) is preferred.
This affects setup time and ongoing hosting cost.

---

### Risk 4 — Opportunity / Activity Sync Scope
**Problem:** GHL opportunity stages and activity notes were not in the original migration scope.
Including them in the daily sync adds complexity and effort.

**Recommendation:** Deliver contact sync first (Phases 1–6 above), then scope opportunity and
note sync as a follow-on engagement once the contact pipeline is stable.

---

### Risk 5 — GHL Active Sync (hs-to-hl)
**Problem:** As of May 2026, the client's team was actively routing new HubSpot contacts back
into GHL (`hs-to-hl` tag). If this is still running, there is a risk of circular sync loops
(GHL → HubSpot → GHL → HubSpot).

**Resolution needed:** Confirm with Andy whether the `hs-to-hl` reverse sync is still active.
If so, the daily sync must filter out contacts tagged `hs-to-hl` or `hs-transfer` (already
done in the Tier 3 extractor — same logic applies here).

---

## Summary Timeline

| Phase | Description | Days | Cumulative |
|---|---|---|---|
| 1 | Backfill + baseline | 2 | Day 2 |
| 2 | Delta extraction engine | 2 | Day 4 |
| 3 | Conflict resolution | 2 | Day 6 |
| 4 | Scheduler + idempotency | 2 | Day 8 |
| 5 | Summary email + alerting | 2 | Day 10 |
| 6 | Testing + go-live | 2 | Day 12 |

**Total: 12 working days from project start.**

---

*Prepared by Shawn Anderson | shawnanderson81work@outlook.com*
