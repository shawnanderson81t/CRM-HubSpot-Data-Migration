import axios from 'axios';
import { logger } from '../utils/logger.js';

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

/**
 * HubSpot CRM API v3 client.
 *
 * All mutating methods (batchUpdateContacts, batchCreateContacts) use
 * _withRetry() which handles 429 (rate limit) and 5xx with exponential
 * backoff — up to MAX_RETRIES attempts before throwing.
 */
export class HubSpotClient {
  /**
   * @param {Object} config - Output of loadConfig()
   */
  constructor(config) {
    this.client = axios.create({
      baseURL: config.hubspot.baseUrl,
      headers: {
        Authorization: `Bearer ${config.hubspot.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Execute fn() with exponential backoff on 429 and 5xx responses.
   * @param {Function} fn - () => Promise<AxiosResponse>
   * @returns {Promise<AxiosResponse>}
   */
  async _withRetry(fn) {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        const status = err.response?.status;
        const retryable = status === 429 || (status >= 500 && status < 600);
        if (!retryable || attempt >= MAX_RETRIES) throw err;

        const retryAfterSec = parseInt(err.response?.headers?.['retry-after'] || '0');
        const backoff = retryAfterSec > 0
          ? retryAfterSec * 1000
          : INITIAL_BACKOFF_MS * Math.pow(2, attempt);

        logger.warn(`HubSpot ${status} — retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        attempt++;
      }
    }
  }

  /**
   * Batch update existing HubSpot contacts by their HubSpot contact ID.
   * Use this for contacts that already exist in HubSpot (dedup result: updates).
   * Max 100 records per call.
   *
   * @param {Array<{ hubspotId: string, properties: Object }>} records
   * @returns {Promise<{ succeeded: number, failed: number, errors: Array }>}
   */
  async batchUpdateContacts(records) {
    const inputs = records.map(r => ({ id: r.hubspotId, properties: r.properties }));
    try {
      const { data } = await this._withRetry(() =>
        this.client.post('/crm/v3/objects/contacts/batch/update', { inputs })
      );
      return { succeeded: (data.results || []).length, failed: 0, errors: [] };
    } catch (err) {
      logger.error('batchUpdateContacts failed', {
        status: err.response?.status,
        detail: err.response?.data?.message,
        count: records.length,
      });
      return {
        succeeded: 0,
        failed: records.length,
        errors: records.map(r => ({
          hubspotId: r.hubspotId,
          reason: err.response?.data?.message || err.message,
        })),
      };
    }
  }

  /**
   * Batch create new HubSpot contacts.
   * Use for contacts with no existing HubSpot record (dedup result: inserts).
   * Max 100 records per call.
   *
   * @param {Array<{ properties: Object }>} records
   * @returns {Promise<{ succeeded: number, failed: number, errors: Array }>}
   */
  async batchCreateContacts(records) {
    const inputs = records.map(r => ({ properties: r.properties }));
    try {
      const { data } = await this._withRetry(() =>
        this.client.post('/crm/v3/objects/contacts/batch/create', { inputs })
      );
      return { succeeded: (data.results || []).length, failed: 0, errors: [] };
    } catch (err) {
      logger.error('batchCreateContacts failed', {
        status: err.response?.status,
        detail: err.response?.data?.message,
        count: records.length,
      });
      return {
        succeeded: 0,
        failed: records.length,
        errors: records.map(r => ({
          email: r.properties.email,
          reason: err.response?.data?.message || err.message,
        })),
      };
    }
  }

  /**
   * Batch read HubSpot contacts by any indexed property.
   * Used to build the existingMap for dedup — call once per batch
   * for each identifier type (email, phone, engager_contact_id).
   * Max 100 ids per call.
   *
   * @param {string[]} ids - Values to look up
   * @param {string} idProperty - 'email' | 'phone' | 'engager_contact_id' | 'hs_object_id'
   * @param {string[]} [propList] - Properties to return on each contact
   * @returns {Promise<Array<{ id: string, properties: Object }>>}
   */
  async batchReadContacts(
    ids,
    idProperty = 'email',
    propList = ['email', 'phone', 'engager_contact_id']
  ) {
    if (!ids.length) return [];
    try {
      const { data } = await this._withRetry(() =>
        this.client.post('/crm/v3/objects/contacts/batch/read', {
          idProperty,
          inputs: ids.map(id => ({ id: String(id) })),
          properties: propList,
        })
      );
      return data.results || [];
    } catch (err) {
      logger.error('batchReadContacts failed', {
        idProperty,
        status: err.response?.status,
        detail: err.response?.data?.message,
      });
      return [];
    }
  }

  /**
   * Create a contact-to-contact association (guest_of custom type).
   *
   * @param {string} fromId - Guest HubSpot contact ID
   * @param {string} toId - Primary attendee HubSpot contact ID
   * @param {number} associationTypeId - Custom association type numeric ID
   */
  async createAssociation(fromId, toId, associationTypeId) {
    try {
      await this._withRetry(() =>
        this.client.put(
          `/crm/v4/objects/contacts/${fromId}/associations/contacts/${toId}`,
          [{ associationCategory: 'USER_DEFINED', associationTypeId }]
        )
      );
    } catch (err) {
      logger.error('createAssociation failed', { fromId, toId, error: err.message });
      throw err;
    }
  }

  /**
   * Get all HubSpot owners — used to build the GHL user → HubSpot owner map.
   *
   * @returns {Promise<Array<{ id: string, email: string, firstName: string, lastName: string }>>}
   */
  async getOwners() {
    try {
      const { data } = await this._withRetry(() =>
        this.client.get('/crm/v3/owners', { params: { limit: 500 } })
      );
      return data.results || [];
    } catch (err) {
      logger.error('getOwners failed', { error: err.message });
      return [];
    }
  }

  /**
   * Create a custom contact property. Skips silently on 409 (already exists).
   *
   * @param {Object} property - { name, label, type, fieldType, groupName, options? }
   * @returns {Promise<Object|null>}
   */
  async createProperty(property) {
    try {
      const { data } = await this._withRetry(() =>
        this.client.post('/crm/v3/properties/contacts', property)
      );
      logger.info(`Created property: ${property.name}`);
      return data;
    } catch (err) {
      if (err.response?.status === 409) {
        logger.info(`Property already exists: ${property.name}`);
        return null;
      }
      throw err;
    }
  }

  /**
   * Get all contact properties (used for schema comparison).
   *
   * @returns {Promise<Array>}
   */
  async getProperties() {
    const { data } = await this._withRetry(() =>
      this.client.get('/crm/v3/properties/contacts')
    );
    return data.results || [];
  }
}
