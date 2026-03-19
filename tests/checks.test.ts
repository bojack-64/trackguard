// tests/checks.test.ts — Unit tests for the 24-check deterministic engine
// Run with: npx tsx tests/checks.test.ts

import { runChecks, CheckResult, ScorecardResult } from '../src/checks';
import { CrawlPageRow } from '../src/database';

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeGA4Request(eventName: string, measurementId: string, gcs = '') {
  const params = new URLSearchParams({ en: eventName, tid: measurementId });
  if (gcs) params.set('gcs', gcs);
  return {
    url: `https://www.google-analytics.com/g/collect?${params.toString()}`,
    measurement_id: measurementId,
    event_names: [eventName],
    params: Object.fromEntries(params),
    timestamp: Date.now(),
  };
}

function makeGTMRequest(containerId: string) {
  return {
    url: `https://www.googletagmanager.com/gtm.js?id=${containerId}`,
    container_id: containerId,
    timestamp: Date.now(),
  };
}

function makeDLEvent(eventName: string, extra: Record<string, any> = {}) {
  return { timestamp: Date.now(), data: { event: eventName, ...extra } };
}

function makePage(overrides: Partial<CrawlPageRow> = {}): CrawlPageRow {
  return {
    id: 1,
    audit_id: 1,
    page_url: 'https://example.com/',
    page_type: 'homepage',
    datalayer_events: '[]',
    ga4_requests: '[]',
    gtm_requests: '[]',
    consent_state: null,
    console_errors: '[]',
    screenshot_path: null,
    page_load_ms: 2000,
    dom_content_loaded_ms: 1500,
    raw_network_log: '[]',
    potential_proxies: null,
    crawled_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeHealthyPage(url: string, pageType: string, id = 1): CrawlPageRow {
  return makePage({
    id,
    page_url: url,
    page_type: pageType,
    ga4_requests: JSON.stringify([makeGA4Request('page_view', 'G-ABC123')]),
    gtm_requests: JSON.stringify([makeGTMRequest('GTM-XYZ789')]),
    datalayer_events: JSON.stringify([makeDLEvent('gtm.js'), makeDLEvent('page_view')]),
    dom_content_loaded_ms: 1500,
  });
}

function makeConsentData(overrides: any = {}): any {
  return {
    cmpDetected: 'OneTrust',
    bannerFound: true,
    bannerScreenshot: null,
    defaultConsentState: { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' },
    acceptButtonFound: true,
    acceptButtonClicked: true,
    postConsentState: { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' },
    postConsentGA4Requests: [makeGA4Request('page_view', 'G-ABC123', 'G111')],
    postConsentDataLayer: [],
    preConsentGA4Requests: [],
    preConsentDataLayer: [],
    errors: [],
    ...overrides,
  };
}

// ─── Test runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${message}`);
  }
}

function findCheck(result: ScorecardResult, id: string): CheckResult | undefined {
  return result.checks.find(c => c.id === id);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

console.log('\n=== GA4 Detection Tests ===\n');

// Test: Healthy site — GA4 detected
{
  const pages = [
    makeHealthyPage('https://example.com/', 'homepage'),
    makeHealthyPage('https://example.com/about', 'about', 2),
  ];
  const result = runChecks(pages, makeConsentData());
  const check = findCheck(result, 'ga4_detected')!;
  assert(check.status === 'pass', 'ga4_detected: PASS when GA4 measurement IDs present');
  assert(check.summary.includes('G-ABC123'), 'ga4_detected: summary lists measurement ID');
}

// Test: No GA4 at all
{
  const pages = [makePage({ page_url: 'https://example.com/', page_type: 'homepage' })];
  const result = runChecks(pages, null);
  const check = findCheck(result, 'ga4_detected')!;
  assert(check.status === 'fail', 'ga4_detected: FAIL when no GA4 detected');
}

// Test: GA4 on all pages
{
  const pages = [
    makeHealthyPage('https://example.com/', 'homepage'),
    makeHealthyPage('https://example.com/product/1', 'product', 2),
  ];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'ga4_all_pages')!.status === 'pass', 'ga4_all_pages: PASS when all pages have GA4');
}

// Test: GA4 missing on one page
{
  const pages = [
    makeHealthyPage('https://example.com/', 'homepage'),
    makePage({ id: 2, page_url: 'https://example.com/about', page_type: 'about' }),
  ];
  const result = runChecks(pages, null);
  const check = findCheck(result, 'ga4_all_pages')!;
  assert(check.status === 'fail', 'ga4_all_pages: FAIL when a page has zero GA4');
  assert(check.summary.includes('1/2'), 'ga4_all_pages: summary shows X/Y count');
}

// Test: Duplicate GA4 measurement IDs on same page
{
  const pages = [makePage({
    page_url: 'https://example.com/',
    page_type: 'homepage',
    ga4_requests: JSON.stringify([
      makeGA4Request('page_view', 'G-ABC123'),
      makeGA4Request('scroll', 'G-DEF456'),
    ]),
  })];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'ga4_duplicate_ids')!.status === 'warn', 'ga4_duplicate_ids: WARN when multiple G- IDs on same page');
}

