#!/usr/bin/env node
// Generate new scorecard reports for specified audit IDs using the deterministic engine.
// Usage: node scripts/generate-scorecard.js <auditId1> [auditId2] ...

const { initDatabase, getAuditById, getCrawlPages, saveReport, updateAuditStatus } = require('../dist/database');
const { runChecks } = require('../dist/checks');
const { buildScorecardReport } = require('../dist/reportBuilder');
const fs = require('fs');
const path = require('path');

initDatabase();

const auditIds = process.argv.slice(2).map(Number).filter(n => !isNaN(n));
if (auditIds.length === 0) {
  console.log('Usage: node scripts/generate-scorecard.js <auditId1> [auditId2] ...');
  process.exit(1);
}

for (const id of auditIds) {
  const audit = getAuditById(id);
  if (!audit) {
    console.log(`Audit ${id}: not found, skipping`);
    continue;
  }

  const pages = getCrawlPages(id);
  if (pages.length === 0) {
    console.log(`Audit ${id}: no crawl data, skipping`);
    continue;
  }

  console.log(`\nAudit ${id}: ${audit.website_url} (${pages.length} pages)`);

  // Reconstruct consent from the consent_check row's consent_state column
  let consent = null;
  const consentRow = pages.find(p => p.page_type === 'consent_check' && p.consent_state);
  if (consentRow && consentRow.consent_state) {
    try { consent = JSON.parse(consentRow.consent_state); } catch { /* ignore */ }
  }
  console.log(`  Consent data: ${consent ? `${consent.cmpDetected || 'detected'}, banner=${consent.bannerFound}` : 'NOT FOUND in DB'}`);

  const scorecard = runChecks(pages, consent);

  console.log(`  Score: ${scorecard.score}/100`);
  console.log(`  Passed: ${scorecard.passCount}, Warnings: ${scorecard.warnCount}, Failures: ${scorecard.failCount}, Info: ${scorecard.infoCount}`);

  for (const check of scorecard.checks) {
    const icon = { pass: '✓', fail: '✗', warn: '⚠', info: 'ℹ' }[check.status];
    console.log(`  ${icon} [${check.status.toUpperCase().padEnd(4)}] ${check.name}: ${check.summary}`);
  }

  const reportHtml = buildScorecardReport(audit, scorecard, consent);

  // Save to database
  saveReport({
    audit_id: audit.id,
    ai_analysis: '',
    scorecard: JSON.stringify(scorecard),
    full_report_html: reportHtml,
  });
  updateAuditStatus(audit.id, 'report_ready');

  // Also save to file for easy viewing
  const outPath = path.join(__dirname, '..', 'data', `scorecard-${id}.html`);
  fs.writeFileSync(outPath, reportHtml);
  console.log(`  Saved: ${outPath}`);
}

console.log('\nDone.');
