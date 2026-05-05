# GHL → HubSpot Field Mapping
_Generated: May 5, 2026 | Based on data/samples/ from live GHL location_

---

## 1. Standard Contact Fields

| GHL Field | HubSpot Property | Type | Transformation | Status |
|---|---|---|---|---|
| `firstNameRaw` | `firstname` | string | Use Raw (properly cased) — ignore `firstName` | ✅ Matched |
| `lastNameRaw` | `lastname` | string | Use Raw (properly cased) — ignore `lastName` | ✅ Matched |
| `email` | `email` | string | Primary dedup key. Validate format. | ✅ Matched |
| `phone` | `phone` | string | E.164 format already (+1XXXXXXXXXX). Null on ~40% of sample. | ✅ Matched |
| `companyName` | `company` | string | Null on most contacts | ✅ Matched |
| `city` | `city` | string | Null on most — market city inferred from tags instead | ✅ Matched |
| `state` | `state` | string | Two-letter code | ✅ Matched |
| `postalCode` | `zip` | string | Null on many contacts | ✅ Matched |
| `address1` | `address` | string | Null on most contacts | ✅ Matched |
| `country` | `country` | string | "US" on all sampled contacts | ✅ Matched |
| `website` | `website` | string | Null on most contacts | ✅ Matched |
| `dateOfBirth` | `date_of_birth` | date | Null on most contacts | ✅ Matched |
| `timezone` | `hs_timezone` | string | Null on most contacts | ✅ Matched |
| `dnd` | `hs_email_optout` | bool | false → false, true → true | ✅ Matched |
| `dateAdded` | `createdate` | datetime | HubSpot read-only — set via batch import only | ⚠️ Read-only |
| `source` | `registration_source` | string | "Facebook", "Marketplace", null — also see `attributions` | 🔨 Needs creation |
| `assignedTo` | `hubspot_owner_id` | string | GHL user ID → must build GHL→HS owner ID lookup table | ⚠️ Needs lookup table |
| `type` | `lifecyclestage` | enumeration | "lead" → "lead". Check if other values exist. | ✅ Matched |
| `contactName` | — | — | Skip — HubSpot derives from first+last | ❌ Skip |
| `firstName` / `lastName` | — | — | Skip — use Raw versions | ❌ Skip |
| `locationId` | — | — | GHL internal scoping, not needed | ❌ Skip |
| `id` | `ghl_contact_id` | string | Preserve for rollback/reconciliation | 🔨 Needs creation |
| `businessId` | — | — | Purpose unclear — flag for Andy | ❓ Investigate |
| `additionalEmails` | — | — | No HubSpot standard equivalent. Gap — see Section 5. | ⚠️ Gap |
| `profilePhoto` | — | — | No HubSpot equivalent | ❌ Skip |
| `followers` | — | — | GHL internal, always empty | ❌ Skip |
| `dndSettings` | — | — | Always `{}` in sample — check opted-out contacts | ❓ Investigate |
| `dateUpdated` | — | — | HubSpot manages `lastmodifieddate` itself | ❌ Skip |
| `startAfter` | — | — | Pagination cursor injected by API — not real contact data | ❌ Skip |

---

## 2. Custom Fields Decoded

These appear as `{id, value}` pairs in `contact.customFields`. ID → name resolved from `/customFields` endpoint.

| GHL Custom Field ID | Field Name | GHL fieldKey | Data Type | HubSpot Property | Transformation | Status |
|---|---|---|---|---|---|---|
| `ZwJCtoQ4rG7eqZCJap0e` | Community Join Date | `contact.community_join_date` | DATE | `community_join_date` | Unix ms timestamp → ISO date | 🔨 Needs creation |
| `agPOPXVU1qhYnjJxPz7V` | E2I-SMS Eng-Score | `contact.sms_engmt_score` | NUMERICAL | `sms_engagement_score` | Integer — copy as-is | 🔨 Needs creation |
| `dW752RjWvFrfBjpeSoTt` | E2I-Email Eng-Score | `contact.email_engmt_score` | NUMERICAL | `email_engagement_score` | Integer — copy as-is | 🔨 Needs creation |

