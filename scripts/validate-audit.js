#!/usr/bin/env node
/**
 * validate-audit.js — Compares raw crawl data against the generated HTML report.
 *
 * Usage:  node scripts/validate-audit.js <audit_id>
 *
 * Pulls raw data from SQLite, parses the report HTML, and prints a side-by-side
 * comparison table with PASS/FAIL for each check.
 */

const path = require('path');
const Database = require('better-sqlite3');

// ── Open database ───────────────────────────────────────────────────────────
const dbPath = path.join(__dirname, '..', 'data', 'trackguard.db');
const db = new Database(dbPath, { readonly: true });

const auditId = parseInt(process.argv[2], 10);
if (!auditId) {
  console.error('Usage: node scripts/validate-audit.js <audit_id>');
  process.exit(1);
}

// ── Fetch raw data ──────────────────────────────────────────────────────────
const audit = db.prepare('SELECT * FROM audits WHERE id = ?').get(auditId);
if (!audit) {
  console.error(`Audit ${auditId} not found`);
  process.exit(1);
}

const crawlPages = db.prepare('SELECT * FROM crawl_pages WHERE audit_id = ?').all(auditId);
const report = db.prepare('SELECT * FROM reports WHERE audit_id = ?').get(auditId);

console.log(`\n${'='.repeat(70)}`);
console.log(`  VALIDATION: ${audit.reference_id} — ${audit.website_url}`);
console.log(`  Status: ${audit.status}`);
console.log(`${'='.repeat(70)}\n`);

if (!report) {
  console.error('No report found for this audit. Generate the report first.');
  process.exit(1);
}

const html = report.full_report_html;

// ── Raw data extraction ─────────────────────────────────────────────────────

// Filter out consent_check pages for page count (they're metadata, not real pages)
const realPages = crawlPages.filter(p => p.page_type !== 'consent_check');
const consentPage = crawlPages.find(p => p.page_type === 'consent_check');

// GA4 requests per page — keyed by URL for accurate matching
const rawGA4ByUrl = {};
for (const p of realPages) {
  const ga4 = JSON.parse(p.ga4_requests || '[]');
  rawGA4ByUrl[p.page_url] = ga4.length;
}

// Total GA4 across all pages (including consent)
const rawGA4Total = crawlPages.reduce((sum, p) => {
  return sum + JSON.parse(p.ga4_requests || '[]').length;
}, 0);

// GA4 total for real pages only (what the report table shows)
const rawGA4RealTotal = realPages.reduce((sum, p) => {
  return sum + JSON.parse(p.ga4_requests || '[]').length;
}, 0);

// GTM containers — unique across all pages
const rawGTMContainers = new Set();
for (const p of crawlPages) {
  const gtm = JSON.parse(p.gtm_requests || '[]');
  for (const req of gtm) {
    if (req.container_id) rawGTMContainers.add(req.container_id);
  }
}
const rawGTMList = [...rawGTMContainers].sort();

// DataLayer event count per page (by URL)
const rawDLByUrl = {};
let rawDLTotal = 0;
for (const p of realPages) {
  const dl = JSON.parse(p.datalayer_events || '[]');
  rawDLByUrl[p.page_url] = dl.length;
  rawDLTotal += dl.length;
}

// Measurement IDs from GA4 requests
const rawMeasurementIDs = new Set();
for (const p of crawlPages) {
  const ga4 = JSON.parse(p.ga4_requests || '[]');
  for (const req of ga4) {
    if (req.measurement_id) rawMeasurementIDs.add(req.measurement_id);
  }
}
const rawMIDList = [...rawMeasurementIDs].sort();

// Potential proxies — filter out Google-owned domains and the site's own domain
// which are false positives in proxy detection
const rawProxies = new Set();
const siteHostname = new URL(audit.website_url).hostname.replace(/^www\./, '');
const googleDomains = ['googlesyndication.com', 'doubleclick.net', 'google.com',
  'google-analytics.com', 'googleapis.com', 'gstatic.com', 'googletagmanager.com',
  'linkedin.com', 'ads.linkedin.com', 'facebook.com', 'tiktok.com'];
for (const p of crawlPages) {
  const proxies = JSON.parse(p.potential_proxies || '[]');
  for (const proxy of proxies) {
    const domain = proxy.domain;
    // Skip Google-owned domains and common ad networks (not real GA4 proxies)
    const isGoogleOwned = googleDomains.some(gd => domain.endsWith(gd));
    // Skip the site's own domain (server-side GTM on own domain is valid proxy, check if mentioned)
    const isSiteDomain = domain.endsWith(siteHostname);
    if (!isGoogleOwned && !isSiteDomain) {
      rawProxies.add(domain);
    }
  }
}