// Test: Duplicate page_view events
{
  const pages = [makePage({
    page_url: 'https://example.com/',
    page_type: 'homepage',
    ga4_requests: JSON.stringify([
      makeGA4Request('page_view', 'G-ABC123'),
      makeGA4Request('page_view', 'G-ABC123'),
    ]),
  })];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'ga4_duplicate_events')!.status === 'warn', 'ga4_duplicate_events: WARN when 2+ page_view on same page');
}

console.log('\n=== GTM Detection Tests ===\n');

// Test: GTM detected
{
  const pages = [makeHealthyPage('https://example.com/', 'homepage')];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'gtm_detected')!.status === 'pass', 'gtm_detected: PASS when GTM present');
}

// Test: No GTM
{
  const pages = [makePage({
    page_url: 'https://example.com/',
    page_type: 'homepage',
    ga4_requests: JSON.stringify([makeGA4Request('page_view', 'G-ABC123')]),
  })];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'gtm_detected')!.status === 'fail', 'gtm_detected: FAIL when no GTM');
}

// Test: GTM on all pages
{
  const pages = [
    makeHealthyPage('https://example.com/', 'homepage'),
    makeHealthyPage('https://example.com/about', 'about', 2),
  ];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'gtm_all_pages')!.status === 'pass', 'gtm_all_pages: PASS when all pages have GTM');
}

// Test: GTM present but GA4 absent
{
  const pages = [makePage({
    page_url: 'https://example.com/',
    page_type: 'homepage',
    gtm_requests: JSON.stringify([makeGTMRequest('GTM-XYZ789')]),
    ga4_requests: '[]',
  })];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'gtm_present_ga4_absent')!.status === 'warn', 'gtm_present_ga4_absent: WARN when GTM loads but no GA4');
}

// Test: Multiple GTM containers
{
  const pages = [makePage({
    page_url: 'https://example.com/',
    page_type: 'homepage',
    gtm_requests: JSON.stringify([makeGTMRequest('GTM-AAA'), makeGTMRequest('GTM-BBB')]),
    ga4_requests: JSON.stringify([makeGA4Request('page_view', 'G-ABC123')]),
  })];
  const result = runChecks(pages, null);
  const check = findCheck(result, 'gtm_multiple_containers')!;
  assert(check.status === 'info', 'gtm_multiple_containers: INFO when 2 containers');
  assert(check.summary.includes('GTM-AAA') && check.summary.includes('GTM-BBB'), 'gtm_multiple_containers: lists both containers');
}

console.log('\n=== Consent & Privacy Tests ===\n');

// Test: Consent banner detected with proper defaults
{
  const consent = makeConsentData();
  const pages = [makeHealthyPage('https://example.com/', 'homepage')];
  const result = runChecks(pages, consent);
  assert(findCheck(result, 'consent_banner_detected')!.status === 'pass', 'consent_banner_detected: PASS with OneTrust');
  assert(findCheck(result, 'consent_default_state')!.status === 'pass', 'consent_default_state: PASS when defaults denied');
  assert(findCheck(result, 'consent_updates_after_accept')!.status === 'pass', 'consent_updates_after_accept: PASS when state changes');
  assert(findCheck(result, 'ga4_fires_before_consent')!.status === 'pass', 'ga4_fires_before_consent: PASS with no pre-consent requests');
}

// Test: No consent banner
{
  const pages = [makeHealthyPage('https://example.com/', 'homepage')];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'consent_banner_detected')!.status === 'warn', 'consent_banner_detected: WARN with no consent');
}