**Other high-priority custom fields identified in `/customFields` endpoint** (not yet seen in contact sample but critical for migration):

| GHL Field Name | GHL fieldKey | HubSpot Property | Status |
|---|---|---|---|
| Workshop Payment Status | `contact.workshop_payment_status` | `payment_status` | 🔨 Needs creation |
| Workshop Payment Balance | `contact.workshop_payment_balance` | `payment_balance` | 🔨 Needs creation |
| Preview Invoice ID (Payment ID) | `contact.preview_invoice_id_payment_id` | `preview_invoice_id` | 🔨 Needs creation |
| Preview Attendance Status | `contact.preview_attendance_status` | `preview_attendance_status` | 🔨 Needs creation |
| Workshop Host | `contact.workshop_host` | `workshop_host` | 🔨 Needs creation |
| Foundations Date & Time | `contact.foundations_date__time` | `foundations_date` | 🔨 Needs creation |

> **Note**: The full custom fields list has hundreds of entries (many per-event RADIO fields like `20231113_JAX`, `20230522_DTW`). These per-event fields do NOT need to migrate individually — they are redundant with the tag-based market/city tracking. Confirm with Andy before migrating any per-event custom fields.

---

## 3. Tags — Full Taxonomy

Tags are the primary classification system in GHL. They must be decoded and mapped to structured HubSpot properties during transform.

### 3a. Buyer Tier → `buyer_tier` (custom dropdown)

| GHL Tag | HubSpot Value | Notes |
|---|---|---|
| `wb` | `Workshop Buyer` | Tier 1 — highest priority migration |
| `wb_diamond` | `Workshop Buyer - Diamond` | Premium workshop buyer |
| `phase-preview-buyer` | `Preview Buyer` | Tier 2 |
| `phase_preview-reg` | `Preview Registrant` | Registered but not yet buyer |
| `phase_preview-attendee` | `Preview Attendee` | Attended preview event |
| `phase_preview-non-attendee` | `Preview Non-Attendee` | Registered, did not attend |
| `pna` | `Preview Non-Attendee` | Shorthand alias for above |
| `community_newmember` | `Registrant` | Tier 3 — general community member |
| `community_newmember_directsignup` | `Registrant` | Direct signup variant |
| `telesales_sold` | `Telesales Buyer` | Sold via phone |
| `telesales_diamond` | `Telesales Diamond Buyer` | Diamond sold via telesales |
| `telesales_diamond-elite-program` | `Telesales Diamond Elite` | Elite tier |

**Logic**: A contact may have multiple tier tags (upgrade history). Use the highest tier present as the `buyer_tier` value. Priority order: `wb_diamond` > `wb` > `telesales_diamond` > `telesales_sold` > `phase-preview-buyer` > `phase_preview-attendee` > `phase_preview-reg` > `community_newmember`

### 3b. Market / City → `market_city` (custom dropdown)

Tags follow the pattern `YYYYMMDD_CITYCODE` (e.g. `20260427_pit`). Extract the city code suffix.

| Airport Code | City | Airport Code | City |
|---|---|---|---|
| `hnl` | Honolulu, HI | `pit` | Pittsburgh, PA |
| `orf` | Norfolk, VA | `dtw` | Detroit, MI |
| `jfk` | New York, NY | `lax` | Los Angeles, CA |
| `fre` | Fresno, CA | `sat` | San Antonio, TX |
| `aus` | Austin, TX | `cae` | Columbia, SC |
| `phl` | Philadelphia, PA | `cle` | Cleveland, OH |
| `ind` | Indianapolis, IN | `sba` | Santa Barbara, CA |
| `san` | San Diego, CA | `lbb` | Lubbock, TX |
| `ccr` | Concord, CA | `ord` | Chicago, IL |
| `phx` | Phoenix, AZ | `mnh` | Manhasset, NY |

**Logic**: A contact may have multiple city tags (attended multiple markets). Store the most recent (by date prefix). Flag multi-market contacts for Fulfillment team review.

**Session time variants** (e.g. `hnl20251002a-6p`): These are session-specific sub-tags — extract city code only, ignore date/time/session suffix.

