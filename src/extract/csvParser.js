import { createReadStream } from 'fs';
import { parse } from 'csv-parse';
import { logger } from '../utils/logger.js';

/**
 * Parse GHL CSV export files as fallback extraction method
 * Use this if GHL API doesn't expose all required fields
 *
 * @param {string} filePath - Path to CSV file
 * @param {Object} options - { delimiter, columns, skipEmpty }
 * @returns {Promise<Array>} Parsed contact records
 */
export async function parseGHLExport(filePath, options = {}) {
  const records = [];
  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter: options.delimiter || ',',
      ...options,
    })
  );

  for await (const record of parser) {
    records.push(record);
  }

  logger.info(`Parsed ${records.length} records from ${filePath}`);
  return records;
}
