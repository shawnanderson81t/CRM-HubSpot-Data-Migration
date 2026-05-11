# GHL → HubSpot Field Mapping
_Day 3 — May 6, 2026 | Cross-referenced against live HubSpot schema (917 properties) and GHL sample data_

---

## 1. Standard Contact Fields

All verified against `data/hubspot-schema.json`.

| GHL Field | HubSpot Property | HS Type | Transformation | Status |
|---|---|---|---|---|
| `firstNameRaw` | `firstname` | string | Use Raw (properly capitalised). Ignore `firstName`. | ✅ Matched |
| `lastNameRaw` | `lastname` | string | Use Raw (properly capitalised). Ignore `lastName`. | ✅ Matched |
| `email` | `email` | string | Primary dedup key. Lowercase + trim. Null on ~5% of sample. | ✅ Matched |
| `phone` | `phone` | phone_number | Already E.164 (+1XXXXXXXXXX). Null on ~40% of sample. | ✅ Matched |
| `companyName` | `company` | string | Direct copy. Null on most. | ✅ Matched |
| `city` | `city` | string | Direct copy. Null on most — market city derived from tags instead. | ✅ Matched |
| `state` | `state` | string | Two-letter code. Direct copy. | ✅ Matched |
| `postalCode` | `zip` | string | Direct copy. Null on many. | ✅ Matched |
| `address1` | `address` | string | Direct copy. Null on most. | ✅ Matched |
| `country` | `country` | string | "US" on all sampled contacts. Direct copy. | ✅ Matched |
| `website` | `website` | string | Direct copy. Null on most. | ✅ Matched |
| `dateOfBirth` | `date_of_birth` | date | Direct copy. Null on most. | ✅ Matched |
| `timezone` | `hs_timezone` | string | Direct copy. Null on most. | ✅ Matched |
| `dnd` | `hs_email_optout` | bool | `true` → opt-out. Also check `e2i-email unsubscribe` tag. | ✅ Matched |
| `type` | `lifecyclestage` | enumeration | "lead" → `"lead"`. Check if other values exist beyond sample. | ✅ Matched |
| `dateAdded` | `createdate` | datetime | ISO 8601. HubSpot read-only after create — set via batch import only. | ⚠️ Read-only |
| `source` | `hs_analytics_source` | enumeration | **Cannot map directly** — GHL has free text ("Facebook", "Marketplace") but HubSpot `hs_analytics_source` is a fixed enum (ORGANIC_SEARCH, PAID_SOCIAL etc.). Use `registration_source` custom field instead. | ⚠️ Type mismatch |
| `assignedTo` | `hubspot_owner_id` | string | GHL user ID → must build GHL-to-HubSpot owner ID lookup table with Andy. | ⚠️ Needs lookup |
| `id` | `ghl_contact_id` | string | Preserve for rollback and reconciliation. | 🔨 Needs creation |
| `businessId` | — | — | Purpose unclear. Null on all sampled contacts. Confirm with Andy. | ❓ Investigate |
| `additionalEmails` | — | — | No HubSpot standard equivalent. Array — cannot store in single property. **Gap.** | ❌ No equivalent |
| `dndSettings` | — | — | Always `{}` in sample. May have structure on opted-out contacts. Check during Tier 1. | ❓ Investigate |
| `contactName` | — | — | Skip — HubSpot derives from firstname + lastname. | ❌ Skip |
| `firstName` / `lastName` | — | — | Skip — use Raw versions for proper casing. | ❌ Skip |
| `locationId` | — | — | GHL internal location scoping. Not needed in HubSpot. | ❌ Skip |
| `dateUpdated` | — | — | HubSpot manages `lastmodifieddate` automatically. Do not set. | ❌ Skip |
| `profilePhoto` | — | — | No HubSpot equivalent. | ❌ Skip |
| `followers` | — | — | GHL internal. Always `[]`. | ❌ Skip |
| `startAfter` | — | — | Pagination cursor injected by GHL API. Not real contact data. | ❌ Skip |

---

## 2. Custom Fields (GHL `customFields` array → decoded)

GHL returns `[{id, value}]` pairs. IDs resolved via `/locations/{id}/customFields`.

