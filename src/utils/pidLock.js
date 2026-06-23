import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { logger } from './logger.js';

/**
 * Is a process with this PID currently running?
 * Signal 0 is a no-op that only probes for existence/permission.
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but owned by another user (still alive)
    return err.code === 'EPERM';
  }
}

/**
 * Acquire an exclusive PID lock so two runs can never overlap.
 * A stale lock (owning process gone) is overridden; a live one blocks.
 * @param {string} lockPath
 * @returns {{ ok: boolean, heldBy?: { pid: number, startedAt: string } }}
 */
export function acquireLock(lockPath) {
  if (existsSync(lockPath)) {
    let holder = null;
    try { holder = JSON.parse(readFileSync(lockPath, 'utf-8')); } catch { /* unreadable → treat as stale */ }
    if (holder?.pid && isProcessAlive(holder.pid)) {
      return { ok: false, heldBy: holder };
    }
    logger.warn(`Overriding stale sync lock (pid ${holder?.pid ?? 'unknown'}, started ${holder?.startedAt ?? 'unknown'})`);
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return { ok: true };
}

/**
 * Release a lock — only if this process owns it, so we never delete another run's lock.
 * @param {string} lockPath
 */
export function releaseLock(lockPath) {
  try {
    if (!existsSync(lockPath)) return;
    const holder = JSON.parse(readFileSync(lockPath, 'utf-8'));
    if (holder?.pid === process.pid) unlinkSync(lockPath);
  } catch {
    try { unlinkSync(lockPath); } catch { /* best-effort */ }
  }
}
