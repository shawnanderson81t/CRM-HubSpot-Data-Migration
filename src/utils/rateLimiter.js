import pLimit from 'p-limit';

/**
 * Creates a rate-limited request executor
 * HubSpot limits: 100 requests / 10 seconds (free), higher for paid tiers
 *
 * @param {number} maxConcurrent - Max concurrent requests
 * @param {number} delayMs - Delay between batches in milliseconds
 * @returns {Object} Rate limiter with execute method
 */
export function createRateLimiter(maxConcurrent = 10, delayMs = 150) {
  const limit = pLimit(maxConcurrent);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    /**
     * Execute a function with rate limiting
     * @param {Function} fn - Async function to execute
     * @returns {Promise} Result of fn
     */
    async execute(fn) {
      return limit(async () => {
        const result = await fn();
        await sleep(delayMs);
        return result;
      });
    },

    /**
     * Execute a batch of functions with rate limiting
     * @param {Function[]} fns - Array of async functions
     * @returns {Promise<Array>} Results
     */
    async executeBatch(fns) {
      return Promise.all(fns.map((fn) => this.execute(fn)));
    },
  };
}