// Scorecard from database
const scorecard = report.scorecard ? JSON.parse(report.scorecard) : null;
const rawScore = scorecard?.health_score ?? null;

// ── Report HTML parsing ─────────────────────────────────────────────────────

// 1. Health score — from <div class="score-number">72</div>
const scoreMatch = html.match(/class="score-number"[^>]*>(\d+)/i);
const reportScore = scoreMatch ? parseInt(scoreMatch[1], 10) : null;

// 2. Pages table — parse the actual table structure
// Structure: <td>page-type-badge</td><td>url link</td><td>load time</td><td>DL count</td><td>GA4 count</td>
const pagesTableMatch = html.match(/id="pages-audited"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
const reportPageRows = [];
if (pagesTableMatch) {
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(pagesTableMatch[1])) !== null) {
    const cells = rowMatch[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (cells && cells.length >= 5) {
      const pageType = cells[0].replace(/<[^>]*>/g, '').trim();
      // Extract URL from the href attribute
      const urlMatch = cells[1].match(/href="([^"]+)"/);
      const url = urlMatch ? urlMatch[1] : cells[1].replace(/<[^>]*>/g, '').trim();
      const loadTime = cells[2].replace(/<[^>]*>/g, '').trim();
      const dlCount = parseInt(cells[3].replace(/<[^>]*>/g, '').trim(), 10);
      const ga4Count = parseInt(cells[4].replace(/<[^>]*>/g, '').trim(), 10);
      reportPageRows.push({ pageType, url, loadTime, dlCount, ga4Count });
    }
  }
}

// 3. GTM containers mentioned in report body (not in CSS/scripts)
const gtmPattern = /GTM-[A-Z0-9]+/g;
const reportGTMMatches = html.match(gtmPattern) || [];
const reportGTMSet = new Set(reportGTMMatches);
const reportGTMList = [...reportGTMSet].sort();

// 4. Measurement IDs (G-XXXXXXX pattern, at least 5 chars, exclude CSS false positives)
const midPattern = /G-[A-Z0-9]{5,}/g;
const reportMIDMatches = html.match(midPattern) || [];
const reportMIDSet = new Set(reportMIDMatches);
const reportMIDList = [...reportMIDSet].sort();

// 5. Consent table — look for consent parameter names
const consentTableMatch = html.match(/Consent Analysis[\s\S]*?<table[\s\S]*?<\/table>/i);
let reportConsentParams = [];
if (consentTableMatch) {
  const paramMatches = consentTableMatch[0].match(/(?:ad_storage|analytics_storage|ad_user_data|ad_personalization|functionality_storage|personalization_storage|security_storage)/gi);
  reportConsentParams = paramMatches ? [...new Set(paramMatches)] : [];
}

// 6. Proxy domains mentioned in report
const rawProxyList = [...rawProxies].sort();
const proxyMentioned = rawProxyList.every(d => html.includes(d));

// ── Build comparison checks ─────────────────────────────────────────────────

const results = [];

function addCheck(name, rawValue, reportValue, customMatch) {
  const rawStr = typeof rawValue === 'object' ? JSON.stringify(rawValue) : String(rawValue ?? 'N/A');
  const reportStr = typeof reportValue === 'object' ? JSON.stringify(reportValue) : String(reportValue ?? 'N/A');

  let match;
  if (customMatch !== undefined) {
    match = customMatch;
  } else if (rawValue === null || reportValue === null) {
    match = 'SKIP';
  } else {
    match = rawStr === reportStr ? 'PASS' : 'FAIL';
  }

  results.push({ name, rawStr, reportStr, match });
}

function trunc(str, max = 35) {
  if (str.length <= max) return str;
  return str.substring(0, max - 3) + '...';
}

// ── Checks ──────────────────────────────────────────────────────────────────

// Page count: real pages vs report table rows
addCheck('Pages crawled', realPages.length, reportPageRows.length);

// Health score: scorecard DB vs rendered HTML
addCheck('Health score', rawScore, reportScore);

// Total GA4 requests across real pages
const reportGA4Total = reportPageRows.reduce((sum, r) => sum + (r.ga4Count || 0), 0);
addCheck('Total GA4 (real pages)', rawGA4RealTotal, reportGA4Total);

// Total dataLayer events across real pages
const reportDLTotal = reportPageRows.reduce((sum, r) => sum + (r.dlCount || 0), 0);
addCheck('Total dataLayer events', rawDLTotal, reportDLTotal);

// GTM containers: raw vs report mentions
const gtmOnlyContainers = rawGTMList.filter(id => id.startsWith('GTM-'));
const reportGTMOnly = reportGTMList.filter(id => id.startsWith('GTM-'));
addCheck(
  'GTM containers',
  gtmOnlyContainers.join(', '),
  reportGTMOnly.join(', '),
  gtmOnlyContainers.length > 0 && gtmOnlyContainers.every(id => reportGTMSet.has(id))
    ? 'PASS' : (reportGTMOnly.length > 0 ? 'WARN' : 'FAIL')
);

