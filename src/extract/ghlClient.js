import axios from 'axios';
import { logger } from '../utils/logger.js';

const GHL_BASE_URL = process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
const GHL_VERSION = process.env.GHL_VERSION || '2021-07-28';
const ENGAGER_TOKEN_URL = process.env.GHL_ENGAGER_TOKEN_URL || 'https://api.engager.ai/get-token';

/**
 * Fetches a Bearer token from the Engager token service.
 * @param {string} secretKey - The Engager secret key from .env
 * @returns {Promise<string>} Bearer token
 */
async function fetchEngagerToken(secretKey) {
  const response = await axios.get(`${ENGAGER_TOKEN_URL}/${secretKey}`);
  const token = response.data?.token ?? response.data;
  if (!token) throw new Error('Engager token response missing token field');
  return token;
}

/**
 * GoHighLevel REST API client (via LeadConnector / Engager)
 * Base URL: https://services.leadconnectorhq.com
 * Auth: Bearer token obtained from https://api.engager.ai/get-token/{secret_key}
 * Version header: 2021-07-28
 */
export class GHLClient {
  /**
   * @param {Object} config
   * @param {string} config.engagerSecretKey - Secret key for Engager token endpoint
   * @param {string} config.locationId - GHL location ID scoping all queries
   */
  constructor(config) {
    this.engagerSecretKey = config.engagerSecretKey;
    this.locationId = config.locationId;
    this._token = null;
    this._client = null;
  }

  /**
   * Initialises the axios client with a fresh Engager token.
   * Call once before making requests; token is cached for the session.
   * @returns {Promise<void>}
   */
  async init() {
    this._token = await fetchEngagerToken(this.engagerSecretKey);
    this._client = axios.create({
      baseURL: GHL_BASE_URL,
      headers: {
        Authorization: `Bearer ${this._token}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
      },
    });
    logger.info('GHLClient initialised with Engager token');
  }

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
      const response = await client.get(`/contacts/${contactId}`);
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
}
