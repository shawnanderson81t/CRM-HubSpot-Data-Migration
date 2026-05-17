# CRM Migration Project — Claude Working Brief

## ROLE
You are my senior engineering partner on a CRM data migration project. I'm a developer (Node.js, Express, JavaScript) building an ETL pipeline to migrate ~850,000 contacts from GoHighLevel (GHL) to HubSpot. Deadline: **May 30, 2026**. I'm working solo.

## PROJECT CONTEXT
- **Client**: Education company with event-based sales funnels (workshops, previews, masterclasses)
- **Problem**: They migrated from GHL to HubSpot but historical data is broken — missing fields, no market/city attribution, broken associations, lost payment records
- **My job**: Build a Node.js ETL pipeline that extracts from GHL, transforms/cleans, and loads into HubSpot in tiered batches
- **Lead dev on client side**: Andy (has existing partial scripts from past 5 months — did NOT share his prior work → we are doing everything from scratch: audit, architecture, code, reporting)

## STAKEHOLDER HIERARCHY
Project triangle from top to bottom — always be aware of who is talking to whom:

```
Brandon, Eddie, Jai, James    ← THE CLIENT (top — they're paying, they're anxious)
         │
        Andy                  ← Lead Dev (hired by client, been on project 5 months, did not share work)
         │
        Alex                  ← PM / Company Owner (hired by client, manages project delivery)
         │
       Shawn (Michael)        ← Hired by Alex (Michael plays the role of Shawn externally)
         │
     Mounaim (me)             ← Developer, hired by Michael — bottom of the triangle, doing all the work
```

**Key communication rules:**
- Reports and replies go UP the chain: Mounaim → Michael (as Shawn) → Alex → Andy/Client
- **Alex** is who sends messages like "Hi Shawn..." — NOT Andy. Andy is a peer/lead dev, not a manager.
- Brandon, Eddie, Jai, James are the ultimate stakeholders. They care about data quality, lead disposition, rep assignment, and speed.
- Always use "I" (not "we/us") in all outward-facing reports and messages.
- Michael is worried that Brandon/Eddie/Jai/James are anxious — include them in every report going forward.

## MIGRATION TIERS (execution order)
| Our Tier | Client Calls It | Segment | Count | Priority | Original Timeline | Accelerated Target |
|----------|----------------|---------|-------|----------|-------------------|--------------------|
| Tier 1 | "3rd Tier" / Advanced | Workshop Buyers | ~10,000 | Highest | May 11–15 | May 16–17 (weekend) |
| Tier 2 | "2nd Tier" | Preview Buyers | ~30,000 | Second | May 18–22 | May 18–19 |
| Tier 3 | "1st Tier" | General Registrants | ~800,000 | Last | May 25–29 | May 20–21 (overnight) |

> **NAMING ALERT**: Client and Michael refer to tiers in reverse order (their "3rd Tier" = our Tier 1). Always confirm which numbering system is being used in conversations. Aligned terminology confirmed May 3, 2026.

> **BONUS OPPORTUNITY**: Client (via Alex, May 14) offered a bonus for early delivery. Target completion: **May 22–23** (7 days ahead of May 30 deadline). Mounaim and Michael to align on bonus split before delivery.

## HUBSPOT CUSTOM PROPERTIES TO CREATE
Updated May 5, 2026 after Day 2 discovery. HubSpot portal confirmed 0 custom properties — all must be created via Properties API before any import.

| # | Internal Name | Label | Type | Options / Notes |
|---|---|---|---|---|
| 1 | `ghl_contact_id` | GHL Contact ID | text | Preserve GHL ID for rollback + reconciliation |
| 2 | `buyer_tier` | Buyer Tier | dropdown | Workshop Buyer, Workshop Buyer - Diamond, Preview Buyer, Preview Registrant, Preview Attendee, Preview Non-Attendee, Telesales Buyer, Telesales Diamond, Registrant |
| 3 | `market_city` | Market City | dropdown | Honolulu, Pittsburgh, Norfolk, Detroit, New York, Los Angeles, Fresno, San Antonio, Austin, Columbia, Philadelphia, Cleveland, Indianapolis, Santa Barbara, San Diego, Lubbock, Concord, Chicago, Phoenix + others |
| 4 | `event_type` | Event Type | dropdown | Workshop, Preview, Masterclass, Commercial, Expo, Fly Out, Foundations |
| 5 | `attendance_status` | Attendance Status | dropdown | Registered, Attended, Non-Attendee, Guest, Cancelled |
| 6 | `registration_source` | Registration Source | text | From `attributions[0].utmSessionSource` |
| 7 | `registration_medium` | Registration Medium | text | From `attributions[0].medium` (facebook, zapier, form, survey) |
| 8 | `payment_status` | Payment Status | dropdown | Paid, Pending, Refunded, Failed |
| 9 | `payment_balance` | Payment Balance | number | From GHL `workshop_payment_balance` |
| 10 | `community_join_date` | Community Join Date | date | From GHL custom field — Unix ms → ISO date |
| 11 | `sms_engagement_score` | SMS Engagement Score | number | From GHL `sms_engmt_score` |
| 12 | `email_engagement_score` | Email Engagement Score | number | From GHL `email_engmt_score` |
| 13 | `cancellation_status` | Cancellation Status | dropdown | Workshop Cancelled, Foundations Cancelled, All Cancelled |
| 14 | `fulfillment_status` | Fulfillment Status | dropdown | Coaching Purchased, Coaching Active, Community Active, Portal Active, Marketplace Active, Subscribed |

