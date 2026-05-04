import axios from 'axios';
import { logger } from '../utils/logger.js';

/**
 * GoHighLevel REST API client
 * Handles extraction of contacts, opportunities, and custom fields
 */
export class GHLClient {
  constructor(config) {
    this.apiKey = config.ghl.apiKey;
    this.baseUrl = config.ghl.baseUrl;
    this.locationId = config.ghl.locationId;
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
  }

  /**
   * Fetch all contacts with pagination
   * @param {Object} options - { limit, offset, query }
   * @returns {Promise<Array>} Array of GHL contact objects
   */
  async getContacts(options = {}) {
    // TODO: Implement with pagination
    // GHL API paginates — need to loop until no more results
    throw new Error('Not implemented — waiting for GHL API access to confirm endpoint structure');
  }

  /**
   * Fetch all custom fields for the location
   * @returns {Promise<Array>} Array of custom field definitions
   */
  async getCustomFields() {
    // TODO: GET /custom-fields
    throw new Error('Not implemented');
  }

  /**
   * Fetch all tags for the location
   * @returns {Promise<Array>} Array of tag objects
   */
  async getTags() {
    // TODO: GET /tags
    throw new Error('Not implemented');
  }

  /**
   * Fetch opportunities (deals) for a contact
   * @param {string} contactId
   * @returns {Promise<Array>} Array of opportunity objects
   */
  async getOpportunities(contactId) {
    // TODO: GET /opportunities
    throw new Error('Not implemented');
  }

  /**
   * Fetch all pipeline stages
   * @returns {Promise<Array>} Array of pipeline stage objects
   */
  async getPipelineStages() {
    // TODO: GET /pipelines
    throw new Error('Not implemented');
  }
}
