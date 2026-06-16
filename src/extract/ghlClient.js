import axios from 'axios';
import { logger } from '../utils/logger.js';

const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_VERSION  = process.env.GHL_VERSION  || '2021-07-28';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Retry an async fn up to maxAttempts times, backing off on 429.
 * Respects Retry-After header when present.
 */
async function withRetry(fn, { maxAttempts = 5, baseDelayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      // Retry on 429 (rate limit), transient 5xx (GHL gateway hiccups), or
      // SSL/network errors (no HTTP status — transient on the remote machine).
      const isRetryable = status === 429 || (status >= 500 && status < 600) || !status;
      if (isRetryable && attempt < maxAttempts) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
        const delay = retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * attempt;
        logger.warn(`GHL ${status ?? 'SSL/network'} error — retry ${attempt}/${maxAttempts - 1} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

/**
 * GoHighLevel REST API client
 * Auth: Private Integration Token used directly as Bearer (GHL Settings > Private Integrations)
 */
export class GHLClient {
  /**
   * @param {Object} config
   * @param {string} config.apiKey - GHL Private Integration Token
   * @param {string} config.locationId - GHL location ID scoping all queries
   */
  constructor(config) {
    this.locationId = config.locationId;
    this._client = axios.create({
      baseURL: GHL_BASE_URL,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
      },
    });
    logger.info('GHLClient initialised');
  }

  /**
   * @deprecated No longer needed — kept as no-op for backwards compatibility
   * @returns {Promise<void>}
   */
  async init() {}

  /**
   * Returns the initialised axios client, throwing if init() was not called.
   * @returns {import('axios').AxiosInstance}
   */
  _getClient() {
    if (!this._client) throw new Error('GHLClient not initialised — call init() first');
    return this._client;
  }

  /**
   * Fetch a single contact by ID.
   * @param {string} contactId - GHL contact ID
   * @returns {Promise<Object>} GHL contact object
   */
  async getContact(contactId) {
    const client = this._getClient();
    try {
      const response = await withRetry(() => client.get(`/contacts/${contactId}`));
      return response.data?.contact ?? response.data;
    } catch (err) {
      throw new Error(`Failed to fetch contact ${contactId}: ${err.message}`);
    }
  }

  /**
   * Fetch all contacts for the location using cursor-based pagination.
   * GHL returns up to 100 contacts per page; iterates until exhausted.
   * @param {Object} [options]
   * @param {number} [options.limit=100] - Page size (max 100)
   * @param {Function} [options.onBatch] - Called with each page array as it arrives
   * @returns {Promise<Array>} All contact objects for the location
   */
  async getContacts({ limit = 100, onBatch } = {}) {
    const client = this._getClient();
    const all = [];
    let startAfterId = null;
    let page = 1;

    while (true) {
      const params = { locationId: this.locationId, limit };
      if (startAfterId) params.startAfterId = startAfterId;

      let response;
      try {
        response = await client.get('/contacts/', { params });
      } catch (err) {
        throw new Error(`Failed to fetch contacts page ${page}: ${err.message}`);
      }

      const contacts = response.data?.contacts ?? [];
      const meta = response.data?.meta ?? {};

      if (contacts.length === 0) break;

      all.push(...contacts);
      if (onBatch) await onBatch(contacts, { page, total: meta.total });

      logger.info(`GHL contacts fetched: page ${page}, batch ${contacts.length}, running total ${all.length}`);

      // Cursor for next page — GHL uses startAfterId when available
      startAfterId = meta.startAfterId ?? null;
      if (!startAfterId || contacts.length < limit) break;

      page++;
    }

    logger.info(`GHL contact extraction complete — ${all.length} total contacts`);
    return all;
  }

  /**
   * Coerce a Date / ISO string / epoch into an ISO-8601 string, with a clear error.
   * @param {Date|string|number} value
   * @param {string} label - Used in the error message for context
   * @returns {string} ISO-8601 timestamp
   */
  _toIso(value, label) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`getContactsChangedSince: invalid '${label}' value: ${JSON.stringify(value)}`);
    }
    return d.toISOString();
  }

  /**
   * Fetch one page of POST /contacts/search filtered by a `dateUpdated` range.
   * Retries 429 / 5xx / network via withRetry.
   *
   * @param {{ gte: string, lte: string }} window - ISO range bounds (both inclusive)
   * @param {number} page - 1-based page number
   * @param {number} pageLimit - Page size (max 100)
   * @returns {Promise<{ contacts: Array, total: number }>}
   */
  async _searchByDateUpdated(window, page, pageLimit) {
    const client = this._getClient();
    try {
      const res = await withRetry(() =>
        client.post('/contacts/search', {
          locationId: this.locationId,
          filters: [
            { field: 'dateUpdated', operator: 'range', value: { gte: window.gte, lte: window.lte } },
          ],
          pageLimit,
          page,
        })
      );
      return { contacts: res.data?.contacts ?? [], total: res.data?.total ?? 0 };
    } catch (err) {
      throw new Error(
        `contacts/search dateUpdated [${window.gte}..${window.lte}] page ${page} failed: ${err.message}`
      );
    }
  }

  /**
   * Fetch every contact whose GHL `dateUpdated` (modification time) falls within
   * [since, until]. This is the delta-detection primitive for the nightly sync —
   * it surfaces edits to existing contacts, not just newly created ones.
   *
   * `dateUpdated` is the only modification-date field GHL's search accepts
   * (confirmed by probe against PROD). A single search query is capped at ~10,000
   * results (100 pages × 100). To stay under that cap for any window size — a
   * 1-day nightly delta or a multi-week backfill — the window is split
   * adaptively: when GHL reports more than the cap for a window, the window is
   * bisected in time and each half is fetched recursively. Results are
   * de-duplicated by contact id, so the inclusive boundary between halves is safe.
   *
   * Read-only: issues only POST /contacts/search; never writes.
   *
   * @param {Date|string|number} since - Inclusive lower bound (gte) on dateUpdated.
   * @param {Object} [options]
   * @param {Date|string|number} [options.until=new Date()] - Inclusive upper bound (lte). Capture once at run start.
   * @param {string[]} [options.excludeTags=[]] - Drop contacts carrying any of these tags (reverse-sync loop guard, e.g. 'hs-to-hl'). Filtered in memory — GHL has no server-side tag exclusion.
   * @param {number} [options.pageLimit=100] - Page size (max 100).
   * @param {number} [options.pageDelayMs=150] - Pause between page requests, to stay gentle on the API.
   * @param {Function} [options.onBatch] - async (contacts, window) called per page AFTER exclude-tag filtering — lets the caller stream to disk instead of buffering.
   * @param {Function} [options.onProgress] - ({ collected, scanned, window }) called per page.
   * @returns {Promise<Array>} De-duplicated contacts modified within [since, until].
   */
  async getContactsChangedSince(since, {
    until = new Date(),
    excludeTags = [],
    pageLimit = 100,
    pageDelayMs = 150,
    onBatch,
    onProgress,
  } = {}) {
    const gte = this._toIso(since, 'since');
    const lte = this._toIso(until, 'until');
    if (Date.parse(gte) > Date.parse(lte)) {
      throw new Error(`getContactsChangedSince: 'since' (${gte}) is after 'until' (${lte})`);
    }

    const MAX_PER_QUERY = 10000;   // GHL hard cap: 100 pages × 100
    const MIN_WINDOW_MS = 60 * 1000; // floor for time-bisection (don't split below 1 min)

    const excludeSet = new Set(excludeTags);
    const contactMap = new Map(); // id → contact (dedup across bisected windows)
    let scanned = 0;

    const ingest = async (contacts, window) => {
      const kept = excludeSet.size
        ? contacts.filter(c => !(c.tags ?? []).some(t => excludeSet.has(t)))
        : contacts;
      for (const c of kept) {
        if (c.id && !contactMap.has(c.id)) contactMap.set(c.id, c);
      }
      scanned += contacts.length;
      if (onBatch && kept.length) await onBatch(kept, window);
      if (onProgress) onProgress({ collected: contactMap.size, scanned, window });
    };

    const collectWindow = async (wGte, wLte) => {
      const window = { gte: wGte, lte: wLte };
      const first = await this._searchByDateUpdated(window, 1, pageLimit);

      // Adaptive split: too many results for one query → bisect the time window.
      if (first.total > MAX_PER_QUERY && (Date.parse(wLte) - Date.parse(wGte)) > MIN_WINDOW_MS) {
        const mid = new Date(Math.floor((Date.parse(wGte) + Date.parse(wLte)) / 2)).toISOString();
        logger.info(`getContactsChangedSince: window [${wGte}..${wLte}] has ${first.total} (> ${MAX_PER_QUERY}) — bisecting at ${mid}`);
        await collectWindow(wGte, mid);
        await collectWindow(mid, wLte); // both ends inclusive; dedup by id absorbs the boundary
        return;
      }

      await ingest(first.contacts, window);

      let page = 1;
      let lastCount = first.contacts.length;
      while (lastCount === pageLimit) {
        if (page >= 100) {
          logger.warn(`getContactsChangedSince: window [${wGte}..${wLte}] hit the 100-page cap (total=${first.total}); narrowing failed — some edits may be unfetched`);
          break;
        }
        page++;
        if (pageDelayMs) await sleep(pageDelayMs);
        const next = await this._searchByDateUpdated(window, page, pageLimit);
        await ingest(next.contacts, window);
        lastCount = next.contacts.length;
      }
    };

    logger.info(`getContactsChangedSince: scanning dateUpdated in [${gte}..${lte}], excludeTags=[${excludeTags.join(',')}]`);
    await collectWindow(gte, lte);

    const result = [...contactMap.values()];
    logger.info(`getContactsChangedSince: ${result.length} unique changed contacts (scanned ${scanned} rows)`);
    return result;
  }

  /**
   * Fetch all custom field definitions for the location.
   * @returns {Promise<Array>} Array of custom field definition objects
   */
  async getCustomFields() {
    const client = this._getClient();
    try {
      const response = await client.get('/custom-fields/', {
        params: { locationId: this.locationId },
      });
      return response.data?.customFields ?? [];
    } catch (err) {
      throw new Error(`Failed to fetch custom fields: ${err.message}`);
    }
  }

  /**
   * Fetch all tags for the location.
   * @returns {Promise<Array>} Array of tag objects
   */
  async getTags() {
    const client = this._getClient();
    try {
      const response = await client.get('/tags/', {
        params: { locationId: this.locationId },
      });
      return response.data?.tags ?? [];
    } catch (err) {
      throw new Error(`Failed to fetch tags: ${err.message}`);
    }
  }

  /**
   * Fetch opportunities (deals) for a specific contact.
   * @param {string} contactId - GHL contact ID
   * @returns {Promise<Array>} Array of opportunity objects
   */
  async getOpportunities(contactId) {
    const client = this._getClient();
    try {
      const response = await client.get('/opportunities/search', {
        params: { contact_id: contactId, location_id: this.locationId },
      });
      return response.data?.opportunities ?? [];
    } catch (err) {
      throw new Error(`Failed to fetch opportunities for contact ${contactId}: ${err.message}`);
    }
  }

  /**
   * Stream all opportunities in a pipeline, returning unique contactIds.
   * Uses cursor-based pagination on /opportunities/search.
   *
   * @param {Object} options
   * @param {string} options.pipelineId - GHL pipeline ID to filter by
   * @param {number} [options.limit=Infinity] - Stop after collecting this many unique contactIds
   * @param {number} [options.pageSize=100] - Page size (max 100)
   * @param {Function} [options.onProgress] - Called with ({ scanned, unique, page }) each page
   * @returns {Promise<string[]>} Array of unique contact IDs
   */
  async getContactIdsByPipeline({ pipelineId, limit = Infinity, pageSize = 100, onProgress } = {}) {
    const client = this._getClient();
    const contactIds = new Set();
    let page = 1;
    let scanned = 0;

    while (contactIds.size < limit) {
      // Opportunities API uses page-number pagination (not startAfterId like contacts)
      const params = {
        location_id: this.locationId,
        pipeline_id: pipelineId,
        limit: pageSize,
        page,
      };

      let response;
      try {
        response = await client.get('/opportunities/search', { params });
      } catch (err) {
        throw new Error(`getContactIdsByPipeline failed on page ${page}: ${err.message}`);
      }

      const opportunities = response.data?.opportunities ?? [];
      scanned += opportunities.length;

      for (const opp of opportunities) {
        if (opp.contactId) contactIds.add(opp.contactId);
        if (contactIds.size >= limit) break;
      }

      if (onProgress) onProgress({ scanned, unique: contactIds.size, page });
      logger.info(`getContactIdsByPipeline page ${page}: scanned ${scanned}, unique contacts ${contactIds.size}`);

      if (opportunities.length < pageSize) break;
      page++;
    }

    logger.info(`getContactIdsByPipeline complete — ${contactIds.size} unique contacts from ${scanned} opportunities`);
    return [...contactIds];
  }

  /**
   * Fetch all pipeline stage definitions for the location.
   * @returns {Promise<Array>} Array of pipeline objects (each with nested stages)
   */
  async getPipelineStages() {
    const client = this._getClient();
    try {
      const response = await client.get('/opportunities/pipelines', {
        params: { locationId: this.locationId },
      });
      return response.data?.pipelines ?? [];
    } catch (err) {
      throw new Error(`Failed to fetch pipeline stages: ${err.message}`);
    }
  }

  /**
   * Stream contacts page by page, filter by tags in memory, stop when limit reached.
   * GHL does not support server-side tag filtering — filtering is applied per batch.
   *
   * @param {Object} options
   * @param {string[]} [options.tags] - Return only contacts that have at least one of these tags
   * @param {string[]} [options.excludeTags] - Skip contacts that have any of these tags
   * @param {number} [options.limit=100] - Stop after collecting this many matching contacts
   * @param {number} [options.pageSize=100] - GHL page size (max 100)
   * @param {Function} [options.onProgress] - Called with ({ scanned, matched, page }) each page
   * @returns {Promise<Array>} Matched contact objects up to limit
   */
  async findContacts({ tags = [], excludeTags = [], limit = 100, pageSize = 100, onProgress } = {}) {
    const client = this._getClient();
    const tagSet = new Set(tags);
    const excludeSet = new Set(excludeTags);
    const matched = [];
    let startAfterId = null;
    let page = 1;
    let scanned = 0;

    while (matched.length < limit) {
      const params = { locationId: this.locationId, limit: pageSize };
      if (startAfterId) params.startAfterId = startAfterId;

      let response;
      try {
        response = await client.get('/contacts/', { params });
      } catch (err) {
        throw new Error(`findContacts failed on page ${page}: ${err.message}`);
      }

      const contacts = response.data?.contacts ?? [];
      const meta = response.data?.meta ?? {};
      scanned += contacts.length;

      for (const contact of contacts) {
        if (matched.length >= limit) break;
        const contactTags = contact.tags ?? [];

        if (excludeSet.size > 0 && contactTags.some(t => excludeSet.has(t))) continue;
        if (tagSet.size > 0 && !contactTags.some(t => tagSet.has(t))) continue;

        matched.push(contact);
      }

      if (onProgress) onProgress({ scanned, matched: matched.length, page });
      logger.info(`findContacts page ${page}: scanned ${scanned}, matched ${matched.length}/${limit}`);

      startAfterId = meta.startAfterId ?? null;
      if (!startAfterId || contacts.length < pageSize) break;
      page++;
    }

    logger.info(`findContacts complete — scanned ${scanned} contacts, returning ${matched.length}`);
    return matched;
  }
}
