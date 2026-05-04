# CLAUDE.md

This is a CRM data migration project (GoHighLevel → HubSpot). Read `CLAUDE_BRIEF.md` for full project context, architecture, and phase plan before answering any questions.

## Quick Context
- Node.js ES modules project (import/export, async/await)
- ETL pipeline: Extract from GHL API/CSV → Transform → Load to HubSpot API v3
- 850K contacts in 3 tiers (10K → 40K → 800K)
- Deadline: May 30, 2026

## Code Style
- No TypeScript, plain JavaScript with JSDoc
- Use `p-limit` for concurrency, `axios` for HTTP, `winston` for logging
- Every function needs JSDoc with @param and @returns
- Error messages must include context (which contact, batch, field)
- Never overwrite HubSpot data with blanks/nulls from GHL

## Key Files
- `src/transform/fieldMapper.js` — the GHL→HubSpot field mapping (source of truth)
- `src/load/checkpoint.js` — resume-on-failure state management
- `src/load/hubspotClient.js` — HubSpot API v3 wrapper
- `scripts/migrate-tier.js` — main migration execution script

## Commands
- `npm run create-properties` — create HubSpot custom properties
- `npm run pilot` — test with 50 contacts
- `npm run migrate:tier1` — run Tier 1 (10K Workshop Buyers)
- `npm run migrate:tier2` — run Tier 2 (40K Preview Buyers)  
- `npm run migrate:tier3` — run Tier 3 (800K Registrants)