**Association type** (separate from properties):
- `guest_of` — contact-to-contact association linking guest record to primary attendee

## ETL PIPELINE ARCHITECTURE
```
src/
├── extract/          # Pull data from GHL (API or CSV)
│   ├── ghlClient.js  # GHL REST API wrapper
│   └── csvParser.js  # Fallback CSV extraction
├── transform/        # Clean, map, deduplicate
│   ├── fieldMapper.js # GHL field → HubSpot property mapping
│   ├── cleaner.js     # Email validation, phone normalization, encoding fixes
│   ├── deduplicator.js# Duplicate detection by email + phone
│   └── geoResolver.js # GHL geolocation tags → market_city values
├── load/             # Push to HubSpot
│   ├── hubspotClient.js # HubSpot API v3 wrapper
│   ├── batchUpserter.js # Batch upsert with rate limiting
│   └── checkpoint.js    # Track progress for resume-on-failure
├── associations/     # Handle guest_of links
│   ├── associationBuilder.js # Build association map
│   └── associationLoader.js  # Push associations to HubSpot
├── validation/       # Post-migration QA
│   ├── diffChecker.js   # Compare source vs destination records
│   ├── countReconciler.js # Verify total counts ±0.1%
│   └── dupScanner.js     # Find post-migration duplicates
└── utils/
    ├── logger.js      # Winston or custom logger
    ├── rateLimiter.js  # Token bucket for API rate limiting
    └── config.js       # Environment config loader
```

## GHL API — CONFIRMED DETAILS (updated May 5, 2026)
- **Base URL**: `https://services.leadconnectorhq.com/`
- **Auth**: GHL Private Integration Token used directly as Bearer — `GHL_API_KEY` in `.env`
- **Version header**: `Version: 2021-07-28` — required on every request
- **Single contact**: `GET /contacts/{contactId}`
- **List contacts**: `GET /contacts/` — cursor-based pagination via `startAfterId`, max 100/page
- **Custom fields**: `GET /locations/{locationId}/customFields`
- **Tags**: `GET /locations/{locationId}/tags`
- **Pipelines**: `GET /opportunities/pipelines?locationId={id}`
- **Opportunities**: `GET /opportunities/search?location_id={id}`
- **Total contacts**: 897,917 (confirmed May 5, 2026 via pagination meta)
- **Total opportunities**: 798,008 (confirmed May 5, 2026)
- **Env vars needed**: `GHL_API_KEY`, `GHL_LOCATION_ID`, `HUBSPOT_API_KEY`

## TECHNICAL CONSTRAINTS
- **HubSpot API**: Contacts API v3, batch upsert endpoint (100 contacts/request)
- **HubSpot Portal Tier**: Enterprise (confirmed May 3, 2026) — higher rate limits apply
- **HubSpot Sandbox**: Two sandbox accounts exist — use ONLY Andy's original/legacy sandbox (created Oct 2025). The other sandbox "TLC Leads Backup" must NOT be written to (Andy's instruction, May 13). Legacy sandbox schema is NOT aligned with PROD — has not been synced. Must pull sandbox schema + run `create-hubspot-properties.js` against it before Day 10 pilot.
- **HubSpot Access Level**: Full Super Admin write permissions confirmed — needed for properties, batch upserts, associations
- **Rate limits**: Enterprise tier limits (higher than free) — verify exact limits on access
- **Null handling**: NEVER overwrite existing HubSpot data with blanks from GHL
- **Dedup logic**: Match on email OR phone — if match found, UPDATE not INSERT
- **Checkpointing**: Every batch writes state to a JSON file so we can resume from failure
- **Logging**: Every batch logs: contacts processed / succeeded / failed / skipped with reasons

## HISTORICAL DATA TO PRESERVE
- Activity logs & notes → HubSpot Engagements API
- File attachments → HubSpot Files API + engagement associations
- Payment records & payment method → custom properties
- Event registration origin (auto vs manual) → attendance_origin property
- Guest contact relationships → custom association type
- Deal stage history → Deals API with stage timestamps
- Conversations → HubSpot Conversations API (limited — flag feasibility)