### 3c. Engagement Status → `hs_email_optout` + HubSpot subscription preferences

| GHL Tag | Maps To | Action |
|---|---|---|
| `e2i-email engaged` | email subscription active | No change |
| `e2i-email unengaged` | low engagement | Tag in HubSpot for suppression list |
| `e2i-email unsubscribe` | `hs_email_optout = true` | Set opt-out on contact |
| `e2i-sms engaged` | SMS subscription active | No change |
| `e2i-sms unengaged` | low SMS engagement | Tag in HubSpot |

### 3d. Guest / Association → `guest_of` (contact association)

| GHL Tag | Meaning | Action |
|---|---|---|
| `preview_guest` | Attending as a guest | Build contact-to-contact `guest_of` association |
| `preview_guest_is-buyer` | Guest who is also a buyer | Associate AND set buyer tier |
| `guest_confirmed` | Guest confirmed attendance | Note on contact |
| `phase_preview-reg-guest` | Guest registered for preview | Confirm primary contact link |
| `guestpostreg_YYMMDD` | Guest post-registration date | Date stamp of guest reg |

**Action**: Contacts with `preview_guest` tag must have a `guest_of` association built to their primary (host) contact. This requires a separate association pass after contacts are loaded. The `Preview Guest - Group` custom field (`contact.preview_guest__group`) likely holds the primary contact reference — verify with Andy.

### 3e. Fulfillment Status → `fulfillment_status` (custom dropdown)

| GHL Tag | HubSpot Value | Notes |
|---|---|---|
| `coaching_sessions_purchased` | `Coaching Purchased` | Has active coaching package |
| `coaching_user_created_in_tlc` | `Coaching Active` | Account created in coaching system |
| `community-assign-space` | `Community Active` | Space assigned in community |
| `user_created` | `Portal Active` | User portal account created |
| `marketplace_account` | `Marketplace Active` | Marketplace access granted |
| `user_subscribed` | `Subscribed` | Active subscription |

### 3f. Cancellation Status → `cancellation_status` (custom dropdown)

| GHL Tag | HubSpot Value | Notes |
|---|---|---|
| `workshop_cancel_reg` | `Workshop Cancelled` | Cancelled workshop |
| `foundations_cancel_reg` | `Foundations Cancelled` | Cancelled foundations course |
| `all_products_cancelled` | `All Cancelled` | Full cancellation — critical for Restructure team |

### 3g. System / Migration Tags → Skip or internal use only

| GHL Tag | Action |
|---|---|
| `hs_transfer` | **SKIP** — marks contacts already migrated. Use as filter to avoid re-migrating. |
| `removed_from_ot` | Skip — GHL order tracking internal |
| `pb` | Skip — PhoneBurner dialer marker |
| `pb_YYYYMMDD_CITYCODE` | Skip — call record marker |
| `sent-post-event-survey` | Skip — GHL automation marker |
| `addressform_nothanks` | Skip — declined address collection form |
| `reg_confirm_sms_test` | Skip — test tag |
| `fbla-messenger-sequence-v1` | Skip — GHL messenger automation |
| `fbla-messenger-sequence-v1-replied` | Skip |
| `202XXX_phoneburner_*` | Skip — PhoneBurner call log tags |

### 3h. Unknown / Needs Confirmation

| GHL Tag | Status | Action |
|---|---|---|
| `pre_community_subjtest_sequence` | ❓ Unknown | Ask Andy — A/B test tag? |
| `pre_community_subjtest_community` | ❓ Unknown | Ask Andy |
| `user_cart_abandoned` | ❓ Partial | Cart abandon tracking — ask if needed in HubSpot |
| `preview_app_atteded` | ❓ Typo | Likely `preview_app_attended` — confirm |
| `preview_app_registered` | ✅ Clear | Registered via app — map to `attendance_origin` |

---

## 4. Attributions → `registration_source`

`attributions` is an array. First entry (`isFirst: true`) = original source. Last entry (`isLast: true`) = converting touchpoint.

