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
      if (status === 429 && attempt < maxAttempts) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
        const delay = retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * attempt;
        logger.warn(`GHL 429 rate limit — retry ${attempt}/${maxAttempts - 1} in ${delay}ms`);
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
