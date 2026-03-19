#!/usr/bin/env node
// Crawl a site and generate its scorecard report in one step.
// Usage: node scripts/crawl-and-report.js <auditId>

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const { initDatabase, getAuditById, getCrawlPages, saveReport, updateAuditStatus } = require('../dist/database');
const { crawlSite } = require('../dist/crawler');
const { runChecks } = require('../dist/checks');
const { buildScorecardReport } = require('../dist/reportBuilder');
const fs = require('fs');

initDatabase();

const auditId = parseInt(process.argv[2], 10);
if (!auditId) { console.log('Usage: node scripts/crawl-and-report.js <auditId>'); process.exit(1); }

(async () => {
  const audit = getAuditById(auditId);
  if (!audit) { console.log('Audit not found'); process.exit(1); }

  console.log(`\nCrawling ${audit.website_url} (audit ${auditId})...\n`);
  updateAuditStatus(audit.id, 'crawling');

  const { pages, consent } = await crawlSite(audit);
  console.log(`\nCrawl complete: ${pages.length} pages`);

  if (consent) {
    console.log(`Consent: CMP=${consent.cmpDetected}, banner=${consent.bannerFound}, clicked=${consent.acceptButtonClicked}`);
    console.log(`  Default state:`, consent.defaultConsentState);
    console.log(`  Post state:`, consent.postConsentState);
    console.log(`  Pre-consent GA4: ${(consent.preConsentGA4Requests || []).length} requests`);
  } else {
    console.log('Consent: null');
  }

  updateAuditStatus(audit.id, 'analysing');

  // Read consent from DB (the crawler now persists it)
  const crawlPages = getCrawlPages(audit.id);
  let dbConsent = consent; // Use the in-memory version from this same run
  if (!dbConsent) {
    const consentRow = crawlPages.find(p => p.page_type === 'consent_check' && p.consent_state);
    if (consentRow) { try { dbConsent = JSON.parse(consentRow.consent_state); } catch {} }
  }

  const scorecard = runChecks(crawlPages, dbConsent);

  console.log(`\nScore: ${scorecard.score}/100`);
  for (const check of scorecard.checks) {
    const icon = { pass: '✓', fail: '✗', warn: '⚠', info: 'ℹ' }[check.status];
    console.log(`  ${icon} [${check.status.toUpperCase().padEnd(4)}] ${check.name}: ${check.summary}`);
  }

  const reportHtml = buildScorecardReport(audit, scorecard, dbConsent);
  saveReport({ audit_id: audit.id, ai_analysis: '', scorecard: JSON.stringify(scorecard), full_report_html: reportHtml });
  updateAuditStatus(audit.id, 'report_ready');

  const outPath = path.join(__dirname, '..', 'data', `scorecard-${auditId}.html`);
  fs.writeFileSync(outPath, reportHtml);
  console.log(`\nSaved: ${outPath}`);
  console.log(`View: http://localhost:3000/report/${audit.reference_id}`);
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
