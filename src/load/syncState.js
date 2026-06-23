import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { logger } from '../utils/logger.js';

const MAX_RUN_HISTORY = 30;

/**
 * Persistent sync watermark + run history for the daily sync.
 *
 * Shape:
 *   {
 *     lastSyncAt: "2026-06-18T09:00:00.000Z" | null,
 *     runs: [ { startedAt, finishedAt, ok, window:{since,until}, updated, inserted,
 *               failed, skipped, withheld, error } ]   // newest first, capped
 *   }
 *
 * `lastSyncAt` is the contract that makes the sync idempotent: it advances ONLY
 * after a run the pipeline judged successful, so a failed or crashed run re-pulls
 * the same window next time instead of silently skipping it.
 */
export class SyncState {
  /** @param {string} filePath - Path to sync-state.json */
  constructor(filePath) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
  }

  /** @returns {{ lastSyncAt: string|null, runs: Array }} */
  load() {
    if (existsSync(this.filePath)) {
      try { return JSON.parse(readFileSync(this.filePath, 'utf-8')); }
      catch { logger.warn(`sync-state unreadable at ${this.filePath} — treating as empty`); }
    }
    return { lastSyncAt: null, runs: [] };
  }

  /** @returns {string|null} */
  getLastSyncAt() {
    return this.load().lastSyncAt;
  }

  /**
   * Persist a run summary. Advances lastSyncAt to `advanceTo` ONLY when the run
   * succeeded (summary.ok) and an advanceTo is provided.
   *
   * @param {Object} summary - Run summary to prepend to history.
   * @param {Object} [opts]
   * @param {string|null} [opts.advanceTo] - ISO watermark to advance to on success.
   * @returns {Object} the new state
   */
  recordRun(summary, { advanceTo = null } = {}) {
    const state = this.load();
    state.runs = [summary, ...(state.runs ?? [])].slice(0, MAX_RUN_HISTORY);
    if (summary.ok && advanceTo) {
      state.lastSyncAt = advanceTo;
      logger.info(`sync-state: watermark advanced to ${advanceTo}`);
    } else {
      logger.warn(`sync-state: watermark held at ${state.lastSyncAt ?? 'unset'} (run ok=${summary.ok}) — window will be retried`);
    }
    this.save(state);
    return state;
  }

  save(state) {
    writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }
}
