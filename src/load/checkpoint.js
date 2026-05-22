import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';

/**
 * Checkpoint manager for tracking migration progress
 * Enables resume-on-failure by persisting batch state to disk
 *
 * State file format:
 * {
 *   tier: 1,
 *   startedAt: "2026-05-11T...",
 *   lastBatch: 14,
 *   totalBatches: 100,
 *   processed: 1400,
 *   succeeded: 1385,
 *   failed: 15,
 *   skipped: 0,
 *   failedRecords: [{ email, error, batchNumber }],
 *   completedAt: null
 * }
 */
export class Checkpoint {
  constructor(tier, dir = './data/checkpoints') {
    this.tier = tier;
    this.dir = dir;
    this.filePath = `${dir}/tier-${tier}-checkpoint.json`;
    mkdirSync(dir, { recursive: true });
  }

  /**
   * Load existing checkpoint or create new one
   * @param {number} totalBatches
   * @returns {Object} Current checkpoint state
   */
  load(totalBatches = 0) {
    if (existsSync(this.filePath)) {
      try {
        const state = JSON.parse(readFileSync(this.filePath, 'utf-8'));
        logger.info(`Resuming tier ${this.tier} from batch ${state.lastBatch + 1}/${state.totalBatches}`);
        return state;
      } catch (e) {
        logger.warn(`Corrupt checkpoint file, starting fresh`);
      }
    }

    const state = {
      tier: this.tier,
      startedAt: new Date().toISOString(),
      lastBatch: -1,
      totalBatches,
      processed: 0,
      updated: 0,
      inserted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      failedRecords: [],
      completedAt: null,
    };
    this.save(state);
    return state;
  }

  /**
   * Update checkpoint after a batch completes
   * @param {Object} state - Current state
   * @param {Object} batchResult - { batchNumber, succeeded, failed, skipped, errors }
   */
  update(state, batchResult) {
    const batchSucceeded = (batchResult.updated ?? 0) + (batchResult.inserted ?? 0) + (batchResult.succeeded ?? 0);
    state.lastBatch  = batchResult.batchNumber;
    state.processed += batchSucceeded + batchResult.failed + batchResult.skipped;
    state.updated   = (state.updated  ?? 0) + (batchResult.updated  ?? 0);
    state.inserted  = (state.inserted ?? 0) + (batchResult.inserted ?? 0);
    state.succeeded  = (state.succeeded ?? 0) + batchSucceeded;
    state.failed    += batchResult.failed;
    state.skipped   += batchResult.skipped;

    if (batchResult.errors) {
      state.failedRecords.push(
        ...batchResult.errors.map((e) => ({
          ...e,
          batchNumber: batchResult.batchNumber,
        }))
      );
    }

    this.save(state);
  }

  /**
   * Mark tier as complete
   * @param {Object} state
   */
  complete(state) {
    state.completedAt = new Date().toISOString();
    this.save(state);
    logger.info(`Tier ${this.tier} complete`, {
      succeeded: state.succeeded,
      failed: state.failed,
      skipped: state.skipped,
      duration: `${state.startedAt} → ${state.completedAt}`,
    });
  }

  save(state) {
    writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }
}
