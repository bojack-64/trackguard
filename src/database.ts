// database.ts — SQLite schema, migrations, and query helpers
// Uses better-sqlite3 for synchronous, simple database access

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let db: Database.Database;

/**
 * Initialise the database connection and create tables if they don't exist.
 * Call this once at server startup.
 */
export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || process.env.DATABASE_PATH || './data/trackguard.db';

  // Ensure the data directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(resolvedPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  createTables();
  runMigrations();

  return db;
}

/**
 * Run schema migrations that add columns to existing tables.
 * Each migration is idempotent — safe to run repeatedly.
 */
function runMigrations(): void {
  // Add potential_proxies column to crawl_pages (v1.1)
  try {
    db.exec(`ALTER TABLE crawl_pages ADD COLUMN potential_proxies TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Add dom_content_loaded_ms column (v1.2)
  try {
    db.exec(`ALTER TABLE crawl_pages ADD COLUMN dom_content_loaded_ms INTEGER`);
  } catch {
    // Column already exists — ignore
  }
}

/**
 * Get the current database instance.
 * Throws if initDatabase() hasn't been called yet.
 */
export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialised. Call initDatabase() first.');
  }
  return db;
}

/**
 * Create all tables if they don't already exist.
 */
function createTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audits (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      reference_id      TEXT UNIQUE NOT NULL,
      website_url       TEXT NOT NULL,
      platform          TEXT,
      conversion_events TEXT,
      cmp               TEXT,
      recent_changes    TEXT,
      contact_email     TEXT NOT NULL,
      company_name      TEXT NOT NULL,
      status            TEXT DEFAULT 'pending',
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS crawl_pages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id          INTEGER NOT NULL REFERENCES audits(id),
      page_url          TEXT NOT NULL,
      page_type         TEXT,
      datalayer_events  TEXT,
      ga4_requests      TEXT,
      gtm_requests      TEXT,
      consent_state     TEXT,
      console_errors    TEXT,
      screenshot_path   TEXT,
      page_load_ms      INTEGER,
      raw_network_log   TEXT,
      crawled_at        TEXT DEFAULT (datetime('now'))
    );

    -- potential_proxies column added in v1.1
    -- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we handle it in code

    CREATE TABLE IF NOT EXISTS reports (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      audit_id          INTEGER NOT NULL REFERENCES audits(id),
      ai_analysis       TEXT,
      scorecard         TEXT,
      full_report_html  TEXT,
      generated_at      TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ─── Audit query helpers ─────────────────────────────────────────────────────

export interface AuditRow {
  id: number;
  reference_id: string;
  website_url: string;
  platform: string | null;
  conversion_events: string | null;
  cmp: string | null;
  recent_changes: string | null;
  contact_email: string;
  company_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Insert a new audit submission. Returns the created audit row.
 */
export function createAudit(data: {
  reference_id: string;
  website_url: string;
  platform: string;
  conversion_events: string;
  cmp: string;
  recent_changes: string;
  contact_email: string;
  company_name: string;
}): AuditRow {
  const stmt = getDb().prepare(`
    INSERT INTO audits (reference_id, website_url, platform, conversion_events, cmp, recent_changes, contact_email, company_name)
    VALUES (@reference_id, @website_url, @platform, @conversion_events, @cmp, @recent_changes, @contact_email, @company_name)
  `);
  const result = stmt.run(data);
  return getAuditById(result.lastInsertRowid as number)!;
}

/**
 * Get a single audit by its internal numeric ID.
 */
export function getAuditById(id: number): AuditRow | undefined {
  return getDb().prepare('SELECT * FROM audits WHERE id = ?').get(id) as AuditRow | undefined;
}

/**
 * Get a single audit by its public reference ID (e.g. "TG-2026-0042").
 */
export function getAuditByRef(referenceId: string): AuditRow | undefined {
  return getDb().prepare('SELECT * FROM audits WHERE reference_id = ?').get(referenceId) as AuditRow | undefined;
}

/**
 * Get all audits, most recent first.
 */
export function getAllAudits(): AuditRow[] {
  return getDb().prepare('SELECT * FROM audits ORDER BY created_at DESC').all() as AuditRow[];
}

/**
 * Update the status of an audit (e.g. pending → crawling → analysing → report_ready).
 */
export function updateAuditStatus(id: number, status: string): void {
  getDb().prepare(`UPDATE audits SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
}

// ─── Crawl page query helpers ────────────────────────────────────────────────

export interface CrawlPageRow {
  id: number;
  audit_id: number;
  page_url: string;
  page_type: string | null;
  datalayer_events: string | null;
  ga4_requests: string | null;
  gtm_requests: string | null;
  consent_state: string | null;
  console_errors: string | null;
  screenshot_path: string | null;
  page_load_ms: number | null;
  dom_content_loaded_ms: number | null;
  raw_network_log: string | null;
  potential_proxies: string | null;
  crawled_at: string;
}

/**
 * Insert crawl data for a single page.
 */
export function insertCrawlPage(data: {
  audit_id: number;
  page_url: string;
  page_type: string;
  datalayer_events?: string;
  ga4_requests?: string;
  gtm_requests?: string;
  consent_state?: string;
  console_errors?: string;
  screenshot_path?: string;
  page_load_ms?: number;
  dom_content_loaded_ms?: number;
  raw_network_log?: string;
  potential_proxies?: string;
}): number {
  const stmt = getDb().prepare(`
    INSERT INTO crawl_pages (audit_id, page_url, page_type, datalayer_events, ga4_requests, gtm_requests, consent_state, console_errors, screenshot_path, page_load_ms, dom_content_loaded_ms, raw_network_log, potential_proxies)
    VALUES (@audit_id, @page_url, @page_type, @datalayer_events, @ga4_requests, @gtm_requests, @consent_state, @console_errors, @screenshot_path, @page_load_ms, @dom_content_loaded_ms, @raw_network_log, @potential_proxies)
  `);
  const result = stmt.run({
    datalayer_events: null,
    ga4_requests: null,
    gtm_requests: null,
    consent_state: null,
    console_errors: null,
    screenshot_path: null,
    page_load_ms: null,
    dom_content_loaded_ms: null,
    raw_network_log: null,
    potential_proxies: null,
    ...data,
  });
  return result.lastInsertRowid as number;
}

/**
 * Get all crawl pages for a given audit.
 */
export function getCrawlPages(auditId: number): CrawlPageRow[] {
  return getDb().prepare('SELECT * FROM crawl_pages WHERE audit_id = ? ORDER BY crawled_at ASC').all(auditId) as CrawlPageRow[];
}

// ─── Report query helpers ────────────────────────────────────────────────────

export interface ReportRow {
  id: number;
  audit_id: number;
  ai_analysis: string | null;
  scorecard: string | null;
  full_report_html: string | null;
  generated_at: string;
}

/**
 * Insert or replace a report for an audit.
 */
export function saveReport(data: {
  audit_id: number;
  ai_analysis: string;
  scorecard: string;
  full_report_html: string;
}): number {
  // Delete any existing report for this audit first
  getDb().prepare('DELETE FROM reports WHERE audit_id = ?').run(data.audit_id);

  const stmt = getDb().prepare(`
    INSERT INTO reports (audit_id, ai_analysis, scorecard, full_report_html)
    VALUES (@audit_id, @ai_analysis, @scorecard, @full_report_html)
  `);
  const result = stmt.run(data);
  return result.lastInsertRowid as number;
}

/**
 * Get the report for a given audit.
 */
export function getReport(auditId: number): ReportRow | undefined {
  return getDb().prepare('SELECT * FROM reports WHERE audit_id = ?').get(auditId) as ReportRow | undefined;
}

// ─── Stats helpers ───────────────────────────────────────────────────────────

/**
 * Get basic stats for the admin dashboard.
 */
export function getStats(): { total: number; thisMonth: number; avgScore: number | null } {
  const total = (getDb().prepare('SELECT COUNT(*) as count FROM audits').get() as { count: number }).count;
  const thisMonth = (getDb().prepare(
    "SELECT COUNT(*) as count FROM audits WHERE created_at >= date('now', 'start of month')"
  ).get() as { count: number }).count;
  const avgRow = getDb().prepare(
    "SELECT AVG(json_extract(scorecard, '$.health_score')) as avg FROM reports WHERE scorecard IS NOT NULL"
  ).get() as { avg: number | null };

  return {
    total,
    thisMonth,
    avgScore: avgRow.avg ? Math.round(avgRow.avg) : null,
  };
}