| GHL Field ID | Field Name | GHL Type | HubSpot Property | HS Type | Transformation | Status |
|---|---|---|---|---|---|---|
| `ZwJCtoQ4rG7eqZCJap0e` | Community Join Date | DATE | `community_join_date` | date | Unix ms → `new Date(value).toISOString().split('T')[0]` | 🔨 Needs creation |
| `agPOPXVU1qhYnjJxPz7V` | E2I-SMS Eng-Score | NUMERICAL | `sms_engagement_score` | number | Integer — copy as-is | 🔨 Needs creation |
| `dW752RjWvFrfBjpeSoTt` | E2I-Email Eng-Score | NUMERICAL | `email_engagement_score` | number | Integer — copy as-is | 🔨 Needs creation |
| `1rnHjHmUbV5XkqyEVVHx` | Workshop Payment Status | SINGLE_OPTIONS | `payment_status` | enumeration | Values: Paid in Full / Partial Payment / No Payment Required / Not Paid | 🔨 Needs creation |
| `242BK1r5mwKE4NDdEspk` | Workshop Payment Balance | MONETORY | `payment_balance` | number | Decimal — copy as-is | 🔨 Needs creation |
| `workshop_paid` | Workshop Amount Paid | MONETORY | `workshop_amount_paid` | number | Amount paid to date | 🔨 Needs creation |
| `workshop_total` | Workshop Total Amount | MONETORY | `workshop_total_amount` | number | Total contract value | 🔨 Needs creation |
| `workshop_purchase_date` | Workshop Purchase Date | DATE | `workshop_purchase_date` | date | ISO date | 🔨 Needs creation |
| `payment_transaction_id` | Payment Transaction ID | TEXT | `payment_transaction_id` | string | Direct copy | 🔨 Needs creation |
| `workshop_payment_type` | Workshop Payment Method | CHECKBOX | `payment_method` | enumeration (multi) | Credit Card, ACH, Cash, Check, Wire, UGA Financing | 🔨 Needs creation |
| `workshop_payment_history` | Workshop Payment History | LARGE_TEXT | `workshop_payment_history` | string | Free-text notes field — migrate as custom text property | 🔨 Needs creation |
| `preview_payment_status` | Preview Payment Status | SINGLE_OPTIONS | `preview_payment_status` | enumeration | Values: Paid in Full / Partial Payment / No Payment Required | 🔨 Needs creation |
| `preview_payment_balance` | Preview Payment Balance | MONETORY | `preview_payment_balance` | number | Decimal — copy as-is | 🔨 Needs creation |
| `preview_paid` | Preview Amount Paid | MONETORY | `preview_amount_paid` | number | Amount paid to date | 🔨 Needs creation |
| `preview_purchase_date` | Preview Purchase Date | DATE | `preview_purchase_date` | date | ISO date | 🔨 Needs creation |
| `preview_payment_methods` | Preview Payment Method | CHECKBOX | `preview_payment_method` | enumeration (multi) | Direct copy options | 🔨 Needs creation |
| `0b6zq88gXLBCNzDP325l` | Preview Invoice ID | TEXT | `preview_invoice_id` | string | Direct copy | 🔨 Needs creation |
| `1AhH8EKwizmtvm2gw45U` | Preview Attendance Status | SINGLE_OPTIONS | `preview_attendance_status` | enumeration | Map option labels | 🔨 Needs creation |
| `market_name` | Primary Market | RADIO | `primary_market` | enumeration | 88 markets — single-value primary market (separate from eventtag) | 🔨 Needs creation |
| `workshop_product_package` | Workshop Product Package | SINGLE_OPTIONS | `workshop_product_package` | enumeration | ALA CARTE, DIAMOND, GOLD, DIAMOND ELITE PROGRAM, FOUNDATIONS ONLY, REAL ESTATE FOCUSED PLATINUM, TAX LIEN FOCUSED PLATINUM, FOUNDER | ❓ Check HubSpot first |
| `products_purchased` | Products Purchased | CHECKBOX | `products_purchased` | enumeration (multi) | 3-Day Workshop, Foundation Bootcamp, Tax Lien Expo, Real Estate Summit, Auction Experience, Commercial Bootcamp, PropStream, Fly-Out Mentorship, etc. | ❓ Check HubSpot first |
| `number_of_coaching_sessions_purchased` | Coaching Sessions Purchased | NUMERICAL | `coaching_sessions_purchased` | number | Integer (3–16) | 🔨 Needs creation |
| `assigned_coach` | Assigned Coach | SINGLE_OPTIONS | `assigned_coach` | enumeration | 16 coaches | 🔨 Needs creation |
| `coaching_sessions_fulfilled` | Coaching Sessions Fulfilled | CHECKBOX | `coaching_sessions_fulfilled` | enumeration (multi) | Sessions 1–25 checkbox — fulfilled sessions | 🔨 Needs creation |
| `workshop_team` | Workshop Sales Rep | CHECKBOX | `workshop_team` (existing) | multi-select | Property already exists in HubSpot ("Workshop Team", TLC - Workshop Sales group). **HubSpot is the source of truth for option values** — pull options list from HS, not GHL. Copy GHL values directly (no lookup). | ✅ Exists — use HS as truth |
| `preview_sales_rep` | Preview Sales Rep | CHECKBOX | `preview_sales_team` (existing) | multi-select | Property already exists in HubSpot ("Preview Sales Team", TLC - Preview Sales group). HubSpot is source of truth for options. Copy GHL values directly. | ✅ Exists — use HS as truth |
| _(GHL telesales rep field)_ | Telesales Rep | CHECKBOX | `telesales_rep_team` (existing) | multi-select | "Telesales Rep/Team" exists in HubSpot (Telesales group). Andy confirmed values copied directly from GHL — identical. Map directly, no lookup. | ✅ Exists — values match GHL |
| `guest_of_email` | Guest Of (Email) | TEXT | `guest_of` association | — | Read email → look up primary contact → create contact-to-contact association | ⚠️ Association pass |
| `hubspot_contact_id` | HubSpot Contact ID (GHL) | TEXT | Match key | — | Highest-confidence dedup key. If populated, match directly by HubSpot ID — skip email/phone lookup. | ✅ Dedup logic |
| _(session 1–25 date fields)_ | `session_1_date_fulfilled` … `session_25_date_fulfilled` | DATE | **Do not migrate** | — | Too granular — summary captured via `coaching_sessions_fulfilled` | ❌ Skip |
| _(per-event RADIO fields)_ | e.g. `20231113_JAX`, `20250929_HNL` | RADIO | **Do not migrate** | — | Redundant with tag-based eventtag | ❌ Skip |