// Measurement IDs: raw vs report mentions
addCheck(
  'Measurement IDs',
  rawMIDList.join(', ') || '(none in raw)',
  reportMIDList.join(', ') || '(none in report)',
  rawMIDList.length === 0
    ? 'SKIP'
    : rawMIDList.every(id => reportMIDSet.has(id)) ? 'PASS' : 'WARN'
);

// Consent params present in report
addCheck(
  'Consent params',
  consentPage ? 'expected' : 'no consent page',
  reportConsentParams.length > 0 ? reportConsentParams.length + ' params' : '(none)',
  !consentPage ? 'SKIP' : (reportConsentParams.length > 0 ? 'PASS' : 'FAIL')
);

// Proxy domains mentioned in report text
addCheck(
  'Proxy domains',
  rawProxyList.join(', ') || '(none)',
  proxyMentioned ? 'mentioned' : 'NOT mentioned',
  rawProxyList.length === 0 ? 'SKIP' : (proxyMentioned ? 'PASS' : 'FAIL')
);

// Helper: normalize URL by stripping query params for matching
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

// Per-page GA4 comparison (match by URL, strip query params for matching)
for (const p of realPages) {
  const rawCount = JSON.parse(p.ga4_requests || '[]').length;
  const normRaw = normalizeUrl(p.page_url);
  const reportRow = reportPageRows.find(r => r.url === p.page_url)
    || reportPageRows.find(r => normalizeUrl(r.url) === normRaw);
  const shortUrl = p.page_url.replace(audit.website_url.replace(/\/+$/, ''), '') || '/';
  addCheck(
    `GA4 [${shortUrl}]`,
    rawCount,
    reportRow ? reportRow.ga4Count : 'N/A',
    reportRow ? (rawCount === reportRow.ga4Count ? 'PASS' : 'FAIL') : 'SKIP'
  );
}

// Per-page dataLayer comparison (match by URL, strip query params for matching)
for (const p of realPages) {
  const rawCount = JSON.parse(p.datalayer_events || '[]').length;
  const normRaw = normalizeUrl(p.page_url);
  const reportRow = reportPageRows.find(r => r.url === p.page_url)
    || reportPageRows.find(r => normalizeUrl(r.url) === normRaw);
  const shortUrl = p.page_url.replace(audit.website_url.replace(/\/+$/, ''), '') || '/';
  addCheck(
    `DL [${shortUrl}]`,
    rawCount,
    reportRow ? reportRow.dlCount : 'N/A',
    reportRow ? (rawCount === reportRow.dlCount ? 'PASS' : 'FAIL') : 'SKIP'
  );
}

// ── Print results ───────────────────────────────────────────────────────────

const colWidths = { name: 25, raw: 30, report: 30, match: 6 };

function pad(str, width) {
  str = String(str);
  if (str.length >= width) return str.substring(0, width);
  return str + ' '.repeat(width - str.length);
}

const header = `${pad('CHECK', colWidths.name)} | ${pad('RAW DATA', colWidths.raw)} | ${pad('REPORT SAYS', colWidths.report)} | MATCH`;
const divider = '-'.repeat(header.length);

console.log(divider);
console.log(header);
console.log(divider);

let passes = 0;
let fails = 0;
let warns = 0;
let skips = 0;

for (const r of results) {
  const matchColor = r.match === 'PASS' ? '\x1b[32m' : r.match === 'FAIL' ? '\x1b[31m' : r.match === 'WARN' ? '\x1b[33m' : '\x1b[90m';
  const reset = '\x1b[0m';

  console.log(
    `${pad(r.name, colWidths.name)} | ${pad(trunc(r.rawStr, colWidths.raw), colWidths.raw)} | ${pad(trunc(r.reportStr, colWidths.report), colWidths.report)} | ${matchColor}${r.match}${reset}`
  );

  if (r.match === 'PASS') passes++;
  else if (r.match === 'FAIL') fails++;
  else if (r.match === 'WARN') warns++;
  else skips++;
}

console.log(divider);
console.log(`\n  Results: ${passes} PASS, ${fails} FAIL, ${warns} WARN, ${skips} SKIP\n`);

if (fails > 0) {
  console.log('  \u274c VALIDATION FAILED \u2014 report does not match raw data\n');
  process.exit(1);
} else if (warns > 0) {
  console.log('  \u26a0\ufe0f  VALIDATION PASSED WITH WARNINGS \u2014 review manually\n');
} else {
  console.log('  \u2705 VALIDATION PASSED \u2014 report matches raw data\n');
}
