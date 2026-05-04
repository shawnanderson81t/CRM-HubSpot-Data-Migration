import { createLogger, format, transports } from 'winston';
import { mkdirSync } from 'fs';

mkdirSync('./logs', { recursive: true });

export const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.File({ filename: './logs/error.log', level: 'error' }),
    new transports.File({ filename: './logs/migration.log' }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}]: ${message}${metaStr}`;
        })
      ),
    }),
  ],
});

/**
 * Create a batch-specific logger for tracking individual batch results
 * @param {string} tierName - e.g. "tier1", "tier2"
 * @param {number} batchNumber
 * @returns {Object} Logger instance
 */
export function createBatchLogger(tierName, batchNumber) {
  return createLogger({
    level: 'info',
    format: format.combine(format.timestamp(), format.json()),
    transports: [
      new transports.File({
        filename: `./logs/${tierName}-batch-${batchNumber}.log`,
      }),
    ],
  });
}