> **Note**: 1,211 custom fields total. ~1,200 are per-event RADIO fields (one per city per event date) — redundant with the tag system. Do not migrate. Only the fields listed above are in scope.

---

## 3. Tags → HubSpot Properties

Tags are GHL's primary classification system. Decoded and mapped to structured HubSpot properties during transform.

### 3a. Buyer Tier → `buyer_tier` (new custom dropdown)

Priority order when multiple tier tags exist (contacts accumulate tags through upgrades):

| GHL Tag | HubSpot Value | Priority |
|---|---|---|
| `wb_diamond` | `Workshop Buyer - Diamond` | 1 (highest) |
| `wb` | `Workshop Buyer` | 2 |
| `telesales_diamond` / `telesales_diamond-elite-program` | `Telesales Diamond Buyer` | 3 |
| `telesales_sold` | `Telesales Buyer` | 4 |
| `phase-preview-buyer` | `Preview Buyer` | 5 |
| `phase_preview-attendee` | `Preview Attendee` | 6 |
| `phase_preview-reg` | `Preview Registrant` | 7 |
| `phase_preview-non-attendee` / `pna` | `Preview Non-Attendee` | 8 |
| `community_newmember` / `community_newmember_directsignup` | `Registrant` | 9 (lowest) |

**Transform logic**: Collect all buyer-tier tags on a contact, select the one with the lowest priority number, set as `buyer_tier`.

### 3b. Market / City — Two separate fields (confirmed Day 5)