// Test: Consent defaults to granted (bad)
{
  const consent = makeConsentData({
    defaultConsentState: { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' },
  });
  const pages = [makeHealthyPage('https://example.com/', 'homepage')];
  const result = runChecks(pages, consent);
  assert(findCheck(result, 'consent_default_state')!.status === 'fail', 'consent_default_state: FAIL when defaults granted');
}

// Test: GA4 fires before consent
{
  const consent = makeConsentData({
    preConsentGA4Requests: [makeGA4Request('page_view', 'G-ABC123', 'G111')],
  });
  const pages = [makeHealthyPage('https://example.com/', 'homepage')];
  const result = runChecks(pages, consent);
  assert(findCheck(result, 'ga4_fires_before_consent')!.status === 'fail', 'ga4_fires_before_consent: FAIL with pre-consent requests');
}

// Test: Consent state doesn't change after accept
{
  const consent = makeConsentData({
    defaultConsentState: { ad_storage: 'denied', analytics_storage: 'denied' },
    postConsentState: { ad_storage: 'denied', analytics_storage: 'denied' },
  });
  const pages = [makeHealthyPage('https://example.com/', 'homepage')];
  const result = runChecks(pages, consent);
  assert(findCheck(result, 'consent_updates_after_accept')!.status === 'fail', 'consent_updates_after_accept: FAIL when state unchanged');
}

console.log('\n=== Ecommerce Tests ===\n');

// Test: view_item on product pages
{
  const pages = [makePage({
    page_url: 'https://example.com/products/shoe',
    page_type: 'product',
    ga4_requests: JSON.stringify([makeGA4Request('page_view', 'G-ABC123')]),
    gtm_requests: JSON.stringify([makeGTMRequest('GTM-XYZ')]),
    datalayer_events: JSON.stringify([makeDLEvent('view_item', { ecommerce: { items: [{ item_id: '123', item_name: 'Shoe', price: 99.99 }] } })]),
    dom_content_loaded_ms: 1500,
  })];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'ecommerce_view_item')!.status === 'pass', 'ecommerce_view_item: PASS when view_item fires on product page');
}

// Test: No product pages crawled
{
  const pages = [makeHealthyPage('https://example.com/', 'homepage')];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'ecommerce_view_item')!.status === 'info', 'ecommerce_view_item: INFO when no product pages');
}

// Test: Product page without view_item
{
  const pages = [makePage({
    page_url: 'https://example.com/products/shoe',
    page_type: 'product',
    ga4_requests: JSON.stringify([makeGA4Request('page_view', 'G-ABC123')]),
    gtm_requests: JSON.stringify([makeGTMRequest('GTM-XYZ')]),
    datalayer_events: JSON.stringify([makeDLEvent('page_view')]),
    dom_content_loaded_ms: 1500,
  })];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'ecommerce_view_item')!.status === 'warn', 'ecommerce_view_item: WARN when product page missing view_item');
}

// Test: Conversion note is always INFO
{
  const pages = [makeHealthyPage('https://example.com/', 'homepage')];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'ecommerce_conversion_note')!.status === 'info', 'ecommerce_conversion_note: always INFO');
}

console.log('\n=== Tag Health Tests ===\n');

// Test: Analytics-related console errors
{
  const pages = [makePage({
    page_url: 'https://example.com/',
    page_type: 'homepage',
    console_errors: JSON.stringify(['Failed to load gtm.js', 'Some random error']),
    ga4_requests: JSON.stringify([makeGA4Request('page_view', 'G-ABC123')]),
    gtm_requests: JSON.stringify([makeGTMRequest('GTM-XYZ')]),
    dom_content_loaded_ms: 1500,
  })];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'console_errors_analytics')!.status === 'warn', 'console_errors_analytics: WARN with GTM-related error');
}

// Test: No analytics console errors
{
  const pages = [makePage({
    page_url: 'https://example.com/',
    page_type: 'homepage',
    console_errors: JSON.stringify(['Some random CSS error']),
    ga4_requests: JSON.stringify([makeGA4Request('page_view', 'G-ABC123')]),
    dom_content_loaded_ms: 1500,
  })];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'console_errors_analytics')!.status === 'pass', 'console_errors_analytics: PASS with non-analytics errors only');
}

