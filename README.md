# GHL → HubSpot CRM Migration

ETL pipeline for migrating ~850,000 contacts from GoHighLevel to HubSpot.

## Setup

```bash
cp .env.example .env
# Fill in your API keys in .env
npm install
```

## Project Structure

```
src/
├── extract/           # GHL data extraction (API + CSV)
├── transform/         # Field mapping, cleaning, dedup
├── load/              # HubSpot API, batch upsert, checkpointing
├── associations/      # guest_of contact links
├── validation/        # Post-migration QA
└── utils/             # Logger, rate limiter, config

scripts/
├── create-hubspot-properties.js   # Run ONCE before migration
├── pilot-run.js                   # Test with 50-100 contacts
└── migrate-tier.js                # Run per-tier migration
```

## Migration Order

```bash
# 1. Create HubSpot custom properties
npm run create-properties

# 2. Pilot test (50 contacts)
npm run pilot

# 3. Tier 1 — Workshop Buyers (~10K)
npm run migrate:tier1

# 4. Tier 2 — Preview Buyers (~40K)
npm run migrate:tier2

# 5. Tier 3 — General Registrants (~800K)
npm run migrate:tier3

# 6. Validate
npm run validate
```

## Resume on Failure

Each tier saves checkpoints to `data/checkpoints/`. If a migration is interrupted,
re-run the same command — it will resume from the last successful batch.

## Logs

All logs are written to `logs/`. Each batch generates its own log file with
counts of processed, succeeded, failed, and skipped contacts.
