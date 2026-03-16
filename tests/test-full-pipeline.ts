// test-full-pipeline.ts — End-to-end test: crawl → AI analysis → report generation
// Runs the full TrackGuard pipeline on a test site and saves the HTML report to disk.

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { initDatabase, createAudit, updateAuditStatus, getReport } from '../src/database';
import { crawlSite, ConsentResult } from '../src/crawler';
import { analyseAudit } from '../src/analyser';
import { buildReport } from '../src/reportBuilder';
import { saveReport } from '../src/database';
import { generateReferenceId } from '../src/utils';
import fs from 'fs';
import path from 'path';

// ─── Config ──────────────────────────────────────────────────────────────────

interface TestSite {
  name: string;
  url: string;
  platform: string;
  conversionEvents: string;
  cmp: string;
}

const TEST_SITES: TestSite[] = [
  {
    name: 'Allbirds',
    url: 'https://www.allbirds.com',
    platform: 'shopify',
    conversionEvents: 'purchase, add_to_cart, begin_checkout',
    cmp: 'onetrust',
  },
  {
    name: 'Mailchimp',
    url: 'https://mailchimp.com',
    platform: 'wordpress',
    conversionEvents: 'sign_up, form_submit',
    cmp: 'onetrust',
  },
  {
    name: 'HubSpot',
    url: 'https://www.hubspot.com',
    platform: 'other',
    conversionEvents: 'demo_request, sign_up, form_submit',
    cmp: 'hubspot',
  },
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function runPipeline(site: TestSite): Promise<void> {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  FULL PIPELINE TEST: ${site.name} (${site.url})`);
  console.log(`${'═'.repeat(70)}\n`);

  const startTime = Date.now();

  // ── Create audit entry ──
  const audit = createAudit({
    reference_id: generateReferenceId(),
    website_url: site.url,
    platform: site.platform,
    conversion_events: site.conversionEvents,
    cmp: site.cmp,
    recent_changes: '',
    contact_email: 'test@trackguard.dev',
    company_name: `${site.name} Test`,
  });
  console.log(`[Pipeline] Created audit #${audit.id} (ref: ${audit.reference_id})\n`);

  // ── Step 1: Crawl ──
  console.log(`[Pipeline] Step 1/3: CRAWLING ${site.url}...`);
  const crawlStart = Date.now();
  const { pages, consent } = await crawlSite(audit);
  const crawlMs = Date.now() - crawlStart;

  console.log(`\n[Pipeline] Crawl complete in ${(crawlMs / 1000).toFixed(1)}s`);
  console.log(`  Pages crawled: ${pages.length}`);
  console.log(`  Total GA4 requests: ${pages.reduce((sum, p) => sum + p.ga4Requests.length, 0)}`);
  console.log(`  Total dataLayer events: ${pages.reduce((sum, p) => sum + p.dataLayerEvents.length, 0)}`);
  if (consent) {
    console.log(`  CMP: ${consent.cmpDetected || 'none'}, banner: ${consent.bannerFound}, accepted: ${consent.acceptButtonClicked}`);
  }

  // ── Step 2: AI Analysis ──
  console.log(`\n[Pipeline] Step 2/3: AI ANALYSIS...`);
  updateAuditStatus(audit.id, 'analysing');
  const analyseStart = Date.now();

  const { analysis, scorecard, rawResponse } = await analyseAudit(audit, consent);
  const analyseMs = Date.now() - analyseStart;

  console.log(`\n[Pipeline] Analysis complete in ${(analyseMs / 1000).toFixed(1)}s`);
  console.log(`  Health Score: ${analysis.health_score}/100`);
  console.log(`  Issues: ${analysis.issues.length} (${scorecard.critical_count} critical, ${scorecard.high_count} high, ${scorecard.medium_count} medium, ${scorecard.low_count} low)`);
  console.log(`  Positive findings: ${analysis.positive_findings.length}`);

  // ── Step 3: Report Generation ──
  console.log(`\n[Pipeline] Step 3/3: GENERATING REPORT...`);
  const reportHtml = buildReport(audit, analysis, scorecard, consent);

  // Save to DB
  saveReport({
    audit_id: audit.id,
    ai_analysis: rawResponse,
    scorecard: JSON.stringify(scorecard),
    full_report_html: reportHtml,
  });
  updateAuditStatus(audit.id, 'report_ready');

  // Save HTML file to disk for review
  const reportsDir = path.join(__dirname, '..', 'test-reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const filename = `report-${site.name.toLowerCase()}-${Date.now()}.html`;
  const filepath = path.join(reportsDir, filename);
  fs.writeFileSync(filepath, reportHtml, 'utf-8');

  const totalMs = Date.now() - startTime;

  console.log(`\n[Pipeline] ✓ ${site.name} complete in ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Report saved: ${filepath}`);
  console.log(`  Report size: ${(reportHtml.length / 1024).toFixed(0)} KB`);
  console.log(`  Health Score: ${analysis.health_score}/100`);
  console.log(`  Ref: ${audit.reference_id}`);
}

async function main() {
  console.log('TrackGuard Full Pipeline Test');
  console.log('============================\n');

  // Check API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }
  console.log('✓ API key found\n');

  // Use a test database so we don't pollute the main one
  const testDbPath = './data/test-pipeline.db';
  initDatabase(testDbPath);
  console.log(`✓ Database initialised: ${testDbPath}\n`);

  // Get site to test from command line arg, or run all
  const siteArg = process.argv[2]?.toLowerCase();
  const sitesToTest = siteArg
    ? TEST_SITES.filter(s => s.name.toLowerCase() === siteArg)
    : TEST_SITES;

  if (sitesToTest.length === 0) {
    console.error(`Unknown site: ${siteArg}. Options: ${TEST_SITES.map(s => s.name.toLowerCase()).join(', ')}`);
    process.exit(1);
  }

  const results: { name: string; score: number; issues: number; time: number; file: string }[] = [];

  for (const site of sitesToTest) {
    try {
      const start = Date.now();
      await runPipeline(site);
      // Read back the result for summary
      const elapsed = Date.now() - start;
      results.push({
        name: site.name,
        score: 0, // We'll fill from logs
        issues: 0,
        time: elapsed,
        file: `test-reports/report-${site.name.toLowerCase()}-*.html`,
      });
    } catch (err) {
      console.error(`\n[Pipeline] ✗ ${site.name} FAILED:`, err);
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ALL TESTS COMPLETE`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`\nReports saved in: ${path.resolve('test-reports')}`);
}

main().catch(console.error);
