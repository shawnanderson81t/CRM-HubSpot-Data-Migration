import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';

/**
 * End-of-run summary email + immediate failure alert for the daily sync.
 *
 * Transport is pluggable and degrades gracefully:
 *   - 'smtp': sends via nodemailer (lazy-imported, so the dependency is only
 *     needed when SMTP is actually configured). Any send error falls back to file.
 *   - 'file' (default when no SMTP host is set): writes the rendered HTML to
 *     logs/emails/ so the pipeline is fully functional before mail creds exist
 *     and during dry-run validation.
 *
 * Recipients and credentials come from .env (config.mail). Rendering is pure and
 * provider-independent, so the email content can be tested without sending.
 */

/** Format a duration in ms as "1m 23s" / "45s". */
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const esc = v => String(v ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function table(rows) {
  const trs = rows.map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#555;">${esc(k)}</td><td style="padding:4px 0;font-weight:600;">${esc(v)}</td></tr>`
  ).join('');
  return `<table style="border-collapse:collapse;font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;">${trs}</table>`;
}

/**
 * Render the end-of-run summary email.
 * @param {Object} summary - Run summary from the sync runner.
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderRunSummary(summary) {
  const {
    ok, dryRun = false, window = {}, changed = 0,
    updated = 0, inserted = 0, failed = 0, skipped = 0,
    startedAt, finishedAt, failureRate, error,
  } = summary;

  const status = dryRun ? 'DRY RUN' : (ok ? 'OK' : 'FAILED');
  const color = dryRun ? '#555' : (ok ? '#1a7f37' : '#b00020');
  const dateLabel = (finishedAt || startedAt || new Date().toISOString()).slice(0, 10);
  const duration = fmtDuration(Date.parse(finishedAt) - Date.parse(startedAt));
  const subject = `Daily Sync — ${status} — ${dateLabel}`;

  const rows = [
    ['Status', status],
    ['Window', `${window.since ?? '?'} → ${window.until ?? '?'}`],
    ['Changed in GoHighLevel', changed],
    ['Updated in HubSpot', updated],
    ['Created in HubSpot', inserted],
    ['Failed', failed],
    ['Skipped (no match key)', skipped],
    ['Duration', duration],
  ];
  if (failureRate != null) rows.push(['Failure rate', `${(failureRate * 100).toFixed(1)}%`]);
  if (error) rows.push(['Error', error]);

  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#222;">
    <h2 style="margin:0 0 4px;">Daily Sync — <span style="color:${color};">${status}</span></h2>
    <p style="margin:0 0 16px;color:#777;">${esc(dateLabel)}</p>
    ${table(rows)}
    ${dryRun ? '<p style="color:#777;margin-top:16px;">Dry run — nothing was written to HubSpot and the watermark was not moved.</p>' : ''}
  </div>`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  return { subject, html, text };
}

/**
 * Render an immediate failure / crash alert.
 * @param {Object} info - { error, window, failed, changed, startedAt }
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderFailureAlert(info) {
  const { error, window = {}, failed, changed, startedAt } = info;
  const dateLabel = (startedAt || new Date().toISOString()).slice(0, 10);
  const subject = `[ALERT] Daily Sync FAILED — ${dateLabel}`;
  const reason = error ?? 'failure rate exceeded the configured threshold';

  const rows = [
    ['Reason', reason],
    ['Window', `${window.since ?? '?'} → ${window.until ?? '?'}`],
    ['Failed', failed != null ? `${failed} of ${changed ?? '?'} changed` : 'n/a'],
    ['Watermark', 'NOT advanced — the same window will be retried on the next run'],
  ];
  const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#222;">
    <h2 style="margin:0 0 12px;color:#b00020;">Daily Sync failed</h2>
    ${table(rows)}
  </div>`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  return { subject, html, text };
}

export class Mailer {
  /** @param {Object} mailConfig - config.mail */
  constructor(mailConfig = {}) {
    this.cfg = mailConfig;
  }

  /**
   * Send a rendered email. Uses SMTP when configured; otherwise writes to file.
   * Never throws on a transport problem — falls back to file and logs.
   * @returns {Promise<{ sent: boolean, transport: string, path?: string }>}
   */
  async send({ subject, html, text, to }) {
    const recipients = (to || []).filter(Boolean);

    if (this.cfg.transport === 'smtp' && this.cfg.smtp?.host && recipients.length) {
      try {
        const { default: nodemailer } = await import('nodemailer');
        const transporter = nodemailer.createTransport({
          host: this.cfg.smtp.host,
          port: this.cfg.smtp.port,
          secure: this.cfg.smtp.secure,
          auth: this.cfg.smtp.user ? { user: this.cfg.smtp.user, pass: this.cfg.smtp.pass } : undefined,
        });
        await transporter.sendMail({ from: this.cfg.from, to: recipients.join(','), subject, html, text });
        logger.info(`Mailer: sent "${subject}" to ${recipients.join(', ')}`);
        return { sent: true, transport: 'smtp' };
      } catch (err) {
        logger.error(`Mailer: SMTP send failed (${err.message}) — writing to file instead`);
      }
    }
    return this._writeFile({ subject, html, recipients });
  }

  _writeFile({ subject, html, recipients }) {
    const dir = this.cfg.outboxDir || './logs/emails';
    mkdirSync(dir, { recursive: true });
    const slug = subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 50);
    const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug}.html`);
    writeFileSync(path, html);
    const why = recipients.length ? '' : ' (no recipients configured)';
    logger.warn(`Mailer: SMTP not configured${why} — wrote "${subject}" to ${path}`);
    return { sent: false, transport: 'file', path };
  }

  /** Render + send the end-of-run summary to the summary recipients. */
  async sendRunSummary(summary) {
    const { subject, html, text } = renderRunSummary(summary);
    return this.send({ subject, html, text, to: this.cfg.summaryRecipients });
  }

  /** Render + send a failure alert to the alert recipients. */
  async sendFailureAlert(info) {
    const { subject, html, text } = renderFailureAlert(info);
    return this.send({ subject, html, text, to: this.cfg.alertRecipients });
  }
}