**`eventtag`** (existing HubSpot property — Andy's): Multi-select checkbox. Records all markets where a contact attended events. Populated from date-stamped GHL tags (`YYYYMMDD_CITYCODE`). **Do not modify Andy's field structure** — it is tied to EventHappily + Airtable automations. 135+ cities.

**`primary_market`** (new property — to create): Single-value dropdown. Populated from GHL `market_name` radio field (88 markets). Captures the contact's primary/home market. Separate from `eventtag`. Also must be written to Deal records for performance reporting.

These are complementary — `eventtag` = all cities attended (multi), `primary_market` = primary market affinity (single).

GHL tag pattern for `eventtag`: `YYYYMMDD_CITYCODE` — extract the city code suffix and map to city name:

| Code | City | Code | City |
|---|---|---|---|
| `hnl` | Honolulu | `pit` | Pittsburgh |
| `orf` | Norfolk | `dtw` | Detroit |
| `jfk` | New York | `lax` | Los Angeles |
| `fre` | Fresno | `sat` | San Antonio |
| `aus` | Austin | `cae` | Columbia |
| `phl` | Philadelphia | `cle` | Cleveland |
| `ind` | Indianapolis | `sba` | Santa Barbara |
| `san` | San Diego | `lbb` | Lubbock |
| `ccr` | Concord | `ord` | Chicago |
| `phx` | Phoenix | `mnh` | Manhasset |

**Transform logic**: For each date-tagged city, extract code after `_`, look up city name, add to `eventtag` array. A contact may have multiple cities.

### 3c. Event Type → `event_type` (existing HubSpot property — Andy's)

> **Discovery**: Andy already created `event_type` (enumeration/select) with 3 options: Preview, Workshop, Advanced Camp. **Options need expanding before migration.**

| GHL Tag / Source | HubSpot Value | Action |
|---|---|---|
| `phase_preview-*` / `preview_app_*` | `Preview` | ✅ Option exists |
| `wb` / workshop tags | `Workshop` | ✅ Option exists |
| Advanced camp tags | `Advanced Camp` | ✅ Option exists |
| Foundations tags | `Foundations` | ➕ Add option |
| Commercial tags | `Commercial` | ➕ Add option |
| Expo tags | `Expo` | ➕ Add option |
| Fly out tags | `Fly Out` | ➕ Add option |

### 3d. Engagement / DND → HubSpot subscription preferences

| GHL Tag | HubSpot Action |
|---|---|
| `e2i-email unsubscribe` | Set `hs_email_optout = true` |
| `e2i-email unengaged` | Add to HubSpot suppression list (do not set opt-out) |
| `e2i-email engaged` | No action — default state |
| `e2i-sms unengaged` | Tag for SMS suppression list |
| `e2i-sms engaged` | No action — default state |

### 3e. Guest / Association → `guest_of` contact association

| GHL Tag | Meaning | Migration Action |
|---|---|---|
| `preview_guest` | Attending as someone's guest | Build `guest_of` contact-to-contact association |
| `preview_guest_is-buyer` | Guest who is also a buyer | Associate + set buyer tier |
| `guest_confirmed` | Guest confirmed attendance | Note on contact record |
| `phase_preview-reg-guest` | Guest registered for preview | Confirm primary contact link |

**Association pass**: Contacts with `preview_guest` tag need a separate association pass after main load. Check `Preview Guest - Group` custom field (`contact.preview_guest__group`) — likely holds the primary contact reference.

### 3f. Cancellation → `cancellation_status` (new custom dropdown)

| GHL Tag | HubSpot Value |
|---|---|
| `workshop_cancel_reg` | `Workshop Cancelled` |
| `foundations_cancel_reg` | `Foundations Cancelled` |
| `all_products_cancelled` | `All Cancelled` |

### 3g. Fulfillment → `fulfillment_status` (new custom dropdown)

| GHL Tag | HubSpot Value |
|---|---|
| `coaching_sessions_purchased` | `Coaching Purchased` |
| `coaching_user_created_in_tlc` | `Coaching Active` |
| `community-assign-space` | `Community Active` |
| `user_created` | `Portal Active` |
| `marketplace_account` | `Marketplace Active` |
| `user_subscribed` | `Subscribed` |

### 3h. System Tags — Skip entirely

| Tag Pattern | Reason |
|---|---|
| `hs_transfer` | **Migration filter** — contacts already queued for HubSpot. Use to EXCLUDE from re-migration. |
| `pb`, `pb_YYYYMMDD_*` | PhoneBurner dialer markers |
| `202XXX_phoneburner_*` | Call log markers |
| `removed_from_ot` | GHL order tracking internal |
| `sent-post-event-survey` | GHL automation marker |
| `addressform_nothanks` | Declined address collection |
| `reg_confirm_sms_test` | Test tag |
| `fbla-messenger-sequence-v1*` | GHL messenger automation |

### 3i. Unknown Tags — Confirm with Andy

| Tag | Question |
|---|---|
| `pre_community_subjtest_sequence` | A/B test tag? Safe to skip? |
| `pre_community_subjtest_community` | Same — test tag? |
| `user_cart_abandoned` | Cart abandon tracking — needed in HubSpot? |
| `preview_app_atteded` | Typo of `preview_app_attended`? |
| `guestpostreg_YYMMDD` | Guest post-registration date stamp — skip or preserve? |

---

## 4. Attributions → Registration Source

`attributions` is an array; first entry (`isFirst: true`) = original source, last (`isLast: true`) = converting touchpoint.

| Attribution Field | HubSpot Property | Status |
|---|---|---|
| `attributions[0].utmSessionSource` | `registration_source` (new) | 🔨 Needs creation |
| `attributions[0].medium` | `registration_medium` (new) | 🔨 Needs creation |
| `attributions[0].utmCampaign` | Note on contact or `hs_analytics_last_url` | ⚠️ Partial |
| `attributions[last].pageUrl` | `hs_analytics_last_url` (built-in) | ✅ Matched |

---

## 5. Opportunities → HubSpot Deals

798,008 opportunities confirmed. Each GHL opportunity maps to one HubSpot Deal.

| GHL Field | HubSpot Deal Property | Transformation | Status |
|---|---|---|---|
| `name` | `dealname` | Contact name as deal name | ✅ Matched |
| `monetaryValue` | `amount` | Decimal — copy as-is (0 on all sample, confirm real values) | ✅ Matched |
| `status` | `dealstage` | "open" → active stage ID, "lost" → closed lost | ⚠️ Needs stage ID map |
| `source` | `deal_source` (or notes) | Free text — no standard HubSpot deal source field | 🔨 Needs creation |
| `createdAt` | `createdate` | ISO 8601 | ✅ Matched |
| `pipelineId` | `pipeline` | GHL pipeline ID → HubSpot pipeline ID (build lookup table) | ⚠️ Needs lookup |
| `contactId` | Deal-Contact association | Link deal to contact via Associations API | ⚠️ Needs association |

**Pipeline map** (11 GHL pipelines → HubSpot pipelines, need creating):

| GHL Pipeline | Stages |
|---|---|
| 1 - Preview Registrants | Registered → PNA → Checked In → PA → PNB → Pender → PB → Open Ticket |
| 1.1 PNA Webinar | To confirm |
| _(9 more)_ | See `data/ghl-pipelines.json` |

---

## 6. Complete Custom Property Status

_Updated after Day 5 client session — May 8, 2026_

_Updated May 12 after auditing live HubSpot schema — most properties already exist from Andy's Oct 2025 migration attempt._

### Existing — Already in HubSpot (use as-is, no creation needed)

| HubSpot Property Name | Label | GHL Source | Action |
|---|---|---|---|
| `event_type` | Event Type | Tags | Add 4 options: Foundations, Commercial, Expo, Fly Out |
| `eventtag` | Workshop Event Tag | Tags (YYYYMMDD_CODE) | No changes — tied to Airtable/EventHappily |
| `market_name` | Market Name | `market_name` | Use directly — no need to create `primary_market` |
| `workshop_payment_status` | Workshop Payment Status | `workshop_payment_status` | Use as-is |
| `workshop_payment_balance` | Workshop Payment Balance | `workshop_payment_balance` | Use as-is |
| `workshop_paid` | Workshop Paid | `workshop_paid` | Use as-is |
| `workshop_total` | Workshop Total | `workshop_total` | Use as-is |
| `workshop_purchase_date` | Workshop Purchase Date | `workshop_purchase_date` | Use as-is |
| `workshop_payment_type` | Workshop Payment Type | `workshop_payment_type` | Use as-is |
| `workshop_payment_history` | Workshop Payment History | `workshop_payment_history` | Use as-is |
| `payment_transaction_id` | Payment Transaction ID | `payment_transaction_id` | Use as-is |
| `preview_payment_status` | Preview Payment Status | `preview_payment_status` | Use as-is |
| `preview_payment_balance` | Preview Payment Balance | `preview_payment_balance` | Use as-is |
| `preview_paid` | Preview Paid | `preview_paid` | Use as-is |
| `preview_purchase_date` | Preview Purchase Date | `preview_purchase_date` | Use as-is |
| `preview_payment_methods` | Preview Payment Method(s) | `preview_payment_methods` | Use as-is |
| `preview_invoice_id_payment_id` | Preview Invoice ID | `preview_invoice_id` | Use as-is (different name than planned) |
| `preview_attendance_status` | Preview Attendance Status | `preview_attendance_status` | Use as-is |
| `preview_sales_total` | Preview Sales Total | `preview_sales_total` | Use as-is |
| `workshop_product_package` | Workshop Product Package | `workshop_product_package` | Use as-is |
| `products_purchased` | Products Purchased | `products_purchased` | Use as-is |
| `number_of_coaching_sessions_purchased` | Number of Coaching Sessions Purchased | `number_of_coaching_sessions_purchased` | Use as-is (different name than planned) |
| `assigned_coach` | Assigned Coach | `assigned_coach` | Use as-is |
| `coaching_sessions_fulfilled` | Coaching Sessions Fulfilled | `coaching_sessions_fulfilled` | Use as-is |
| `workshop_team` | Workshop Team | `workshop_team` | Use as-is |
| `preview_sales_rep` | Preview Sales Team | `preview_sales_rep` | Use as-is |
| `telesales_repteam` | Telesales Rep/Team | _(GHL source TBD)_ | Use as-is (different name than planned) |
| `sms_engmt_score` | E2I-SMS Eng-Score | SMS Eng-Score custom field | Use as-is (different name than planned) |
| `email_engmt_score` | E2I-Email Eng-Score | Email Eng-Score custom field | Use as-is (different name than planned) |

### New — Must Create (7 properties missing from HubSpot)

| Property Name | Label | Type | Source |
|---|---|---|---|
| `ghl_contact_id` | GHL Contact ID | text | `id` — rollback + dedup key |
| `buyer_tier` | Buyer Tier | dropdown (9 values) | Tags |
| `registration_source` | Registration Source | text | `attributions[0].utmSessionSource` |
| `registration_medium` | Registration Medium | text | `attributions[0].medium` |
| `community_join_date` | Community Join Date | date | Community Join Date custom field |
| `cancellation_status` | Cancellation Status | dropdown (3 values) | Tags |
| `fulfillment_status` | Fulfillment Status | multi-select (6 values) | Tags |

**Summary: 29 already exist (5 with name differences to note in fieldMapper), 7 to create, 1 to update options (event_type).**

---

## 7. Open Questions — Status After Day 5

| # | Question | Status |
|---|---|---|
| 1 | Is `eventtag` the canonical market/city field, or separate? | ✅ **Resolved** — both: `eventtag` stays (multi-value, all cities attended), `primary_market` added (single-value) |
| 2 | What are the full option values for `workshop_payment_status`? | ✅ **Resolved** — Workshop: Paid in Full / Partial Payment / No Payment Required / Not Paid. Preview: Paid in Full / Partial Payment / No Payment Required |
| 3 | What does `businessId` represent? | ❓ **Open** — null on all sampled contacts. Carry to Phase 2. |
| 4 | How are multi-location contacts handled? | ❓ **Open** — not addressed in Day 5. Carry to Phase 2. |
| 5 | What is the guest association link field? | ✅ **Resolved** — `guest_of_email` stores primary contact's email on the guest record. `preview_guest__host_id` stores GHL ID as backup. |
| 6 | Are `pre_community_subjtest_*` tags safe to skip? | ❓ **Open** — not addressed. Carry to Phase 2. |
| 7 | How do GHL sales rep names map to HubSpot owners? | ✅ **Resolved (contact level)** — `workshop_team` and `preview_sales_team` already exist in HubSpot as checkbox properties. Copy values directly — no lookup needed. Telesales source field TBD. `hubspot_owner_id` on deals is a separate question. |
| 8 | Should `additionalEmails` be stored as a note? | ❓ **Open** — not addressed. Carry to Phase 2. |

---

## 8. Status Legend

| Symbol | Meaning |
|---|---|
| ✅ Matched | GHL field maps to an existing HubSpot property — confirmed in schema |
| 🔨 Needs creation | Custom HubSpot property must be created before migration |
| ⚠️ Constraint | Exists in both systems but needs special handling |
| ❌ Skip / No equivalent | Not migrated |
| ❓ Investigate | Unclear — confirm with Andy |
