// server.ts — Express app, routes, and middleware
// This is the main entry point for the TrackGuard application.

import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import {
  initDatabase, createAudit, getAllAudits, getAuditById, getAuditByRef,
  updateAuditStatus, getCrawlPages, getReport, getStats,
} from './database';
import { generateReferenceId, validateUrl, validateEmail } from './utils';
import { crawlSite, ConsentResult } from './crawler';
import { runChecks } from './checks';
import { buildScorecardReport } from './reportBuilder';
import { saveReport } from './database';

// Store consent data in memory keyed by audit ID (simple approach for V1)
const consentCache = new Map<number, ConsentResult>();

// Load environment variables from .env (use absolute path so it works regardless of CWD)
dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });

const app: express.Express = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// EJS template engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// ─── Public routes ───────────────────────────────────────────────────────────

/** Homepage / intake form */
app.get('/', (_req, res) => {
  res.render('intake', { errors: null, formData: null });
});

/** Handle intake form submission */
app.post('/audit', (req, res) => {
  const { website_url, platform, conversion_events, cmp, recent_changes, contact_email, company_name } = req.body;
  const errors: string[] = [];

  const validatedUrl = validateUrl(website_url || '');
  if (!validatedUrl) errors.push('Please enter a valid website URL.');
  if (!contact_email || !validateEmail(contact_email)) errors.push('Please enter a valid email address.');
  if (!company_name || company_name.trim().length === 0) errors.push('Please enter your company or agency name.');

  if (errors.length > 0) {
    return res.status(400).render('intake', { errors, formData: req.body });
  }

  // Generate unique reference ID (retry on collision)
  let referenceId = generateReferenceId();
  let attempts = 0;
  while (getAuditByRef(referenceId) && attempts < 10) {
    referenceId = generateReferenceId();
    attempts++;
  }

  const audit = createAudit({
    reference_id: referenceId,
    website_url: validatedUrl!,
    platform: platform || 'other',
    conversion_events: conversion_events || '',
    cmp: cmp || 'unknown',
    recent_changes: recent_changes || '',
    contact_email: contact_email.trim(),
    company_name: company_name.trim(),
  });

  res.redirect(`/confirmation/${audit.reference_id}`);
});

/** Confirmation page after submission */
app.get('/confirmation/:refId', (req, res) => {
  const audit = getAuditByRef(req.params.refId);
  if (!audit) return res.status(404).send('Audit not found.');
  res.render('confirmation', { audit });
});

/** Public report page — shareable URL for the client */
app.get('/report/:refId', (req, res) => {
  const audit = getAuditByRef(req.params.refId);
  if (!audit) return res.status(404).send(`
    <!DOCTYPE html><html><head><title>Report Not Found — TrackGuard</title>
    <link rel="stylesheet" href="/css/style.css"></head><body>
    <header class="site-header"><div class="container"><a href="/" class="logo">Track<span>Guard</span></a></div></header>
    <main><div class="container" style="text-align:center; padding:80px 20px;">
      <h1 style="color:#1B2A4A;">Report Not Found</h1>
      <p style="color:#666; margin:16px 0;">No audit exists with this reference ID. Please check the link and try again.</p>
    </div></main></body></html>
  `);
  const report = getReport(audit.id);
  if (!report || !report.full_report_html) {
    const statusMsg = audit.status === 'crawling' ? 'Your site is currently being crawled.'
      : audit.status === 'analysing' ? 'Your report is being generated.'
      : 'Your report hasn\'t been generated yet. We\'ll have it ready shortly.';
    return res.send(`
      <!DOCTYPE html><html><head><title>Report Pending — TrackGuard</title>
      <link rel="stylesheet" href="/css/style.css">
      <meta http-equiv="refresh" content="15"></head><body>
      <header class="site-header"><div class="container"><a href="/" class="logo">Track<span>Guard</span></a></div></header>
      <main><div class="container" style="text-align:center; padding:80px 20px;">
        <h1 style="color:#1B2A4A;">Report In Progress</h1>
        <p style="color:#666; margin:16px 0 8px;">${statusMsg}</p>
        <p style="color:#999; font-size:0.85rem;">This page will refresh automatically. Reference: <strong>${audit.reference_id}</strong></p>
      </div></main></body></html>
    `);
  }
  res.send(report.full_report_html);
});

// ─── Admin routes ────────────────────────────────────────────────────────────

/** Admin dashboard — all audits and stats */
app.get('/admin', (_req, res) => {
  const audits = getAllAudits();
  const stats = getStats();
  res.render('admin/dashboard', { audits, stats });
});

/** Admin audit detail */
app.get('/admin/audit/:id', (req, res) => {
  const audit = getAuditById(parseInt(req.params.id, 10));
  if (!audit) return res.status(404).send('Audit not found.');
  const crawlPages = getCrawlPages(audit.id);
  const report = getReport(audit.id);
  res.render('admin/audit-detail', { audit, crawlPages, report });
});