## WHAT I NEED FROM YOU
1. **Help me write each module** — when I say "let's build fieldMapper.js", write production-ready Node.js code with error handling, JSDoc comments, and tests
2. **Review my approach** — when I share code or a plan, critique it and suggest improvements
3. **Debug with me** — when something breaks, help me trace the issue
4. **Keep me on track** — if I'm going down a rabbit hole, flag it and redirect

## CODING STANDARDS
- Node.js with ES modules (import/export)
- Async/await everywhere (no callbacks)
- Use `p-limit` for concurrency control
- Use `axios` for HTTP requests
- Use `dotenv` for environment variables
- Every function has JSDoc with @param and @returns
- Error messages must include context (which contact, which batch, which field)
- No TypeScript (keep it simple for speed)

## PHASE-BY-PHASE PLAN

### Phase 1 — Discovery & Audit (May 4 – May 8)

#### Day 1 — Pull sample data from both systems
- [x] `scripts/sample-ghl-contacts.js` — 100 contacts → `data/samples/ghl-sample-100.json` ✓
- [x] GHL total record count confirmed: **897,917** (not 44K as earlier estimated)
- [x] GHL pagination confirmed: cursor-based via `startAfterId`
- [x] `scripts/pull-hubspot-schema.js` — all HS contact properties → `data/samples/hubspot-schema.json` ✓
- [x] HubSpot portal confirmed: **917 properties total, 0 custom** — clean slate, all 8 custom props need creating

#### Day 2 — Explore GHL data deeper ✓
- [x] Analysed single contact object — all 33 fields decoded and mapped
- [x] `scripts/sample-ghl-endpoints.js` — pulled customFields, tags, pipelines, opportunities
- [x] Decoded 3 custom field IDs: Community Join Date, SMS Eng-Score, Email Eng-Score
- [x] Decoded full tag taxonomy: buyer_tier, market_city, engagement, guest, fulfillment, cancellation, system
- [x] Confirmed 11 pipelines, 798,008 opportunities, `hs_transfer` tag as migration filter
- [x] Custom property count revised: 8 → 14 properties needed
- [x] `docs/field-mapping.md` created (preliminary — refined in Day 3)