// Test: Third party tags detection
{
  const pages = [makePage({
    page_url: 'https://example.com/',
    page_type: 'homepage',
    raw_network_log: JSON.stringify([
      { url: 'https://connect.facebook.net/en_US/fbevents.js', method: 'GET', status: 200 },
      { url: 'https://static.hotjar.com/c/hotjar-123.js', method: 'GET', status: 200 },
    ]),
    ga4_requests: JSON.stringify([makeGA4Request('page_view', 'G-ABC123')]),
    dom_content_loaded_ms: 1500,
  })];
  const result = runChecks(pages, null);
  const check = findCheck(result, 'third_party_tags')!;
  assert(check.status === 'info', 'third_party_tags: INFO status');
  assert(check.summary.includes('Meta') && check.summary.includes('Hotjar'), 'third_party_tags: detects Facebook and Hotjar');
}

console.log('\n=== Page Coverage Tests ===\n');

// Test: Pages crawled count
{
  const pages = [
    makeHealthyPage('https://example.com/', 'homepage'),
    makeHealthyPage('https://example.com/about', 'about', 2),
    makeHealthyPage('https://example.com/contact', 'contact', 3),
  ];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'pages_crawled')!.summary.includes('3 pages'), 'pages_crawled: reports correct count');
}

// Test: Failed page detection
{
  const pages = [
    makeHealthyPage('https://example.com/', 'homepage'),
    makePage({ id: 2, page_url: 'https://example.com/broken', page_type: 'other', dom_content_loaded_ms: 0 }),
  ];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'pages_failed')!.status === 'warn', 'pages_failed: WARN when a page fails');
}

// Test: Slow load times
{
  const pages = [makePage({
    page_url: 'https://example.com/',
    page_type: 'homepage',
    ga4_requests: JSON.stringify([makeGA4Request('page_view', 'G-ABC123')]),
    gtm_requests: JSON.stringify([makeGTMRequest('GTM-XYZ')]),
    dom_content_loaded_ms: 15000,
  })];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'load_times')!.status === 'warn', 'load_times: WARN when DCL > 10s');
}

// Test: Good load times
{
  const pages = [makeHealthyPage('https://example.com/', 'homepage')];
  const result = runChecks(pages, null);
  assert(findCheck(result, 'load_times')!.status === 'pass', 'load_times: PASS when DCL < 10s');
}

console.log('\n=== Score Calculation Tests ===\n');

// Test: Perfect score (all pass/info, no warns/fails)
{
  const pages = [
    makeHealthyPage('https://example.com/', 'homepage'),
    makeHealthyPage('https://example.com/about', 'about', 2),
  ];
  const consent = makeConsentData();
  const result = runChecks(pages, consent);
  assert(result.score >= 80, `Perfect site scores >= 80 (got ${result.score})`);
  assert(result.failCount === 0, 'Perfect site has 0 failures');
}

// Test: Terrible site (no GA4, no GTM, no consent)
{
  const pages = [makePage({ page_url: 'https://example.com/', page_type: 'homepage', dom_content_loaded_ms: 1500 })];
  const result = runChecks(pages, null);
  assert(result.failCount >= 2, `Bare site has multiple failures (got ${result.failCount})`);
  assert(result.score < 80, `Bare site scores below 80 (got ${result.score})`);
}

// Test: Score floor at 0
{
  // A site with many failures should not go below 0
  const pages = [makePage({ page_url: 'https://example.com/', page_type: 'homepage', dom_content_loaded_ms: 0 })];
  const consent = makeConsentData({
    defaultConsentState: { ad_storage: 'granted', analytics_storage: 'granted' },
    postConsentState: { ad_storage: 'granted', analytics_storage: 'granted' },
    preConsentGA4Requests: [makeGA4Request('page_view', 'G-XXX', 'G111')],
  });
  const result = runChecks(pages, consent);
  assert(result.score >= 0, 'Score never goes below 0');
}

// Test: Check count
{
  const pages = [makeHealthyPage('https://example.com/', 'homepage')];
  const result = runChecks(pages, makeConsentData());
  // 23 checks + 1 overall_score = 24
  assert(result.checks.length === 24, `Produces exactly 24 checks (got ${result.checks.length})`);
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed!');
}
