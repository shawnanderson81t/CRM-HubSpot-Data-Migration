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
| `1rnHjHmUbV5XkqyEVVHx` | Workshop Payment Status | SINGLE_OPTIONS | `payment_status` | enumeration | Map option labels → HubSpot enum values | 🔨 Needs creation |
| `242BK1r5mwKE4NDdEspk` | Workshop Payment Balance | MONETORY | `payment_balance` | number | Decimal — copy as-is | 🔨 Needs creation |
| `0b6zq88gXLBCNzDP325l` | Preview Invoice ID | TEXT | `preview_invoice_id` | string | Direct copy | 🔨 Needs creation |
| `1AhH8EKwizmtvm2gw45U` | Preview Attendance Status | SINGLE_OPTIONS | `preview_attendance_status` | enumeration | Map option labels | 🔨 Needs creation |
| _(per-event RADIO fields)_ | e.g. `20231113_JAX`, `20250929_HNL` | RADIO | **Do not migrate** | — | Redundant with tag-based market_city | ❌ Skip |

> **Note**: The GHL custom fields list has hundreds of per-event RADIO fields (one per city per event date). These are redundant — the tag system encodes the same information. Do NOT create corresponding HubSpot properties. Confirm with Andy before any per-event field migration.

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

### 3b. Market / City → `eventtag` (existing HubSpot property — Andy's)

> **Discovery**: Andy already created `eventtag` (checkbox multi-select) with full city names (Albany, Albuquerque, Atlanta, etc.). This covers the `market_city` use case. **Use `eventtag` instead of creating a new `market_city` property.** Confirm with Andy that options list is complete.

GHL tag pattern: `YYYYMMDD_CITYCODE` — extract the city code suffix and map to city name:

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

| Property | Already Exists? | Action Needed |
|---|---|---|
| `event_type` | ✅ Yes (Andy created May 4) | Add options: Foundations, Commercial, Expo, Fly Out |
| `eventtag` | ✅ Yes (Andy created May 4) | Confirm city list is complete — use instead of `market_city` |
| `ghl_contact_id` | ❌ No | Create — text |
| `buyer_tier` | ❌ No | Create — dropdown (9 options) |
| `attendance_status` | ❌ No | Create — dropdown |
| `registration_source` | ❌ No | Create — text |
| `registration_medium` | ❌ No | Create — text |
| `payment_status` | ❌ No | Create — dropdown |
| `payment_balance` | ❌ No | Create — number |
| `community_join_date` | ❌ No | Create — date |
| `sms_engagement_score` | ❌ No | Create — number |
| `email_engagement_score` | ❌ No | Create — number |
| `cancellation_status` | ❌ No | Create — dropdown |
| `fulfillment_status` | ❌ No | Create — dropdown |
| `preview_invoice_id` | ❌ No | Create — text |
| `preview_attendance_status` | ❌ No | Create — dropdown |

**Summary: 2 exist (need updates), 14 need creating.**

---

## 7. Open Questions for Andy

| # | Question | Blocks |
|---|---|---|
| 1 | Is `eventtag` the canonical market/city field, or should we create a separate `market_city`? | Transform logic |
| 2 | What are the full option values for GHL `workshop_payment_status`? | `payment_status` dropdown options |
| 3 | What does `businessId` represent? | Whether to map or skip |
| 4 | How are multi-location contacts handled — one record or multiple? | Association architecture |
| 5 | Is `Preview Guest - Group` custom field the link to the primary contact for guest associations? | `guest_of` association pass |
| 6 | Are the `pre_community_subjtest_*` tags A/B test markers safe to skip? | Transform logic |
| 7 | What GHL user IDs map to which HubSpot owner IDs? | `hubspot_owner_id` mapping |
| 8 | Should `additionalEmails` be stored as a note on the contact? | Gap coverage |

---

## 8. Status Legend

| Symbol | Meaning |
|---|---|
| ✅ Matched | GHL field maps to an existing HubSpot property — confirmed in schema |
| 🔨 Needs creation | Custom HubSpot property must be created before migration |
| ⚠️ Constraint | Exists in both systems but needs special handling |
| ❌ Skip / No equivalent | Not migrated |
| ❓ Investigate | Unclear — confirm with Andy |