#### Day 3 — Build the complete field mapping ✓
- [x] Cross-referenced all GHL fields against live HubSpot schema (917 properties)
- [x] `docs/field-mapping.md` finalised — all fields mapped with transformation + status
- [x] **Discovery**: Andy already created `event_type` (3 options) and `eventtag` (city checkbox) — use these instead of creating duplicates
- [x] `event_type` needs 4 more options: Foundations, Commercial, Expo, Fly Out
- [x] `eventtag` = market/city — Andy's field, confirm city list is complete
- [x] 2 existing custom properties (Andy's) + 14 new ones to create = 16 total before migration
- [x] 8 open questions for Andy documented in field-mapping.md Section 7

#### Day 4 — Write the gap analysis ✓
- [x] `docs/gap-analysis.md` — complete: missing fields, type mismatches, data quality issues, geo tag structure, payment data, associations, risk register
- [x] `docs/field-mapping-client.md` — client-facing field mapping with 8 merged open items
- [x] **Discovery**: GHL has 1,211 custom fields — ~1,200 are per-event RADIO session fields, only 8 migrate
- [x] **Discovery**: `{{ad.name}}` unresolved template placeholder found in live contact data — must strip in transform
- [x] **Discovery**: `Preview Guest - Group` confirmed as TEXT field — guest association link confirmed

#### Day 5 — Client working session ✓
- [x] Meeting held May 8 with Alex and Andy — all major field decisions closed
- [x] **Payment processor confirmed: NMI** — Alex to provide API access. Andy already built a GHL form-submission payment ledger + HubSpot backfill (active NMI→HubSpot integration running). Workshop backfill complete; Foundations + Preview still running.
- [x] **Market/city**: `eventtag` stays as-is (tied to EventHappily + Airtable, 135+ cities). `primary_market` separate property confirmed. **NEW**: market/city must also be written to Deal records for performance reporting — deal migration scope expanded.
- [x] **Preview payment fields**: YES — migrate alongside workshop payment fields
- [x] **Products purchased**: Check existing HubSpot properties first (`workshop_product_package` + a la carte may already exist) — compare before creating new ones
- [x] **Coaching fulfillment**: Summary only — sessions purchased, assigned coach, sessions fulfilled. 25 individual date fields skipped.
- [x] **Guest association**: Confirmed non-destructive — create association only where missing, never overwrite
- [x] **Migration approach confirmed**: Non-destructive enrichment — Andy's team already created all Workshop contacts + deals in HubSpot from GHL data (confirmed May 13). Our job is to UPDATE existing HS records with missing/incomplete fields (market_city, payment data, custom fields). Match chain: HS contact ID → email → phone. Never create duplicates, never overwrite non-blank values with blanks from GHL.
- [x] **HubSpot contact ID**: Confirmed as highest-confidence match, fall back to email → phone
- [ ] **Pending — Andy**: Confirm NMI→HubSpot backfill covers Preview and Foundations buyers (workshop already done; Andy's integration is running — no NMI build needed from us)
- [x] **HubSpot owner list for sales rep name matching** — Resolved May 9. Workshop Team, Preview Sales Team, Telesales Rep/Team already exist as checkbox properties in HubSpot. Map directly from GHL — no lookup table needed. HS values are source of truth (Andy confirmed).
- [ ] **Pending — Us**: Compare GHL product fields vs existing HubSpot properties before property creation
- [ ] **Pending — Us**: Add market/city to deal migration design
- [ ] Tier C items not covered (businessId, multi-location, test tags, secondary emails) — carry to Phase 2

### Phase 2 — Build & Pilot (May 11 – May 15)

> **Sandbox strategy**: GHL data is always pulled from PROD (read-only, safe). All HubSpot writes (property creation, pilot load) go to **Andy's legacy sandbox first** (NOT "TLC Leads Backup" — keep that untouched per Andy, May 13). Switch `HUBSPOT_API_KEY` to PROD only after pilot sign-off on Day 10.
> **Sandbox schema gap**: Legacy sandbox has NOT been synced with PROD. Before Day 10 pilot: (1) pull sandbox schema via `pull-hubspot-schema.js` with sandbox API key, (2) compare against PROD schema, (3) run `create-hubspot-properties.js` against sandbox to fill gaps. Sandbox API key needed from Andy/Michael.

#### Day 6 — Property Setup ✓ (completed May 12)
- [x] Audited live HubSpot schema — **29 of 36 planned properties already exist** from Andy's Oct 2025 migration attempt
- [x] Key name differences to use in fieldMapper: `sms_engmt_score`, `email_engmt_score`, `market_name` (not primary_market), `preview_invoice_id_payment_id`, `telesales_repteam`, `number_of_coaching_sessions_purchased`, `preview_sales_rep`
- [x] Built + ran `scripts/create-hubspot-properties.js` — 7 properties created, 0 failed
- [x] `event_type` updated — 4 options added: Foundations, Commercial, Expo, Fly Out
- [x] Reports: `data/reports/property-setup-2026-05-12T00-00-31-002Z.json` (run 1), `data/reports/property-setup-2026-05-12T00-16-43-819Z.json` (run 2 — event_type fix)

**PROD property setup (May 15) — final state:**
- Created 19 properties in PROD: `buyer_tier`, `community_join_date`, `cancellation_status`, `fulfillment_status` (missing from PROD), + all 16 fulfillment/attendance fields
- Skipped 32 already existing (Andy's properties)
- `propstream_date_fulfilled` was already in PROD (Andy had it)
- `event_type` — 4 options added (Foundations, Commercial, Expo, Fly Out) — confirmed missing from PROD too
- 0 failures
- Report: `data/reports/property-setup-2026-05-15T20-52-51-037Z.json`
- **PROD HubSpot schema is now fully set up — 51 total custom properties ready for migration**

#### Day 7 — Tuesday May 12: Extract Module ✓ (completed May 12)
- [x] `src/extract/ghlClient.js` already existed — added `findContacts()` and `getContactIdsByPipeline()` methods
- [x] `scripts/debug-tags.js` — diagnostic scan: confirmed only 5 unique tags in first 1,000 contacts, 0 buyer-tier matches
- [x] **Key finding**: GHL contact pagination returns newest-first — first 134K+ records are HS→GHL imports tagged `hs-to-hl_temp_*`. Tag-based contact scanning never reaches Workshop Buyers.
- [x] **Solution**: Query Workshop pipeline opportunities (`sJF6NWKqQAF4qZGBK3cq`) page-by-page → collect contactIds → fetch each contact by ID → filter for `wb`/`wb_diamond` in memory
- [x] **Bug found & fixed**: Opportunities API uses `page` number pagination, NOT `startAfterId` cursor (unlike contacts API)
- [x] `scripts/extract-workshop-buyers.js` — pipeline-based extractor (`npm run extract:wb`)
- [x] **Result**: 100 confirmed Workshop Buyers extracted — `wb`: 100/100, `wb_diamond` confirmed on majority
- [x] **Field coverage**: id/name/email/phone/timezone/tags/customFields all 100%; city/address/state 97%; postalCode 94%; assignedTo 77%
- [x] 6 rate-limit (429) errors noted — retry/backoff logic planned for Day 9 load module (not a Day 8 blocker)
- [x] `wb`/`wb_diamond` tags confirmed intact in GHL — partially answers Q2 sent to Andy
- [ ] `src/extract/csvParser.js` — deferred (API extraction confirmed working, CSV fallback not needed for pilot)

**Andy's replies (received May 13 via Michael/Shawn):**
- Q1: ✅ **ANSWERED** — hs-to-hl is an ACTIVE, ONGOING process started last week. Client has poor email deliverability in HubSpot; routing all new Preview registrations through GHL (Engager) for email/SMS sequences instead. Plan runs 4-6 more weeks while HubSpot email validity is cleaned up. Contact count in GHL grows daily. Our pipeline-based extraction is immune (bypasses contact list).
- Q2: ✅ **ANSWERED** — Andy's team has **already finished creating all Workshop registrants + deals in HubSpot** from GHL data. Deal stages already reflect buyer/non-buyer status. Our Tier 1 migration is therefore an **ENRICHMENT run** (UPDATE existing HS records with missing fields), NOT a bulk create. Dedup is the most critical part of the pipeline — must match on HS contact ID / email, never create duplicates.
- Q3: ✅ **ANSWERED** — No longer an issue (Andy confirmed). Pipeline approach works.
- Q4: ✅ **ANSWERED May 13** — NOT aligned. Two sandboxes: use legacy (Andy's original); "TLC Leads Backup" is off-limits. Sandbox API key already configured.

#### Day 8 — Wednesday May 13: Transform Module ✓ (completed May 13)
- [x] `src/transform/cleaner.js` — `{{placeholder}}` stripping, email validation/normalisation, phone E.164 normalisation, phone-as-name detection, HTML tag stripping
- [x] `src/transform/geoResolver.js` — event tag decoder (`YYYYMMDD_CITYCODE` → city name), city code map (46 entries), unknown-code logging
- [x] `src/transform/fieldMapper.js` — complete GHL→HubSpot mapping: all standard fields, all 24 custom fields (CUSTOM_FIELD_ID_MAP), buyer_tier (tag priority), cancellation_status, fulfillment_status, eventtag, registration attribution
- [x] `src/transform/deduplicator.js` — match chain: hubspot_contact_id → email → phone; buildExistingMap() indexes by email + phone
- [x] 100/100 workshop buyer sample processed without error
- [x] 16 unknown city codes discovered and added to CITY_CODE_MAP during testing

**Event fulfillment fields added to scope (May 15) — Andy green light confirmed:**
16 new fields added to `fieldMapper.js` and `create-hubspot-properties.js`:
- 7 attendance status fields: `workshop_attendance_status`, `foundations_attendance_status`, `auction_attendance_status`, `commercial_attendance_status`, `expo_attendance_status`, `summit_attendance_status`, `symposium_attendance_status`
- 8 date fulfilled fields: `workshop_date_fulfilled`, `foundations_date_fulfilled`, `expo_bootcamp_date_fulfilled`, `auction_date_fulfilled`, `commercial_bootcamp_date_fulfilled`, `flyout_date_fulfilled`, `summit_date_fulfilled`, `propstream_date_fulfilled`
- 1 multi-select: `tlc_events_attended` ("Which TLC events have you attended?")
- Source IDs: `Rq7cnsHuFoM5ToszZoMN`, `AslBpu7YJRTEWxGG5Vac`, `8C4y1RyeYLG3fpywBSfP`, `27987mgyDDic9Bs6KZEI`, `m5BMgHBqYfwBvs77U31A`, `O1g8LKalb7jsHSPb5Oyo`, `R9yZyQMKm8bZKMvqAXrB`, `fDwc1oHV1sQu0mKQoQOJ`, `tIjqcLNkPtmYw7JEeQYE`, `O2oSJOjyWViP5lPQaXSa`, `S1HYJJQkGdiWQoeGM6bN`, `UpGbVgWeCs8sxpNp4oNF`, `45sELBoFlhUH7h7onvh9`, `0Sdv3wgHiYzgqeALpW8a`, `6BYevZMMUOPFRvNuzFfE`, `8HRVUMTBzK0jS9XBJGxV`

**Andy's property decisions (confirmed May 14):**
- `engager_contact_id` — use EXISTING HubSpot property (not the newly-created `ghl_contact_id`). GHL contact ID must be written here.
- `utm_source` / `utm_medium` — EXISTING HubSpot properties confirmed in schema. Use instead of newly-created `registration_source` / `registration_medium`. Descriptions confirm: "Most recent utm_source/utm_medium parameter received during event registration" — exact match.
- **Net effect**: 2 of the 6 Day 6 custom properties are now redundant (`registration_source`, `registration_medium`). They can be archived after the migration.

**Pending code changes before Day 9 (apply at start of Day 9):**
1. `src/transform/fieldMapper.js` line 118: `ghl_contact_id` → `engager_contact_id`
2. `src/transform/fieldMapper.js` lines 147–149: `registration_source` → `utm_source`, `registration_medium` → `utm_medium`
3. `src/transform/deduplicator.js` `buildExistingMap()`: also index by `engager_contact_id` (for contacts Andy's team already loaded)

#### Day 9 — Thursday May 14: Load Module + Infra ✅ COMPLETE
- [x] Build `src/load/hubspotClient.js` — HubSpot API v3 wrapper (batch create/update/read, associations, owners, properties)
- [x] Build `src/load/batchUpserter.js` — dedup + batch upsert, 100 contacts/request, exponential backoff on 429/5xx
- [x] Build `src/load/checkpoint.js` — resume-on-failure JSON state per tier run
- [x] Build `src/utils/logger.js`, `rateLimiter.js`, `config.js`
- [x] Wire everything into `scripts/migrate-tier.js` — reads pre-extracted contacts, loads owner map, runs BatchUpserter
- [x] Build `scripts/pilot-run.js` — 100-contact sandbox pilot (100/100 succeeded)
- [x] Build `scripts/build-owner-map.js` — fetches GHL users + HubSpot owners, matches by email → 20/20 matched
- [x] Build `scripts/sample-opportunity.js` — confirmed lead disposition is deal-level, not contact-level
- [x] Build `scripts/validate-pilot.js` — automated post-pilot field validation (20/20 PASS)
- [x] **Sandbox prep**: ran `create-hubspot-properties.js` against sandbox → 35 properties created/verified
- [x] **Bugs found and fixed during pilot**:
  - `hs_timezone` format: `America/Denver` → `america_slash_denver` (lowercase, `/` → `_slash_`)
  - `hs_email_optout` is read-only in HubSpot contacts API → removed from fieldMapper (opt-out is a separate API pass)
  - SSL TLS error on POST requests from remote machine → bypassed with `NODE_TLS_REJECT_UNAUTHORIZED=0`
  - 8 custom properties missing from sandbox → added to `create-hubspot-properties.js` and created

#### Day 10 — Friday May 15 / Saturday May 16: PROD Pilot + Tier 1 Prep ✅ COMPLETE
- [x] 100-contact sandbox pilot — 100/100 succeeded (completed Day 9)
- [x] Automated validation — 20/20 PASS (completed Day 9)
- [x] PROD property setup — 19 properties created, 32 skipped, 0 failed. Added West Palm Beach, New York, Manhasset to eventtag
- [x] PROD owner map — 20/20 GHL users matched to HubSpot owners by email
- [x] PROD pilot: 10 contacts — 10/10 succeeded after 3 bug fixes (see below)
- [x] PROD pilot validation — 7/10 PASS, 3 NOT_FOUND (PROD data quality, not migration issue)
- [x] Full Workshop Buyers extraction — 1,834 contacts confirmed (see count note below)
- [x] PROD pilot shared with Andy for weekend review
- [x] Andy replied: include ALL pipeline contacts (~33K), not just wb/wb_diamond. Remove tag filter, add all statuses (open/won/lost/abandoned). Re-extraction underway.
- [ ] Tier 1 full run — pending Andy sign-off + re-extraction complete

**Bugs found and fixed during PROD pilot (May 15–16):**
1. *Dedup bug (critical)*: engager_contact_id lookup was receiving HubSpot IDs instead of GHL IDs — fixed to use hs_object_id for HS IDs and engager_contact_id for GHL IDs separately
2. *engager_contact_id uniqueness conflict*: PROD has duplicate contacts where GHL ID is set on a different record — fixed by stripping engager_contact_id from all update payloads
3. *Email/phone uniqueness conflict*: Same duplicate-contact root cause — fixed by stripping email and phone from update payloads (enrichment pass only — identity fields stay as-is in HubSpot)
4. *GHL 429 rate limit*: extract script was crashing on rate limit errors — added retry-with-backoff (5 attempts, exponential delay) and 150ms inter-request delay
5. *GHL 400 end-of-page*: GHL returns HTTP 400 (not empty array) past the last page — was crashing before saving; fixed to treat 400 as end-of-results

**Workshop Buyer count — revised May 16 (Andy reply):**
- First run result: 1,834 contacts matched wb/wb_diamond tags (open status only)
- Andy's reply: include ALL pipeline contacts — open + won + lost + abandoned, no tag filter
- Revised expected Tier 1 count: **~33K** (all pipeline opportunities, all statuses)
- Tag filter removed from extract-workshop-buyers.js; all 4 statuses added (open/won/lost/abandoned)
- Re-extraction running on remote machine (targeting 50K cap, will capture full ~33K)
- Total 850K migration scope is unchanged — ~33K is Tier 1 only

**Pre-flight checklist — required before Tier 1 runs:**
1. Andy sign-off (weekend review)
2. HubSpot backup export of Workshop Buyer contacts
3. Pause HubSpot workflows — Andy to confirm which workflows are active (risk: automations firing on 1,834 bulk property updates)
4. Lifecyclestage clarification — PROD contacts carry custom stage ID `2107021006`; pipeline will overwrite with "customer" — Andy must confirm this is correct

**Validate-pilot.js improvements (May 16):**
- Added SKIP_ON_UPDATE set (email, phone, engager_contact_id) — fields intentionally stripped from updates no longer flagged as failures
- Added all 16 fulfillment fields to PROPS_TO_FETCH — were missing, causing false blank failures
- Moved lifecyclestage to WARN_ONLY pending Andy confirmation on custom stage ID

> **⚠️ DEAL MIGRATION STATUS (updated May 15)**: Andy's team is finishing Foundations deals + registrants backfill **today (May 15)**. Next: Advanced Camps (Expo, Auction, etc.) then Coaching. Contact migration is unaffected — proceeds on schedule.
>
> **⚠️ PREVIEW DEALS — NEW SCOPE ITEM (May 15)**: Andy flagged that Preview deals were **never migrated** from Engager to HubSpot. His team won't cover it. We agreed to take it on as a **separate pass after May 22** (post contact migration). Source data is complex: mix of contact fields + tags + opportunities in Engager. Steps: (1) sample Preview opportunities to map extraction logic, (2) build extractor + deal creator, (3) run after Tier 3 contact migration completes. Does NOT affect May 22 target.

### Phase 3 — Tier 1 Migration (May 17, weekend)
- [ ] Wait for Workshop Buyers re-extraction to complete on remote (~33K, all statuses)
- [ ] Copy workshop-buyers.json from remote via AnyDesk
- [ ] Take HubSpot backup export of Workshop Buyer contacts before run
- [ ] Pause HubSpot workflows (Andy to confirm list)
- [ ] Confirm lifecyclestage 2107021006 handling with Andy
- [ ] Andy sign-off → run ~33K Workshop Buyers enrichment via `npm run migrate:tier1`
- [ ] Automated validation (`node scripts/validate-pilot.js --tier=1 --count=200`)
- [ ] Manual spot-checks on edge cases
- [ ] Build guest_of associations for Tier 1
- [ ] Generate validation report → send to Alex + Brandon/Eddie/Jai/James

### Phase 4 — Tier 2 Migration (May 18–19)
- [x] `scripts/extract-preview-buyers.js` built — pipeline `yZ49CJBYdHhC0IEIe9Cs`, all 4 statuses, no tag filter
- [ ] Run `npm run extract:pb` on remote — extract ~30K Preview Buyers → `data/samples/preview-buyers.json`
- [ ] Pilot Tier 2: `node scripts/pilot-run.js --tier=2 --count=10`
- [ ] Validate Tier 2 pilot: `node scripts/validate-pilot.js --tier=2 --count=10`
- [ ] Run Tier 2 migration: `npm run migrate:tier2`
- [ ] Process cross-tier guest_of associations
- [ ] Automated validation + dedup report
- [ ] Tier 2 sign-off report

### Phase 5 — Tier 3 + Handoff (May 20–22 — Overnight Runs)
- [x] Tier 3 extraction strategy: contacts API cursor-based pagination, exclude `hs_transfer`/`hs-to-hl` tags
- [x] `scripts/extract-registrants.js` built — `npm run extract:reg:sample` (100 contacts) / `npm run extract:reg` (full 900K cap)
- [ ] Run `npm run extract:reg:sample` on remote — 100 contacts for Tier 3 pilot
- [ ] Pilot Tier 3: `node scripts/pilot-run.js --tier=3 --count=10`
- [ ] Validate Tier 3 pilot: `node scripts/validate-pilot.js --tier=3 --count=10`
- [ ] Run `npm run extract:reg` on remote overnight — full ~800K General Registrants
- [ ] Run Tier 3 migration: `npm run migrate:tier3` (overnight, May 20–21)
- [ ] Monitor overnight run with alerts
- [ ] Final association pass
- [ ] Global QA: count reconciliation, dedup scan, field completeness
- [ ] Write documentation for client team
- [ ] **Target final handoff: May 22–23** (7 days ahead of May 30 deadline)

### Phase 6 — Preview Deal Migration (On Hold — Andy's team)
Andy confirmed (May 15) his team will keep Preview deal backfill in their own court for now. This scope is NOT on our plate. If they need help later it becomes a separate paid engagement — flag to Alex before agreeing to anything.

### May 14, 2026 — Stakeholder Update + James Loom Review

**Stakeholder chain clarified (May 14):**
- The message "Hi Shawn, thank you for your diligent reporting..." was sent by **Alex** (PM) to **Shawn/Michael** — not Andy.
- Andy did NOT share any prior work → we built everything from scratch (audit, architecture, code, reporting).
- Brandon, Eddie, Jai, James are the ultimate clients — they must be included in all reports going forward.
- Michael is worried they are anxious because they haven't been included in updates yet.

**James' Loom Video Findings (May 14) — 3 gaps identified:**
1. **Lead Disposition — CRITICAL**: Sales team can't see how a lead was dispositioned after a call (Not Interested, Recycled, Saved, etc.). Without this, reps risk re-calling already-handled leads. Likely stored on the GHL opportunity record. Need to investigate before confirming scope.
2. **Contact Owner / Sales Rep Assignment — HIGH**: Contacts assigned to reps in Engager show as unassigned in HubSpot. `assignedTo` field already extracted — need GHL user ID → HubSpot owner ID lookup. Adding to Day 9 scope.
3. **Compliance Document Dates — LOW (accept as-is)**: Attachment upload dates reflect migration date, not original signing date. HubSpot API limitation — not fixable without creating fake engagements. Document as known constraint.

**Bonus offer (May 14):** Alex relayed that Brandon/Eddie/Jai/James offered a bonus for early delivery. Target: May 22–23. Mounaim to confirm bonus split with Michael before delivery.

**Reply to Alex drafted (May 14):** Confirmed milestones, addressed James' findings (disposition, owner assignment, document dates), committed to May 22–23 target. To be sent by Michael (as Shawn) to Alex.

---

## ACCELERATED DAILY PLAN (May 14 → May 22)

| Date | Day | Task | Status |
|------|-----|------|--------|
| May 14 (Wed) | Day 9 | Apply property renames (engager_contact_id, utm_source/medium) · Build load module (hubspotClient, batchUpserter, checkpoint, rateLimiter) · Build migrate-tier.js · Add contact owner lookup · Sandbox prep | ✅ Complete |
| May 15 (Thu) | Day 10 | PROD pilot: 10/10 succeeded · Validation: 7/10 PASS · Extract: 1,834 WBs confirmed · Andy review scheduled weekend | ✅ Complete |
| May 16 (Fri) | Day 11 | Build Tier 2 extractor (extract-preview-buyers.js) · Build Tier 3 extractor (extract-registrants.js) · Generalize pilot-run.js + validate-pilot.js for all tiers · Fix SSL/429/400 retries in extract-wb · Remove tag filter + add all statuses to extract-wb · Re-extract WBs (~33K) in progress on remote | ✅ Complete |
| May 17 (Sat) | Day 12 | Andy sign-off · Tier 1 run: 1,834 Workshop Buyers · Validation · guest_of associations · Report | ⬜ Pending |
| May 18 (Sun) | Day 13 | Tier 2 extract + run: ~30K Preview Buyers | ⬜ Pending |
| May 19 (Mon) | Day 14 | Tier 2 complete · Validation · Report to Alex + Brandon/Eddie/Jai/James | ⬜ Pending |
| May 20 (Tue) | Day 15 | Tier 3 start: 800K overnight batch run begins | ⬜ Pending |
| May 21 (Wed) | Day 16 | Tier 3 overnight run completes · Monitor · Fix failures | ⬜ Pending |
| May 22 (Thu) | Day 17 | Final QA: count reconciliation, dedup scan, field completeness · Final report · Handoff | ⬜ Pending |

---

### May 15, 2026 — Andy + Alex Update

- **Alex Trujillo (PM)** confirmed enthusiasm for May 22 target: "This is great! Amazing if we can hit that May 22!"
- **Andy Johnsen** replied:
  - Foundations deals + registrants backfill finishing today (May 15). Moving to Advanced Camps (Expo, Auction, etc.) then Coaching.
  - **Preview deals were never migrated** — Andy's team won't cover it. Flagged as a priority for TLC. We agreed to take it on as a post-May 22 separate pass.
  - Our response (via Michael/Shawn): flagged it as separate scope, said we'd align with Alex before building.
  - **Andy's final reply**: "Well keep the Preview deal backfill in our court for now then." → Andy's team is handling it. Not our scope.

## CONFIRMED DETAILS (as of May 3, 2026)

| Item | Status | Notes |
|------|--------|-------|
| HubSpot access level | Confirmed — Super Admin write | Needed for properties, upserts, associations |
| HubSpot portal tier | Confirmed — Enterprise | Sandbox also available |
| Multi-location documentation | Exists | Client sharing Monday |
| Stakeholder interviews | 5 slots pre-scheduled | Monday kickoff with lead dev Andy |
| Payment history depth | Full history required | Must preserve method, quantity, date, balance — not just current state |
| Conversations migration | Partial | Lead dev's team has many items already exported as notes; full status Monday |
| Tier 2 count | ~30K (revised) | Original brief said ~40K; client confirmed ~30K preview buyers |
| Access needed | GHL (Engager) + HubSpot Super Admin | Michael setting up access |

## PROJECT UPDATES

### May 3, 2026 — Scope Alignment with Client (via Michael)
- Mounaim sent pre-kickoff clarification questions to client; all answered same evening
- **Critical tier naming discrepancy resolved**: Client refers to Workshop Buyers as "3rd Tier", Preview Buyers as "2nd Tier", General Registrants as "1st Tier" — opposite of our internal numbering. See tier table for cross-reference
- Tier 2 count revised from ~40K to ~30K (preview buyers)
- HubSpot Enterprise + sandbox confirmed
- Full payment history required: methods, quantities, dates, balances
- Conversations partially pre-exported as notes by client's lead dev Andy — assess Monday
- Monday meeting scheduled with Andy + client to review existing scripts and get access

## START COMMAND
When I say "let's start phase 1" or "build [module name]", jump straight into the code or task. Don't repeat this brief back to me. Reference it as needed but keep moving forward.