| Attribution Field | HubSpot Property | Notes |
|---|---|---|
| `attributions[0].utmSessionSource` | `registration_source` | "Paid Search", "Social media", "Third Party", "CRM Workflows" |
| `attributions[0].medium` | `registration_medium` | "facebook", "zapier", "form", "survey" |
| `attributions[0].utmCampaign` | `hs_analytics_last_url` or notes | Campaign name e.g. `20260427_pit` |
| `attributions[last].pageUrl` | `hs_analytics_last_url` | Last page visited before conversion |

---

## 5. Opportunities → HubSpot Deals

| GHL Field | HubSpot Deal Property | Notes |
|---|---|---|
| `name` | `dealname` | Contact name as deal name |
| `monetaryValue` | `amount` | 0 on all sampled — confirm real values exist |
| `status` | `dealstage` | "open" → active stage, "lost" → closed lost |
| `source` | `deal_source` | "Facebook", "Marketplace", "5.3 - Cancellation Form" etc |
| `createdAt` | `createdate` | |
| `pipelineId` | `pipeline` | 11 pipelines — see pipeline map below |

**Pipeline mapping** (GHL → HubSpot):

| GHL Pipeline | GHL Stages | HubSpot Deal Pipeline |
|---|---|---|
| 1 - Preview Registrants | Registered → PNA → Checked In → PA → PNB → Pender → PB → Open Ticket | Preview Pipeline |
| 1.1 PNA Webinar | (to confirm) | PNA Webinar Pipeline |
| _(9 more pipelines)_ | (see ghl-pipelines.json) | (to map after Monday meeting) |

> **Total opportunities: 798,008** — nearly 800K deals to migrate, separate from the 897K contacts.

---

## 6. Custom Properties to Create in HubSpot

These do not exist yet (HubSpot portal has 0 custom properties).

| Property Name | Internal Name | Type | Options / Notes |
|---|---|---|---|
| GHL Contact ID | `ghl_contact_id` | Single-line text | For rollback + reconciliation |
| Buyer Tier | `buyer_tier` | Dropdown | Workshop Buyer, Workshop Buyer - Diamond, Preview Buyer, Preview Registrant, Preview Attendee, Preview Non-Attendee, Telesales Buyer, Telesales Diamond, Registrant |
| Market City | `market_city` | Dropdown | Honolulu, Pittsburgh, Norfolk, Detroit, New York, Los Angeles, Fresno, San Antonio, Austin, Columbia, Philadelphia, Cleveland, Indianapolis, Santa Barbara, San Diego, Lubbock, Concord, Chicago, Phoenix + more |
| Event Type | `event_type` | Dropdown | Workshop, Preview, Masterclass, Commercial, Expo, Fly Out, Foundations |
| Attendance Status | `attendance_status` | Dropdown | Registered, Attended, Non-Attendee, Guest, Cancelled |
| Registration Source | `registration_source` | Single-line text | From `attributions[0].utmSessionSource` |
| Registration Medium | `registration_medium` | Single-line text | From `attributions[0].medium` |
| Payment Status | `payment_status` | Dropdown | Paid, Pending, Refunded, Failed (from GHL `workshop_payment_status`) |
| Payment Balance | `payment_balance` | Number | From GHL `workshop_payment_balance` |
| Community Join Date | `community_join_date` | Date | Unix ms → ISO date |
| SMS Engagement Score | `sms_engagement_score` | Number | From GHL `sms_engmt_score` |
| Email Engagement Score | `email_engagement_score` | Number | From GHL `email_engmt_score` |
| Cancellation Status | `cancellation_status` | Dropdown | Workshop Cancelled, Foundations Cancelled, All Cancelled |
| Fulfillment Status | `fulfillment_status` | Dropdown | Coaching Purchased, Coaching Active, Community Active, Portal Active, Marketplace Active, Subscribed |

---

## 7. Status Legend

| Symbol | Meaning |
|---|---|
| ✅ Matched | GHL field maps directly to an existing HubSpot property |
| 🔨 Needs creation | Must create a new HubSpot custom property before migration |
| ⚠️ Gap or constraint | Exists in both systems but needs special handling |
| ❌ Skip | Not migrated |
| ❓ Investigate | Unclear — needs confirmation from Andy or client |
