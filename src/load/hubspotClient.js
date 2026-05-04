import axios from 'axios';
import { logger } from '../utils/logger.js';

/**
 * HubSpot CRM API v3 client
 * Handles contacts, properties, associations, and engagements
 */
export class HubSpotClient {
  constructor(config) {
    this.accessToken = config.hubspot.accessToken;
    this.baseUrl = config.hubspot.baseUrl;
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    // Retry on 429 (rate limit)
    this.client.interceptors.response.use(null, async (error) => {
      if (error.response?.status === 429) {
        const retryAfter = parseInt(error.response.headers['retry-after'] || '1') * 1000;
        logger.warn(`Rate limited, retrying after ${retryAfter}ms`);
        await new Promise((r) => setTimeout(r, retryAfter));
        return this.client.request(error.config);
      }
      throw error;
    });
  }

  /**
   * Batch create/update contacts (upsert)
   * HubSpot batch endpoint: POST /crm/v3/objects/contacts/batch/upsert
   * Max 100 contacts per request
   *
   * @param {Array} contacts - Array of { properties: {...}, id (optional) }
   * @returns {Promise<Object>} { results, errors }
   */
  async batchUpsertContacts(contacts) {
    const inputs = contacts.map((c) => ({
      idProperty: 'email',
      id: c.properties.email,
      properties: c.properties,
    }));

    try {
      const { data } = await this.client.post(
        '/crm/v3/objects/contacts/batch/upsert',
        { inputs }
      );
      return { results: data.results || [], errors: [] };
    } catch (error) {
      logger.error('Batch upsert failed', {
        status: error.response?.status,
        message: error.response?.data?.message,
        count: contacts.length,
      });
      return { results: [], errors: [error.response?.data || error.message] };
    }
  }

  /**
   * Create a custom property in HubSpot
   * @param {Object} property - { name, label, type, fieldType, groupName, options }
   * @returns {Promise<Object>} Created property
   */
  async createProperty(property) {
    try {
      const { data } = await this.client.post(
        '/crm/v3/properties/contacts',
        property
      );
      logger.info(`Created property: ${property.name}`);
      return data;
    } catch (error) {
      if (error.response?.status === 409) {
        logger.info(`Property already exists: ${property.name}`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Fetch existing contacts by email for dedup matching
   * @param {string[]} emails - Array of email addresses
   * @returns {Promise<Map>} Map of email → hubspotId
   */
  async getContactsByEmails(emails) {
    const map = new Map();
    // Batch read endpoint: POST /crm/v3/objects/contacts/batch/read
    try {
      const { data } = await this.client.post(
        '/crm/v3/objects/contacts/batch/read',
        {
          idProperty: 'email',
          inputs: emails.map((e) => ({ id: e })),
          properties: ['email', 'phone'],
        }
      );
      for (const contact of data.results || []) {
        if (contact.properties?.email) {
          map.set(contact.properties.email.toLowerCase(), contact.id);
        }
      }
    } catch (error) {
      logger.error('Batch read failed', { error: error.message });
    }
    return map;
  }

  /**
   * Create a contact-to-contact association (guest_of)
   * @param {string} fromContactId - Guest contact HubSpot ID
   * @param {string} toContactId - Primary contact HubSpot ID
   * @param {string} associationTypeId - Custom association type ID
   * @returns {Promise<Object>}
   */
  async createAssociation(fromContactId, toContactId, associationTypeId) {
    try {
      const { data } = await this.client.put(
        `/crm/v4/objects/contacts/${fromContactId}/associations/contacts/${toContactId}`,
        [{ associationCategory: 'USER_DEFINED', associationTypeId }]
      );
      return data;
    } catch (error) {
      logger.error('Association failed', {
        from: fromContactId,
        to: toContactId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get all contact properties (for schema audit)
   * @returns {Promise<Array>}
   */
  async getProperties() {
    const { data } = await this.client.get('/crm/v3/properties/contacts');
    return data.results || [];
  }
}