/** Trigger crawl */
app.post('/admin/audit/:id/crawl', (req, res) => {
  const audit = getAuditById(parseInt(req.params.id, 10));
  if (!audit) return res.status(404).send('Audit not found.');

  // Prevent double-triggering
  if (audit.status === 'crawling' || audit.status === 'analysing') {
    return res.redirect(`/admin/audit/${audit.id}`);
  }

  // Set status to crawling immediately so the UI reflects it
  updateAuditStatus(audit.id, 'crawling');

  // Respond immediately, run the crawl in the background
  res.redirect(`/admin/audit/${audit.id}`);
  crawlSite(audit).then(({ pages, consent }) => {
    if (consent) consentCache.set(audit.id, consent);
    // Check if the crawl was aborted due to site being unreachable
    // (homepage failed fatally — only 1 page with 0ms load time and errors)
    const realPages = pages.filter(p => p.pageType !== 'consent_check');
    const allFailed = realPages.length <= 1 && realPages.every(p =>
      p.pageLoadMs === 0 && p.ga4Requests.length === 0 && p.gtmRequests.length === 0
      && p.dataLayerEvents.length === 0 && p.consoleErrors.some(e => e.startsWith('Page error:'))
    );
    if (allFailed) {
      console.log(`[Server] Crawl aborted for audit ${audit.id} — site unreachable`);
      updateAuditStatus(audit.id, 'crawl_failed');
    } else {
      console.log(`[Server] Crawl complete for audit ${audit.id}`);
    }
  }).catch((err) => {
    console.error(`[Server] Crawl failed for audit ${audit.id}:`, err);
    updateAuditStatus(audit.id, 'error');
  });
});

/** Trigger report generation */
app.post('/admin/audit/:id/generate-report', (req, res) => {
  const audit = getAuditById(parseInt(req.params.id, 10));
  if (!audit) return res.status(404).send('Audit not found.');

  // Prevent double-triggering
  if (audit.status === 'analysing') {
    return res.redirect(`/admin/audit/${audit.id}`);
  }

  updateAuditStatus(audit.id, 'analysing');
  res.redirect(`/admin/audit/${audit.id}`);

  // Run deterministic analysis (synchronous — no API calls)
  try {
    const crawlPages = getCrawlPages(audit.id);
    // Try in-memory cache first, fall back to DB (consent_check row's consent_state column)
    let consent = consentCache.get(audit.id) || null;
    if (!consent) {
      const consentRow = crawlPages.find(p => p.page_type === 'consent_check' && p.consent_state);
      if (consentRow?.consent_state) {
        try { consent = JSON.parse(consentRow.consent_state); } catch { /* ignore */ }
      }
    }
    const scorecard = runChecks(crawlPages, consent);
    const reportHtml = buildScorecardReport(audit, scorecard, consent);

    saveReport({
      audit_id: audit.id,
      ai_analysis: '',
      scorecard: JSON.stringify(scorecard),
      full_report_html: reportHtml,
    });

    updateAuditStatus(audit.id, 'report_ready');
    console.log(`[Server] Report generated for audit ${audit.id} — score: ${scorecard.score}/100`);
  } catch (err: any) {
    console.error(`\n${'='.repeat(60)}`);
    console.error(`[Server] REPORT GENERATION FAILED — Audit ${audit.id}`);
    console.error(`${'='.repeat(60)}`);
    console.error(`Error: ${err?.message || err}`);
    console.error(`Stack: ${err?.stack || '(no stack)'}`);
    console.error(`${'='.repeat(60)}\n`);
    updateAuditStatus(audit.id, 'error');
  }
});

// ─── 404 & error handling ─────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).send(`
    <!DOCTYPE html>
    <html><head><title>Not Found — TrackGuard</title>
    <link rel="stylesheet" href="/css/style.css"></head>
    <body>
      <header class="site-header"><div class="container"><a href="/" class="logo">Track<span>Guard</span></a></div></header>
      <main><div class="container" style="text-align:center; padding:80px 20px;">
        <h1 style="font-size:3rem; color:#1B2A4A;">404</h1>
        <p style="font-size:1.1rem; color:#666; margin:16px 0 24px;">The page you're looking for doesn't exist.</p>
        <a href="/" class="btn btn-primary">Go Home</a>
      </div></main>
    </body></html>
  `);
});

// ─── Start the server ────────────────────────────────────────────────────────

initDatabase();

// On startup, reset any audits stuck in transient states (from a crashed process)
import { getDb } from './database';
const stuck = getDb().prepare(
  "UPDATE audits SET status = 'error', updated_at = datetime('now') WHERE status IN ('crawling', 'analysing')"
).run();
if (stuck.changes > 0) {
  console.log(`[Server] Reset ${stuck.changes} stuck audit(s) to error state`);
}

app.listen(PORT, () => {
  console.log(`TrackGuard running at http://localhost:${PORT}`);
  console.log(`Admin dashboard at http://localhost:${PORT}/admin`);
});

export default app;
