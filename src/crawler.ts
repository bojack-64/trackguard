// crawler.ts — Playwright crawl engine
// Visits a website with a headless browser and captures tracking evidence:
// dataLayer pushes, GA4 network requests, GTM loads, console errors, screenshots.
//
// V1 basic crawler: homepage only first. Page discovery, consent interaction,
// and Shopify simulation will be added incrementally.

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { insertCrawlPage, updateAuditStatus, getDb, AuditRow } from './database';

// ─── Types for captured data ────────────────────────────────────────────────

interface DataLayerPush {
  timestamp: number;
  data: unknown;
}

interface GA4Request {
  url: string;
  measurement_id: string | null;
  event_names: string[];
  params: Record<string, string>;
  timestamp: number;
}

interface GTMRequest {
  url: string;
  container_id: string | null;
  timestamp: number;
}

interface ProxyDetection {
  domain: string;
  reason: string; // 'ga4_script' | 'ga4_payload' | 'collect_endpoint'
  url: string;
}

export interface PageCrawlResult {
  pageUrl: string;
  pageType: string;
  dataLayerEvents: DataLayerPush[];
  ga4Requests: GA4Request[];
  gtmRequests: GTMRequest[];
  consoleErrors: string[];
  screenshotPath: string | null;
  pageLoadMs: number;
  domContentLoadedMs: number;
  rawNetworkLog: { url: string; method: string; status: number | null }[];
  potentialProxies: ProxyDetection[];
}

export interface ConsentResult {
  cmpDetected: string | null;       // 'onetrust' | 'cookiebot' | 'generic' | null
  bannerFound: boolean;
  bannerScreenshot: string | null;
  defaultConsentState: Record<string, string> | null;
  acceptButtonFound: boolean;
  acceptButtonClicked: boolean;
  postConsentState: Record<string, string> | null;
  postConsentGA4Requests: GA4Request[];
  postConsentDataLayer: DataLayerPush[];
  preConsentGA4Requests: GA4Request[];
  preConsentDataLayer: DataLayerPush[];
  errors: string[];
}

// ─── GA4 request parser ─────────────────────────────────────────────────────

/**
 * Parse a GA4 collect request URL to extract event names, measurement ID,
 * and key parameters.
 */
function parseGA4Request(url: string): GA4Request {
  try {
    const parsed = new URL(url);
    const params: Record<string, string> = {};

    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });

    const measurementId = params['tid'] || null;
    const eventNames: string[] = [];
    if (params['en']) {
      eventNames.push(params['en']);
    }

    // If no event name found in query params, try to extract from POST body
    // encoded in the URL (some implementations use path-based encoding)
    // Also check for 'ep.event_name' or similar custom params
    if (eventNames.length === 0) {
      // Check for event name in common alternative param keys
      for (const [key, val] of Object.entries(params)) {
        if (key.startsWith('ep.') && key.includes('event')) {
          eventNames.push(val);
        }
      }
    }

    return {
      url: url.substring(0, 500),
      measurement_id: measurementId,
      event_names: eventNames,
      params,
      timestamp: Date.now(),
    };
  } catch {
    return {
      url: url.substring(0, 500),
      measurement_id: null,
      event_names: [],
      params: {},
      timestamp: Date.now(),
    };
  }
}

// ─── Homepage + Consent combined crawl ──────────────────────────────────────

/**
 * Option C: Crawl homepage and handle consent on a SINGLE page.
 * Flow: navigate → read default consent → detect banner → screenshot banner →
 * click accept → wait for banner to disappear → wait for post-consent tracking →
 * read post-consent state → extract ALL data (post-consent) → take viewport screenshot.
 *
 * This matches real user behaviour: land, accept cookies, then everything fires.
 */
async function crawlHomepageWithConsent(
  context: BrowserContext,
  audit: AuditRow
): Promise<{ homepage: PageCrawlResult; consent: ConsentResult | null }> {
  const page = await context.newPage();
  const dataLayerEvents: DataLayerPush[] = [];
  const ga4Requests: GA4Request[] = [];
  const gtmRequests: GTMRequest[] = [];
  const consoleErrors: string[] = [];
  const rawNetworkLog: { url: string; method: string; status: number | null }[] = [];
  const potentialProxies: ProxyDetection[] = [];
  const seenProxyDomains = new Set<string>();
  let screenshotPath: string | null = null;
  let consentResult: ConsentResult | null = null;

  // ── Inject dataLayer + gtag interceptor BEFORE page load ──
  await page.addInitScript(`
    (function() {
      var w = self;
      w.__tg_dl = [];
      w.__tg_gtag = [];

      var origDL = w.dataLayer || [];
      w.dataLayer = origDL;

      for (var i = 0; i < origDL.length; i++) {
        try {
          w.__tg_dl.push({ timestamp: Date.now(), data: JSON.parse(JSON.stringify(origDL[i])) });
        } catch(e) {}
      }

      var origPush = Array.prototype.push;
      origDL.push = function() {
        for (var j = 0; j < arguments.length; j++) {
          try {
            w.__tg_dl.push({ timestamp: Date.now(), data: JSON.parse(JSON.stringify(arguments[j])) });
          } catch(e) {}
        }
        return origPush.apply(this, arguments);
      };

      var origGtag = w.gtag;
      w.gtag = function() {
        try {
          w.__tg_gtag.push({ timestamp: Date.now(), args: JSON.parse(JSON.stringify(Array.from(arguments))) });
        } catch(e) {}
        if (typeof origGtag === 'function') {
          return origGtag.apply(this, arguments);
        }
      };
    })();
  `);

  // ── Capture network requests (runs for entire page lifetime) ──
  page.on('response', (response) => {
    const respUrl = response.url();
    const status = response.status();
    const method = response.request().method();

    // GA4 collect requests
    if (
      respUrl.includes('/g/collect') ||
      respUrl.includes('/g/s/collect') ||
      respUrl.includes('/ccm/collect')
    ) {
      ga4Requests.push(parseGA4Request(respUrl));
    }

    // GTM container loads
    if (
      respUrl.includes('googletagmanager.com/gtm.js') ||
      respUrl.includes('googletagmanager.com/gtag/js')
    ) {
      const containerMatch = respUrl.match(/[?&]id=(GTM-[A-Z0-9]+|G-[A-Z0-9]+)/);
      gtmRequests.push({
        url: respUrl.substring(0, 300),
        container_id: containerMatch ? containerMatch[1] : null,
        timestamp: Date.now(),
      });
    }

    // ── Detect potential GA4 first-party proxies ──
    try {
      const parsedUrl = new URL(respUrl);
      const domain = parsedUrl.hostname;
      const isGoogleDomain = domain.endsWith('google.com') || domain.endsWith('google-analytics.com')
        || domain.endsWith('googletagmanager.com') || domain.endsWith('googleapis.com')
        || domain.endsWith('gstatic.com') || domain.endsWith('doubleclick.net');

      if (!isGoogleDomain && !seenProxyDomains.has(domain)) {
        const pathLower = parsedUrl.pathname.toLowerCase();
        const contentType = response.headers()['content-type'] || '';

        // Signal 1: Non-Google script with GA4/analytics keywords
        if (contentType.includes('javascript') || pathLower.endsWith('.js')) {
          const ga4ScriptPatterns = [
            /ga4/i, /gtag/i, /analytics[_-]?wrapper/i, /measurement/i,
            /google[_-]?tag/i, /g[_-]?collect/i,
          ];
          if (ga4ScriptPatterns.some(p => p.test(pathLower))) {
            seenProxyDomains.add(domain);
            potentialProxies.push({ domain, reason: 'ga4_script', url: respUrl.substring(0, 300) });
          }
        }

        // Signal 2: Non-Google endpoint with GA4 payload parameters
        const params = parsedUrl.searchParams;
        if (params.get('v') === '2' && params.has('tid') && params.has('en')) {
          seenProxyDomains.add(domain);
          potentialProxies.push({ domain, reason: 'ga4_payload', url: respUrl.substring(0, 300) });
        }

        // Signal 3: Non-Google domain with /collect endpoint (exclude static assets)
        const isStaticAsset = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|woff2?|ttf|eot|mp4|mp3)(\?|$)/i.test(respUrl);
        const isCollectEndpoint = /\/(g\/)?collect(\?|$)/.test(pathLower);
        if (!isStaticAsset && isCollectEndpoint && (params.has('tid') || (params.has('v') && params.get('v') === '2'))) {
          if (!seenProxyDomains.has(domain)) {
            seenProxyDomains.add(domain);
            potentialProxies.push({ domain, reason: 'collect_endpoint', url: respUrl.substring(0, 300) });
          }
        }
      }
    } catch { /* URL parsing failed */ }

    // Keep a filtered network log
    if (
      respUrl.includes('google') || respUrl.includes('analytics') ||
      respUrl.includes('gtm') || respUrl.includes('gtag') ||
      respUrl.includes('collect') || respUrl.includes('cookie') ||
      respUrl.includes('consent')
    ) {
      rawNetworkLog.push({ url: respUrl.substring(0, 500), method, status });
    }
  });

  // ── Capture console errors ──
  const analyticsKeywords = ['ga4', 'gtag', 'gtm', 'analytics', 'consent', 'cookie', 'tracking', 'datalayer'];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const text = msg.text().toLowerCase();
      if (analyticsKeywords.some((kw) => text.includes(kw))) {
        consoleErrors.push(`[${msg.type()}] ${msg.text().substring(0, 500)}`);
      }
    }
  });

  // ── Navigate to homepage ──
  const startTime = Date.now();
  let timedOut = false;
  let domContentLoadedMs = 0;

  page.on('domcontentloaded', () => {
    domContentLoadedMs = Date.now() - startTime;
  });

  try {
    await page.goto(audit.website_url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (navError) {
    const msg = navError instanceof Error ? navError.message : String(navError);
    if (msg.includes('Timeout') || msg.includes('timeout')) {
      timedOut = true;
      console.log(`[Crawler] networkidle timeout on homepage — continuing with partial data`);
      consoleErrors.push('Navigation: networkidle timed out after 30s, data captured is partial');
    } else {
      // Fatal navigation error — return error result
      const errMsg = navError instanceof Error ? navError.message : String(navError);
      console.error(`[Crawler] Homepage navigation failed: ${errMsg}`);
      await page.close();
      return {
        homepage: {
          pageUrl: audit.website_url,
          pageType: 'homepage',
          dataLayerEvents: [],
          ga4Requests: [],
          gtmRequests: [],
          consoleErrors: [`Page error: ${errMsg}`],
          screenshotPath: null,
          pageLoadMs: 0,
          domContentLoadedMs: 0,
          rawNetworkLog: [],
          potentialProxies: [],
        },
        consent: null,
      };
    }
  }
  const pageLoadMs = Date.now() - startTime;
  if (domContentLoadedMs === 0 && pageLoadMs > 0) {
    domContentLoadedMs = pageLoadMs;
  }

  // Wait for deferred analytics and SPA rendering
  await page.waitForTimeout(timedOut ? 2000 : 3000);

  // ── Diagnostic logging ──
  const finalUrl = page.url();
  const pageTitle = await page.title().catch(() => '(could not read title)');
  console.log(`[Crawler] Homepage loaded: ${finalUrl} — "${pageTitle}"`);
  if (finalUrl !== audit.website_url) {
    consoleErrors.push(`Redirect: ${audit.website_url} → ${finalUrl}`);
  }

  // ── Wait for DOM stability (SPA rendering) ──
  try {
    await page.waitForFunction(`
      (function() {
        var body = document.body;
        if (!body) return false;
        return body.children.length > 5 && body.scrollHeight > 500;
      })()
    `, { timeout: 8000 });
  } catch {
    console.log('[Crawler] DOM stabilisation timeout on homepage');
  }

  // ── Read DEFAULT consent state (BEFORE accepting) ──
  const defaultConsent = await readConsentState(page);

  // ── Snapshot pre-consent GA4 requests ──
  // Everything captured so far is pre-consent (page loaded, no user interaction)
  const preConsentGA4Count = ga4Requests.length;
  const preConsentGA4 = [...ga4Requests]; // copy for consent result
  const preConsentDL = await page.evaluate('JSON.parse(JSON.stringify(self.__tg_dl || []))') as DataLayerPush[];
  console.log(`[Consent] Pre-consent state: ${preConsentGA4Count} GA4 requests, ${preConsentDL.length} dataLayer events`);

  // ── Detect and handle consent banner — all on THIS page ──
  let bannerFound = false;
  let acceptClicked = false;
  let cmpName: string | null = null;
  let bannerScreenshot: string | null = null;
  let consentClickTimestamp = 0;

  for (const cmp of CMP_CONFIGS) {
    for (const selector of cmp.bannerSelectors) {
      try {
        const banner = await page.$(selector);
        if (banner && await banner.isVisible()) {
          cmpName = cmp.name;
          bannerFound = true;
          console.log(`[Consent] Found ${cmp.name} banner: ${selector}`);

          // Screenshot the banner element
          bannerScreenshot = await takeElementScreenshot(page, banner, audit.id, 'consent-banner');

          // Click Accept
          for (const acceptSel of cmp.acceptSelectors) {
            try {
              const btn = await page.$(acceptSel);
              if (btn && await btn.isVisible()) {
                consentClickTimestamp = Date.now();
                await btn.click();
                acceptClicked = true;
                console.log(`[Consent] Clicked "${acceptSel}" on ${cmp.name} banner`);

                // Wait for banner to ACTUALLY disappear from DOM
                // Poll every 500ms for up to 5 seconds
                for (let i = 0; i < 10; i++) {
                  await page.waitForTimeout(500);
                  const stillVisible = await page.$(selector).then(
                    async el => el ? await el.isVisible().catch(() => false) : false
                  ).catch(() => false);
                  if (!stillVisible) {
                    console.log(`[Consent] Banner disappeared after ${(i + 1) * 500}ms`);
                    break;
                  }
                }

                // Wait for post-consent tags to fire
                await page.waitForTimeout(3000);
                break;
              }
            } catch { /* try next selector */ }
          }
          break;
        }
      } catch { /* try next selector */ }
    }
    if (bannerFound) break;
  }

  // Also try dismissing generic interstitials (age gates, location selectors, popups)
  // Do this AFTER consent banner so the consent banner gets priority
  try {
    const dismissed = await dismissInterstitials(page);
    if (dismissed) {
      await page.waitForTimeout(1500);
    }
  } catch { /* not critical */ }

  if (!bannerFound) {
    console.log('[Consent] No known CMP banner detected');
  }

  // ── Read POST-CONSENT state ──
  const postConsent = acceptClicked ? await readConsentState(page) : null;

  // ── Split GA4 requests into pre-consent and post-consent ──
  // Pre-consent: captured before the consent click
  // Post-consent: captured after the consent click (new requests only)
  let postConsentGA4: GA4Request[] = [];
  let postConsentDL: DataLayerPush[] = [];

  if (acceptClicked && consentClickTimestamp > 0) {
    // Post-consent GA4 = requests with timestamps AFTER the click
    postConsentGA4 = ga4Requests.filter(r => r.timestamp > consentClickTimestamp);
    // Post-consent dataLayer = events with timestamps AFTER the click
    const allDL = await page.evaluate('JSON.parse(JSON.stringify(self.__tg_dl || []))') as DataLayerPush[];
    postConsentDL = allDL.filter(e => e.timestamp > consentClickTimestamp);
    console.log(`[Consent] Post-consent: ${postConsentGA4.length} new GA4 requests, ${postConsentDL.length} new dataLayer events`);
  }

  console.log(
    `[Consent] CMP: ${cmpName || 'none'}, banner: ${bannerFound}, ` +
    `accepted: ${acceptClicked}, post-consent GA4: ${postConsentGA4.length}`
  );

  // Build consent result with BOTH pre and post data
  consentResult = {
    cmpDetected: cmpName,
    bannerFound,
    bannerScreenshot,
    defaultConsentState: defaultConsent,
    acceptButtonFound: acceptClicked,
    acceptButtonClicked: acceptClicked,
    postConsentState: postConsent,
    postConsentGA4Requests: postConsentGA4,
    postConsentDataLayer: postConsentDL,
    preConsentGA4Requests: preConsentGA4,
    preConsentDataLayer: preConsentDL,
    errors: [],
  };

  // ── NOW extract ALL page data (post-consent) ──
  await extractPageData(page, dataLayerEvents);

  // ── For the HOMEPAGE result, only include post-consent GA4 requests ──
  // Pre-consent requests go into the consent result above.
  // If no consent was clicked, all requests are "post-consent" (no gating).
  if (acceptClicked && consentClickTimestamp > 0) {
    // Remove pre-consent requests from the homepage GA4 array
    // ga4Requests was mutated by the listener, so we filter in place
    const postConsentOnly = ga4Requests.filter(r => r.timestamp > consentClickTimestamp);
    ga4Requests.length = 0;
    postConsentOnly.forEach(r => ga4Requests.push(r));
    console.log(`[Crawler] Homepage GA4 filtered to ${ga4Requests.length} post-consent requests (removed ${preConsentGA4Count} pre-consent)`);
  }

  // ── Take viewport screenshot — banner is gone, page is clean ──
  console.log('[Crawler] Taking homepage screenshot (post-consent, banner dismissed)');
  screenshotPath = await takeScreenshot(page, audit.id, 'homepage');

  // Log proxy detections
  if (potentialProxies.length > 0) {
    console.log('[Crawler] Potential GA4 proxies detected on homepage:');
    for (const p of potentialProxies) {
      console.log(`  ${p.domain} (${p.reason}): ${p.url}`);
    }
  }

  console.log(
    `[Crawler] Homepage done (post-consent) — ` +
    `${dataLayerEvents.length} dataLayer events, ` +
    `${ga4Requests.length} GA4 requests, ` +
    `${gtmRequests.length} GTM loads, ` +
    `${pageLoadMs}ms load time`
  );

  await page.close();

  return {
    homepage: {
      pageUrl: audit.website_url,
      pageType: 'homepage',
      dataLayerEvents,
      ga4Requests,
      gtmRequests,
      consoleErrors,
      screenshotPath,
      pageLoadMs,
      domContentLoadedMs,
      rawNetworkLog,
      potentialProxies,
    },
    consent: consentResult,
  };
}

// ─── Main crawl function ────────────────────────────────────────────────────

/**
 * Crawl a website: homepage first (with consent on same page), then discover
 * and crawl up to 7 more high-value pages.
 * Returns page results + consent result.
 */
export async function crawlSite(audit: AuditRow): Promise<{ pages: PageCrawlResult[]; consent: ConsentResult | null }> {
  const results: PageCrawlResult[] = [];
  let browser: Browser | null = null;
  let consentResult: ConsentResult | null = null;

  try {
    console.log(`[Crawler] Starting crawl for ${audit.website_url}`);
    updateAuditStatus(audit.id, 'crawling');

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1440,900',
      ],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      javaScriptEnabled: true,
      // Note: bypassCSP and extraHTTPHeaders intentionally omitted — they break
      // Angular/SPA rendering on sites like Paddy Power. The user agent string
      // and locale are sufficient for realistic browsing behaviour.
    });

    // ── Stealth: mask navigator.webdriver and other automation signals ──
    // Note: languages and plugins overrides are intentionally excluded — they
    // break Angular/SPA rendering on some sites (e.g. Paddy Power). The webdriver
    // flag and chrome object are the most important stealth measures.
    await context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      if (window.chrome === undefined) {
        Object.defineProperty(window, 'chrome', {
          get: () => ({ runtime: {} }),
        });
      }
    `);

    // ── Steps 1+2 combined: Homepage + Consent on ONE page ──
    // Option C: Land on homepage, accept consent, THEN capture all data.
    // This matches real user behaviour and ensures homepage data is post-consent.
    const homepageResult = await crawlHomepageWithConsent(context, audit);

    // Check if homepage completely failed (DNS error, connection refused, etc.)
    const hasFatalError = homepageResult.homepage.pageLoadMs === 0
      && homepageResult.homepage.consoleErrors.some(e => e.startsWith('Page error:')
        && (e.includes('ERR_NAME_NOT_RESOLVED') || e.includes('ERR_CONNECTION_REFUSED')
          || e.includes('ERR_CONNECTION_TIMED_OUT') || e.includes('ERR_ADDRESS_UNREACHABLE')
          || e.includes('chrome-error://') || e.includes('ERR_FAILED')));
    if (hasFatalError) {
      results.push(homepageResult.homepage);
      saveCrawlResult(audit.id, homepageResult.homepage);
      console.log(`[Crawler] Crawl aborted for ${audit.website_url} — site unreachable`);
      return { pages: results, consent: null };
    }

    consentResult = homepageResult.consent;

    // Save consent data as a separate row — store the FULL ConsentResult in consent_state
    // so it can be reconstructed later without the in-memory cache
    if (consentResult) {
      insertCrawlPage({
        audit_id: audit.id,
        page_url: audit.website_url,
        page_type: 'consent_check',
        datalayer_events: JSON.stringify(consentResult.postConsentDataLayer),
        ga4_requests: JSON.stringify(consentResult.postConsentGA4Requests),
        gtm_requests: JSON.stringify([]),
        console_errors: JSON.stringify(consentResult.errors),
        screenshot_path: consentResult.bannerScreenshot || undefined,
        page_load_ms: 0,
        dom_content_loaded_ms: 0,
        raw_network_log: JSON.stringify([]),
        potential_proxies: JSON.stringify([]),
        consent_state: JSON.stringify(consentResult),
      });
    }

    // Save homepage result (all data is post-consent)
    results.push(homepageResult.homepage);
    saveCrawlResult(audit.id, homepageResult.homepage);

    // ── Step 3: Discover pages from homepage links ──
    // We need the homepage page object for link extraction, but crawlPage
    // closes its page. So we open a lightweight page just for link discovery.
    // IMPORTANT: Use networkidle + DOM stability check for SPAs (Angular, React, Vue)
    // that render navigation links dynamically after the HTML shell loads.
    let discoveredPages: DiscoveredPage[] = [];
    try {
      const discoveryPage = await context.newPage();
      try {
        await discoveryPage.goto(audit.website_url, {
          waitUntil: 'networkidle',
          timeout: 20000,
        });
      } catch (navErr) {
        const msg = navErr instanceof Error ? navErr.message : '';
        if (!msg.includes('Timeout') && !msg.includes('timeout')) throw navErr;
        // Timeout is fine — continue with whatever is rendered
      }

      // Wait for SPA navigation links to render — poll until we have
      // a reasonable number of anchor elements in the DOM
      try {
        await discoveryPage.waitForFunction(`
          (function() {
            var anchors = document.querySelectorAll('a[href]');
            return anchors.length > 10;
          })()
        `, { timeout: 8000 });
      } catch {
        // Didn't get many links — proceed with what we have
        console.log('[Crawler] Link discovery: few links found after waiting, proceeding with available');
      }

      discoveredPages = await discoverPages(discoveryPage, audit.website_url, 7);
      await discoveryPage.close();

      console.log(
        `[Crawler] Discovered ${discoveredPages.length} pages: ` +
        discoveredPages.map((p) => `${p.pageType} (${p.url})`).join(', ')
      );
    } catch (discoveryErr) {
      console.error('[Crawler] Page discovery failed, continuing with homepage only:', discoveryErr);
    }

    // ── Step 4: Crawl discovered pages ──
    for (const discovered of discoveredPages) {
      try {
        console.log(`[Crawler] Crawling ${discovered.pageType}: ${discovered.url}`);
        const pageResult = await crawlPage(context, audit, discovered.url, discovered.pageType);
        results.push(pageResult);
        saveCrawlResult(audit.id, pageResult);
      } catch (pageErr) {
        console.error(`[Crawler] Failed to crawl ${discovered.url}:`, pageErr);
        // Continue with other pages — don't let one failure stop the crawl
      }
    }

    updateAuditStatus(audit.id, 'crawl_complete');
    console.log(
      `[Crawler] Crawl complete for ${audit.website_url} — ` +
      `${results.length} pages crawled`
    );
  } catch (error) {
    console.error(`[Crawler] Fatal error crawling ${audit.website_url}:`, error);
    updateAuditStatus(audit.id, 'error');
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return { pages: results, consent: consentResult };
}

/** Save a single page crawl result to the database. */
function saveCrawlResult(auditId: number, result: PageCrawlResult): void {
  insertCrawlPage({
    audit_id: auditId,
    page_url: result.pageUrl,
    page_type: result.pageType,
    datalayer_events: JSON.stringify(result.dataLayerEvents),
    ga4_requests: JSON.stringify(result.ga4Requests),
    gtm_requests: JSON.stringify(result.gtmRequests),
    console_errors: JSON.stringify(result.consoleErrors),
    screenshot_path: result.screenshotPath || undefined,
    page_load_ms: result.pageLoadMs,
    dom_content_loaded_ms: result.domContentLoadedMs,
    raw_network_log: JSON.stringify(result.rawNetworkLog),
    potential_proxies: JSON.stringify(result.potentialProxies || []),
  });
}

// ─── Page Discovery ─────────────────────────────────────────────────────────

/** A discovered link with its classified page type. */
interface DiscoveredPage {
  url: string;
  pageType: string;
  priority: number; // lower = higher priority
}

/**
 * URL path patterns used to classify internal links into page types.
 * Order matters — first match wins. Patterns are tested against the pathname.
 */
const PAGE_TYPE_RULES: { type: string; patterns: RegExp[]; priority: number }[] = [
  {
    type: 'product',
    patterns: [
      /\/products?\//i,
      /\/shop\/.+/i,
      /\/item\//i,
      /\/p\//i,
    ],
    priority: 1,
  },
  {
    type: 'category',
    patterns: [
      /\/collections?\//i,
      /\/categor(y|ies)\//i,
      /\/shop\/?$/i,
      /\/store\/?$/i,
      /\/catalog/i,
    ],
    priority: 2,
  },
  {
    type: 'cart',
    patterns: [
      /\/cart(\/|$|\?)/i,
      /\/basket(\/|$|\?)/i,
      /\/bag(\/|$|\?)/i,
    ],
    priority: 3,
  },
  {
    type: 'checkout',
    patterns: [
      /\/checkout/i,
      /\/pay/i,
      /\/order/i,
    ],
    priority: 4,
  },
  {
    type: 'contact',
    patterns: [
      /\/contact/i,
      /\/get-in-touch/i,
      /\/enquir/i,
      /\/request/i,
      /\/demo/i,
      /\/book/i,
      /\/schedule/i,
      /\/quote/i,
      /\/free-trial/i,
      /\/sign-?up/i,
      /\/register/i,
      /\/get-started/i,
    ],
    priority: 5,
  },
  {
    type: 'thank_you',
    patterns: [
      /\/thank/i,
      /\/confirmation/i,
      /\/success/i,
      /\/order-complete/i,
    ],
    priority: 6,
  },
  {
    type: 'pricing',
    patterns: [
      /\/pricing/i,
      /\/plans/i,
      /\/packages/i,
    ],
    priority: 7,
  },
  {
    type: 'about',
    patterns: [
      /\/about/i,
      /\/company/i,
      /\/our-story/i,
    ],
    priority: 8,
  },
  {
    type: 'blog',
    patterns: [
      /\/blog/i,
      /\/news/i,
      /\/articles?/i,
      /\/resources/i,
    ],
    priority: 9,
  },
];

/**
 * Classify a URL path into a page type. Returns 'other' if no pattern matches.
 */
function classifyPage(pathname: string): { type: string; priority: number } {
  for (const rule of PAGE_TYPE_RULES) {
    if (rule.patterns.some((p) => p.test(pathname))) {
      return { type: rule.type, priority: rule.priority };
    }
  }
  return { type: 'other', priority: 100 };
}

/**
 * Extract internal links from a page and classify them.
 * Returns up to `maxPages` unique discovered pages, prioritised by type.
 */
async function discoverPages(
  page: Page,
  siteOrigin: string,
  maxPages: number = 7
): Promise<DiscoveredPage[]> {
  // Extract all href values from the page
  const hrefs: string[] = await page.evaluate(`
    (function() {
      var anchors = document.querySelectorAll('a[href]');
      var links = [];
      anchors.forEach(function(a) {
        var href = a.getAttribute('href');
        if (href) links.push(href);
      });
      return links;
    })()
  `) as string[];

  const seen = new Set<string>();
  const discovered: DiscoveredPage[] = [];

  for (const href of hrefs) {
    try {
      // Resolve relative URLs against the site origin
      const resolved = new URL(href, siteOrigin);

      // Only internal links
      if (resolved.origin !== new URL(siteOrigin).origin) continue;

      // Strip hash, tracking params, and trailing slash for deduplication
      resolved.hash = '';
      // Remove common tracking/analytics query params for dedup purposes
      const paramsToStrip = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'ref', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
      ];
      // Also strip any param starting with a_ajs_ (Segment), _pos, _fid, _ss
      const keysToRemove: string[] = [];
      resolved.searchParams.forEach((_val, key) => {
        if (paramsToStrip.includes(key) || key.startsWith('a_ajs_') || key.startsWith('_')) {
          keysToRemove.push(key);
        }
      });
      keysToRemove.forEach((k) => resolved.searchParams.delete(k));

      const normalised = resolved.href.replace(/\/+$/, '');

      // Skip if already seen, or is the homepage
      if (seen.has(normalised)) continue;
      const homepageNorm = siteOrigin.replace(/\/+$/, '');
      if (normalised === homepageNorm) continue;

      seen.add(normalised);

      // Skip non-page resources
      const ext = resolved.pathname.split('.').pop()?.toLowerCase();
      if (ext && ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'pdf', 'css', 'js', 'xml', 'ico', 'mp4', 'mp3', 'zip'].includes(ext)) {
        continue;
      }

      // Skip common junk paths
      if (/\/(cdn|assets|static|fonts|images|img|wp-content|wp-admin|wp-includes)\//i.test(resolved.pathname)) {
        continue;
      }

      const { type, priority } = classifyPage(resolved.pathname);
      discovered.push({ url: resolved.href, pageType: type, priority });
    } catch {
      // Invalid URL — skip
    }
  }

  // Sort by priority (high-value pages first), then deduplicate by type
  // (keep only the first URL per type, except 'other' which can have multiple)
  discovered.sort((a, b) => a.priority - b.priority);

  const selected: DiscoveredPage[] = [];
  const typeCounts = new Map<string, number>();

  for (const page of discovered) {
    if (selected.length >= maxPages) break;

    const count = typeCounts.get(page.pageType) || 0;
    // Allow 1 of each named type, up to 5 'other' pages for breadth.
    // Sites that don't match standard e-commerce patterns (betting, SaaS,
    // media sites) will have most pages as 'other' — we still want coverage.
    const maxPerType = page.pageType === 'other' ? 5 : 1;
    if (count >= maxPerType) continue;

    typeCounts.set(page.pageType, count + 1);
    selected.push(page);
  }

  return selected;
}

// ─── Consent Interaction ────────────────────────────────────────────────────

/**
 * Selectors for common consent management platforms.
 * Each entry: { name, bannerSelectors, acceptSelectors }
 * bannerSelectors: CSS selectors to detect the banner container
 * acceptSelectors: CSS selectors for the "accept all" button
 */
const CMP_CONFIGS = [
  {
    name: 'onetrust',
    bannerSelectors: ['#onetrust-banner-sdk', '#onetrust-consent-sdk', '.onetrust-pc-dark-filter'],
    acceptSelectors: ['#onetrust-accept-btn-handler', '.onetrust-close-btn-handler', 'button[id*="accept"]'],
  },
  {
    name: 'cookiebot',
    bannerSelectors: ['#CybotCookiebotDialog', '#CybotCookiebotDialogBody', '[id*="Cookiebot"]'],
    acceptSelectors: ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept', 'a[id*="AllowAll"]'],
  },
  {
    name: 'quantcast',
    bannerSelectors: ['.qc-cmp2-container', '#qc-cmp2-container', '.qc-cmp-ui-container'],
    acceptSelectors: ['[mode="primary"]', 'button.qc-cmp2-summary-buttons', '.qc-cmp2-summary-buttons button:first-child'],
  },
  {
    name: 'hubspot',
    bannerSelectors: ['#hs-eu-cookie-confirmation', '#hs-banner-parent'],
    acceptSelectors: ['#hs-eu-confirmation-button', '#hs-eu-cookie-confirmation-accept'],
  },
  {
    name: 'shopify',
    bannerSelectors: ['#shopify-pc__banner', '.shopify-pc__banner__dialog'],
    acceptSelectors: ['#shopify-pc__banner__btn-accept', '.shopify-pc__banner__btn-accept'],
  },
  {
    name: 'generic',
    bannerSelectors: [
      '[class*="cookie-banner"]', '[class*="cookie-consent"]', '[class*="cookie-notice"]',
      '[class*="consent-banner"]', '[class*="consent-bar"]', '[class*="gdpr"]',
      '[id*="cookie-banner"]', '[id*="cookie-consent"]', '[id*="cookie-notice"]',
      '[id*="consent-banner"]', '[id*="gdpr"]',
      '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
    ],
    acceptSelectors: [
      'button[class*="accept" i]', 'button[id*="accept" i]',
      'a[class*="accept" i]', 'a[id*="accept" i]',
      'button[class*="agree" i]', 'button[id*="agree" i]',
      'button[class*="allow" i]', 'button[id*="allow" i]',
      'button[class*="consent" i]',
      '[data-action="accept"]', '[data-action="agree"]',
    ],
  },
];

/**
 * Read the current Google Consent Mode v2 state from the page.
 * Checks dataLayer for consent events and gtag consent API.
 */
async function readConsentState(page: Page): Promise<Record<string, string> | null> {
  try {
    const state = await page.evaluate(`
      (function() {
        var result = {};
        var found = false;

        // Method 1: Check dataLayer for consent_default or consent_update events
        if (self.dataLayer) {
          for (var i = self.dataLayer.length - 1; i >= 0; i--) {
            var entry = self.dataLayer[i];
            // GTM consent format
            if (entry && entry[0] === 'consent' && (entry[1] === 'default' || entry[1] === 'update')) {
              var data = entry[2] || {};
              for (var k in data) { result[k] = data[k]; found = true; }
            }
            // dataLayer push format (HubSpot style)
            if (entry && entry.event === 'gtm_consent_update' && entry.value) {
              var v = entry.value || entry;
              for (var k2 in v) { if (k2 !== 'event') { result[k2] = v[k2]; found = true; } }
            }
            if (entry && typeof entry === 'object' && entry.value && entry.value.event === 'gtm_consent_update') {
              var v2 = entry.value;
              for (var k3 in v2) { if (k3 !== 'event') { result[k3] = v2[k3]; found = true; } }
            }
            // OneTrust / Elevar consent_v2 format
            if (entry && entry.marketing && entry.marketing.consent_v2) {
              var cv = entry.marketing.consent_v2;
              for (var k4 in cv) {
                if (typeof cv[k4] === 'object' && cv[k4].default !== undefined) {
                  result[k4] = cv[k4].default ? 'granted' : 'denied';
                } else {
                  result[k4] = String(cv[k4]);
                }
                found = true;
              }
            }
          }
        }

        // Method 2: Check Google's consent API via __tcfapi or google_tag_data
        if (self.google_tag_data && self.google_tag_data.ics && self.google_tag_data.ics.entries) {
          var entries = self.google_tag_data.ics.entries;
          for (var key in entries) {
            if (entries[key] && entries[key].hasOwnProperty('default')) {
              result[key] = entries[key].default ? 'granted' : 'denied';
              found = true;
            }
            if (entries[key] && entries[key].hasOwnProperty('update')) {
              result[key] = entries[key].update ? 'granted' : 'denied';
              found = true;
            }
          }
        }

        return found ? result : null;
      })()
    `);
    return state as Record<string, string> | null;
  } catch {
    return null;
  }
}

/**
 * Detect consent banner, screenshot it, click Accept All, and capture
 * the before/after consent state + any new GA4 requests that fire.
 *
 * Only runs on the homepage.
 */
async function handleConsent(
  context: BrowserContext,
  audit: AuditRow
): Promise<ConsentResult> {
  const result: ConsentResult = {
    cmpDetected: null,
    bannerFound: false,
    bannerScreenshot: null,
    defaultConsentState: null,
    acceptButtonFound: false,
    acceptButtonClicked: false,
    postConsentState: null,
    postConsentGA4Requests: [],
    postConsentDataLayer: [],
    preConsentGA4Requests: [],
    preConsentDataLayer: [],
    errors: [],
  };

  const page = await context.newPage();

  try {
    // Inject the same dataLayer interceptor
    await page.addInitScript(`
      (function() {
        var w = self;
        w.__tg_dl = [];
        w.__tg_gtag = [];
        var origDL = w.dataLayer || [];
        w.dataLayer = origDL;
        var origPush = Array.prototype.push;
        origDL.push = function() {
          for (var j = 0; j < arguments.length; j++) {
            try {
              w.__tg_dl.push({ timestamp: Date.now(), data: JSON.parse(JSON.stringify(arguments[j])) });
            } catch(e) {}
          }
          return origPush.apply(this, arguments);
        };
        var origGtag = w.gtag;
        w.gtag = function() {
          try {
            w.__tg_gtag.push({ timestamp: Date.now(), args: JSON.parse(JSON.stringify(Array.from(arguments))) });
          } catch(e) {}
          if (typeof origGtag === 'function') return origGtag.apply(this, arguments);
        };
      })();
    `);

    // Track GA4 requests that fire after consent
    const postConsentGA4: GA4Request[] = [];
    page.on('response', (response) => {
      const respUrl = response.url();
      if (
        respUrl.includes('/g/collect') ||
        respUrl.includes('/g/s/collect') ||
        respUrl.includes('/ccm/collect')
      ) {
        postConsentGA4.push(parseGA4Request(respUrl));
      }
    });

    // Navigate to homepage
    try {
      await page.goto(audit.website_url, {
        waitUntil: 'networkidle',
        timeout: 20000,
      });
    } catch (navErr) {
      const msg = navErr instanceof Error ? navErr.message : '';
      if (!msg.includes('Timeout') && !msg.includes('timeout')) throw navErr;
    }

    // Wait for consent banners to render (they often load with a delay)
    await page.waitForTimeout(2000);

    // ── Read default consent state BEFORE interacting ──
    result.defaultConsentState = await readConsentState(page);

    // ── Detect which CMP is present ──
    for (const cmp of CMP_CONFIGS) {
      for (const selector of cmp.bannerSelectors) {
        try {
          const banner = await page.$(selector);
          if (banner && await banner.isVisible()) {
            result.cmpDetected = cmp.name;
            result.bannerFound = true;

            // Screenshot just the banner element (falls back to viewport if element capture fails)
            result.bannerScreenshot = await takeElementScreenshot(page, banner, audit.id, 'consent-banner');

            // Try to find and click Accept All
            for (const acceptSel of cmp.acceptSelectors) {
              try {
                const acceptBtn = await page.$(acceptSel);
                if (acceptBtn && await acceptBtn.isVisible()) {
                  result.acceptButtonFound = true;

                  // Clear the GA4 request tracker so we only capture post-consent
                  postConsentGA4.length = 0;

                  // Clear the dataLayer capture so we only get post-consent events
                  await page.evaluate('self.__tg_dl = []; self.__tg_gtag = [];');

                  // Click Accept All
                  await acceptBtn.click();
                  result.acceptButtonClicked = true;
                  console.log(`[Consent] Clicked "${acceptSel}" on ${cmp.name} banner`);

                  // Wait for post-consent tags to fire
                  await page.waitForTimeout(3000);

                  // Read post-consent state
                  result.postConsentState = await readConsentState(page);

                  // Capture post-consent GA4 requests
                  result.postConsentGA4Requests = [...postConsentGA4];

                  // Capture post-consent dataLayer events
                  try {
                    const dlCaptures = await page.evaluate('self.__tg_dl || []') as DataLayerPush[];
                    result.postConsentDataLayer = dlCaptures;
                  } catch { /* ignore */ }

                  break; // Done — found and clicked accept
                }
              } catch { /* selector not found, try next */ }
            }
            break; // Done — found the banner
          }
        } catch { /* selector not found, try next */ }
      }
      if (result.bannerFound) break; // Stop checking other CMPs
    }

    // If banner was found via generic selectors, check for known CMP scripts/objects
    // to upgrade the CMP name (e.g. OneTrust on SPAs where banner SDK renders late)
    if (result.bannerFound && result.cmpDetected === 'generic') {
      const detectedCmp = await page.evaluate(`
        (function() {
          // OneTrust: check for SDK object or CDN scripts
          if (typeof window.OneTrust !== 'undefined' || typeof window.OptanonWrapper !== 'undefined') return 'onetrust';
          var scripts = document.querySelectorAll('script[src]');
          for (var i = 0; i < scripts.length; i++) {
            var src = scripts[i].src.toLowerCase();
            if (src.includes('cookielaw.org') || src.includes('onetrust.com') || src.includes('optanon')) return 'onetrust';
            if (src.includes('cookiebot.com') || src.includes('cybot')) return 'cookiebot';
            if (src.includes('quantcast.com') || src.includes('quantcast.mgr')) return 'quantcast';
          }
          return null;
        })()
      `) as string | null;
      if (detectedCmp) {
        console.log(`[Consent] Upgrading CMP from "generic" to "${detectedCmp}" (detected via scripts/objects)`);
        result.cmpDetected = detectedCmp;
      }
    }

    // If no banner found at all
    if (!result.bannerFound) {
      console.log('[Consent] No known CMP banner detected');
    }

    console.log(
      `[Consent] CMP: ${result.cmpDetected || 'none'}, ` +
      `banner: ${result.bannerFound}, ` +
      `accepted: ${result.acceptButtonClicked}, ` +
      `post-consent GA4: ${result.postConsentGA4Requests.length}`
    );

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[Consent] Error:', errMsg);
    result.errors.push(errMsg);
  } finally {
    await page.close();
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract dataLayer and gtag captures from the page.
 * Safe to call even if the page partially loaded.
 */
async function extractPageData(page: Page, dataLayerEvents: DataLayerPush[]): Promise<void> {
  try {
    const dlCaptures = await page.evaluate('self.__tg_dl || []') as DataLayerPush[];
    dataLayerEvents.push(...dlCaptures);
  } catch { /* page context may be gone */ }

  try {
    const gtagCaptures = await page.evaluate('self.__tg_gtag || []') as { timestamp: number; args: unknown[] }[];
    for (const call of gtagCaptures) {
      dataLayerEvents.push({
        timestamp: call.timestamp,
        data: { _type: 'gtag_call', args: call.args },
      });
    }
  } catch { /* page context may be gone */ }
}

/**
 * Take a screenshot. Returns the relative path, or null if it fails.
 * By default captures viewport only (above-the-fold). Use fullPage for full-page captures.
 */
async function takeScreenshot(page: Page, auditId: number, pageType: string, fullPage = false): Promise<string | null> {
  try {
    const screenshotsDir = path.join(__dirname, '..', 'public', 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    const filename = `audit-${auditId}-${pageType}-${Date.now()}.png`;
    await page.screenshot({
      path: path.join(screenshotsDir, filename),
      fullPage,
    });
    return `screenshots/${filename}`;
  } catch {
    return null;
  }
}

/**
 * Take a screenshot of a specific element. Falls back to viewport screenshot if element capture fails.
 */
async function takeElementScreenshot(page: Page, element: import('playwright').ElementHandle, auditId: number, label: string): Promise<string | null> {
  try {
    const screenshotsDir = path.join(__dirname, '..', 'public', 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    const filename = `audit-${auditId}-${label}-${Date.now()}.png`;
    await element.screenshot({
      path: path.join(screenshotsDir, filename),
    });
    return `screenshots/${filename}`;
  } catch {
    // Fall back to viewport screenshot
    return takeScreenshot(page, auditId, label);
  }
}

// ─── Interstitial / Modal Dismissal ──────────────────────────────────────────

/**
 * Common selectors for interstitials, modals, overlays, and gates that block
 * page content. Tries to click dismiss/close/continue buttons.
 * Returns true if something was dismissed.
 */
async function dismissInterstitials(page: Page): Promise<boolean> {
  // Selectors for modal/overlay close or dismiss buttons (ordered by specificity)
  const dismissSelectors = [
    // Close buttons
    '[class*="modal"] [class*="close"]',
    '[class*="overlay"] [class*="close"]',
    '[class*="dialog"] [class*="close"]',
    '[class*="popup"] [class*="close"]',
    '[aria-label="Close"]',
    '[aria-label="close"]',
    'button[class*="dismiss"]',
    'button[class*="close-btn"]',
    '.modal-close',
    '.close-modal',

    // Age verification / location gates
    'button[class*="enter" i]',
    'button[class*="verify" i]',
    'a[class*="enter-site" i]',
    '[class*="age-gate"] button',
    '[class*="age-verify"] button',

    // Shopify-specific popups (country selector, newsletter, shipping notice)
    '[data-testid="geofencing-modal"] button:first-of-type', // Allbirds "Where are we shipping to?" X button
    '[data-section-type="geofencing"] button:first-of-type',
    '[class*="country-selector"] [class*="close"]',
    '[class*="country-selector"] button[class*="dismiss"]',
    '[class*="shipping"] [class*="close"]',
    '[class*="shipping-modal"] [class*="close"]',
    '[class*="announcement"] [class*="close"]',
    'form[class*="newsletter"] [class*="close"]',
    '[class*="newsletter-popup"] [class*="close"]',
    '[class*="popup-modal"] [class*="close"]',
    '.shopify-section-popup [class*="close"]',
    // Generic "Where do you want to ship?" / locale selectors
    '[class*="locale-selector"] [class*="close"]',
    '[class*="locale"] button[class*="confirm"]',
    '[class*="geo"] [class*="close"]',
    '[class*="geo-modal"] button',
    'button[class*="stay-on-site" i]',

    // "Continue" / "Accept" / "Got it" buttons on interstitials
    '[class*="interstitial"] button',
    '[class*="splash"] button',
    '[class*="welcome"] button[class*="continue" i]',
    '[class*="welcome"] button[class*="accept" i]',
    'button[class*="got-it" i]',
    'button[class*="continue" i]',
  ];

  for (const selector of dismissSelectors) {
    try {
      const el = await page.$(selector);
      if (el && await el.isVisible()) {
        const text = (await el.textContent() || '').trim();
        // Sanity check: don't click things that look like navigation or login
        const safeText = text.toLowerCase();
        if (safeText.includes('sign up') || safeText.includes('register') ||
            safeText.includes('login') || safeText.includes('log in') ||
            safeText.includes('subscribe')) {
          continue;
        }
        await el.click();
        console.log(`[Crawler] Dismissed interstitial: clicked "${selector}" (text: "${text.substring(0, 50)}")`);
        return true;
      }
    } catch {
      // Selector not found or not clickable — try next
    }
  }

  return false;
}

// ─── Single page crawl ─────────────────────────────────────────────────────

/**
 * Crawl one page: inject dataLayer interceptor before load, capture GA4/GTM
 * network requests, take a screenshot, and collect console errors.
 */
async function crawlPage(
  context: BrowserContext,
  audit: AuditRow,
  url: string,
  pageType: string,
  skipScreenshot = false
): Promise<PageCrawlResult> {
  const page = await context.newPage();
  const dataLayerEvents: DataLayerPush[] = [];
  const ga4Requests: GA4Request[] = [];
  const gtmRequests: GTMRequest[] = [];
  const consoleErrors: string[] = [];
  const rawNetworkLog: { url: string; method: string; status: number | null }[] = [];
  const potentialProxies: ProxyDetection[] = [];
  const seenProxyDomains = new Set<string>();
  let screenshotPath: string | null = null;

  try {
    // ── Inject dataLayer + gtag interceptor BEFORE page load ──
    // Note: this function runs in the BROWSER context, not Node.
    // We use 'self' instead of 'window' to avoid TypeScript errors.
    await page.addInitScript(`
      (function() {
        var w = self;
        w.__tg_dl = [];
        w.__tg_gtag = [];

        var origDL = w.dataLayer || [];
        w.dataLayer = origDL;

        for (var i = 0; i < origDL.length; i++) {
          try {
            w.__tg_dl.push({ timestamp: Date.now(), data: JSON.parse(JSON.stringify(origDL[i])) });
          } catch(e) {}
        }

        var origPush = Array.prototype.push;
        origDL.push = function() {
          for (var j = 0; j < arguments.length; j++) {
            try {
              w.__tg_dl.push({ timestamp: Date.now(), data: JSON.parse(JSON.stringify(arguments[j])) });
            } catch(e) {}
          }
          return origPush.apply(this, arguments);
        };

        var origGtag = w.gtag;
        w.gtag = function() {
          try {
            w.__tg_gtag.push({ timestamp: Date.now(), args: JSON.parse(JSON.stringify(Array.from(arguments))) });
          } catch(e) {}
          if (typeof origGtag === 'function') {
            return origGtag.apply(this, arguments);
          }
        };
      })();
    `);

    // ── Capture network requests ──
    page.on('response', (response) => {
      const respUrl = response.url();
      const status = response.status();
      const method = response.request().method();

      // GA4 collect requests — match all known endpoints including
      // server-side GTM proxies (e.g. site.com/gtm/g/collect),
      // doubleclick, and conversion measurement
      if (
        respUrl.includes('/g/collect') ||
        respUrl.includes('/g/s/collect') ||
        respUrl.includes('/ccm/collect')
      ) {
        ga4Requests.push(parseGA4Request(respUrl));
      }

      // GTM container loads
      if (
        respUrl.includes('googletagmanager.com/gtm.js') ||
        respUrl.includes('googletagmanager.com/gtag/js')
      ) {
        const containerMatch = respUrl.match(/[?&]id=(GTM-[A-Z0-9]+|G-[A-Z0-9]+)/);
        gtmRequests.push({
          url: respUrl.substring(0, 300),
          container_id: containerMatch ? containerMatch[1] : null,
          timestamp: Date.now(),
        });
      }

      // ── Detect potential GA4 first-party proxies ──
      // Look for non-Google domains serving GA4-related scripts or collect endpoints
      try {
        const parsedUrl = new URL(respUrl);
        const domain = parsedUrl.hostname;
        const isGoogleDomain = domain.endsWith('google.com') || domain.endsWith('google-analytics.com')
          || domain.endsWith('googletagmanager.com') || domain.endsWith('googleapis.com')
          || domain.endsWith('gstatic.com') || domain.endsWith('doubleclick.net');

        if (!isGoogleDomain && !seenProxyDomains.has(domain)) {
          const urlLower = respUrl.toLowerCase();
          const pathLower = parsedUrl.pathname.toLowerCase();
          const contentType = response.headers()['content-type'] || '';

          // Signal 1: Non-Google script with GA4/analytics keywords in path or filename
          if (contentType.includes('javascript') || pathLower.endsWith('.js')) {
            const ga4ScriptPatterns = [
              /ga4/i, /gtag/i, /analytics[_-]?wrapper/i, /measurement/i,
              /google[_-]?tag/i, /g[_-]?collect/i,
            ];
            if (ga4ScriptPatterns.some(p => p.test(pathLower))) {
              seenProxyDomains.add(domain);
              potentialProxies.push({
                domain,
                reason: 'ga4_script',
                url: respUrl.substring(0, 300),
              });
            }
          }

          // Signal 2: Non-Google endpoint with GA4 payload parameters (v=2&tid=&en=)
          const params = parsedUrl.searchParams;
          if (params.get('v') === '2' && params.has('tid') && params.has('en')) {
            seenProxyDomains.add(domain);
            potentialProxies.push({
              domain,
              reason: 'ga4_payload',
              url: respUrl.substring(0, 300),
            });
          }

          // Signal 3: Non-Google domain with /collect endpoint and GA4-style path
          // Must match actual collect endpoints, not paths like /collections/ or /cdn/shop/collect*
          const isStaticAsset = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|woff2?|ttf|eot|mp4|mp3)(\?|$)/i.test(respUrl);
          const isCollectEndpoint = /\/(g\/)?collect(\?|$)/.test(pathLower);
          if (!isStaticAsset && isCollectEndpoint && (params.has('tid') || (params.has('v') && params.get('v') === '2'))) {
            if (!seenProxyDomains.has(domain)) {
              seenProxyDomains.add(domain);
              potentialProxies.push({
                domain,
                reason: 'collect_endpoint',
                url: respUrl.substring(0, 300),
              });
            }
          }
        }
      } catch { /* URL parsing failed — skip proxy check */ }

      // Keep a filtered network log (analytics-related only)
      if (
        respUrl.includes('google') ||
        respUrl.includes('analytics') ||
        respUrl.includes('gtm') ||
        respUrl.includes('gtag') ||
        respUrl.includes('collect') ||
        respUrl.includes('cookie') ||
        respUrl.includes('consent')
      ) {
        rawNetworkLog.push({
          url: respUrl.substring(0, 500),
          method,
          status,
        });
      }
    });

    // ── Capture console errors related to analytics ──
    const analyticsKeywords = ['ga4', 'gtag', 'gtm', 'analytics', 'consent', 'cookie', 'tracking', 'datalayer'];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        const text = msg.text().toLowerCase();
        if (analyticsKeywords.some((kw) => text.includes(kw))) {
          consoleErrors.push(`[${msg.type()}] ${msg.text().substring(0, 500)}`);
        }
      }
    });

    // ── Navigate ──
    // Strategy: try networkidle (best for analytics — waits for all tags to fire).
    // If it times out (heavy sites), fall back to domcontentloaded so we still
    // capture whatever has loaded. Either way, we proceed to extract data.
    // We capture DOMContentLoaded timing separately — that's the meaningful
    // "page load" time. networkidle timeout is NOT a real load time.
    const startTime = Date.now();
    let timedOut = false;
    let domContentLoadedMs = 0;

    // Listen for DOMContentLoaded to get the real page load time
    page.on('domcontentloaded', () => {
      domContentLoadedMs = Date.now() - startTime;
    });

    try {
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    } catch (navError) {
      const msg = navError instanceof Error ? navError.message : String(navError);
      if (msg.includes('Timeout') || msg.includes('timeout')) {
        // networkidle timed out — page is still loaded, just busy.
        // Continue with whatever we have.
        timedOut = true;
        console.log(`[Crawler] networkidle timeout on ${url} — continuing with partial data`);
        consoleErrors.push(`Navigation: networkidle timed out after 30s, data captured is partial`);
      } else {
        // Genuine navigation failure (DNS, connection refused, etc.)
        throw navError;
      }
    }
    const pageLoadMs = Date.now() - startTime;
    // If DOMContentLoaded didn't fire (DNS failure), keep it at 0
    if (domContentLoadedMs === 0 && pageLoadMs > 0) {
      domContentLoadedMs = pageLoadMs; // Fallback: use total time if DCL event wasn't captured
    }

    // Wait for deferred analytics tags to fire.
    // Shorter wait if we already timed out (the page has had 30s+ already).
    await page.waitForTimeout(timedOut ? 2000 : 3000);

    // ── Extract dataLayer + gtag data from the page ──
    // Do this BEFORE waiting for DOM — analytics data should already be available.
    await extractPageData(page, dataLayerEvents);

    // ── Wait for DOM to stabilise (SPA rendering) ──
    // SPA frameworks (Angular, React, Vue) may take extra time to render after
    // the HTML document loads. Poll until the body has meaningful content.
    try {
      await page.waitForFunction(`
        (function() {
          var body = document.body;
          if (!body) return false;
          // Check body has meaningful content: enough child elements and scroll height
          return body.children.length > 5 && body.scrollHeight > 500;
        })()
      `, { timeout: 8000 });
    } catch {
      // DOM didn't stabilise in time — proceed anyway, screenshot whatever we have
      console.log(`[Crawler] DOM stabilisation timeout on "${pageType}" — content may be sparse`);
    }

    // ── Dismiss interstitials/modals blocking the page ──
    // Some sites show location selectors, age gates, or welcome modals.
    // Try to dismiss them before taking the screenshot.
    try {
      const dismissed = await dismissInterstitials(page);
      if (dismissed) {
        // Wait a moment for the page to update after dismissal
        await page.waitForTimeout(1500);
      }
    } catch {
      // Interstitial dismissal failed — not critical, continue
    }

    // ── Diagnostic logging: what page did we actually land on? ──
    const finalUrl = page.url();
    const pageTitle = await page.title().catch(() => '(could not read title)');
    const htmlSample = await page.evaluate('document.documentElement.outerHTML.substring(0, 500)').catch(() => '(could not read HTML)');
    console.log(`[Crawler] Diagnostics for "${pageType}":`);
    console.log(`  Final URL: ${finalUrl}`);
    console.log(`  Page title: ${pageTitle}`);
    console.log(`  HTML (first 500 chars): ${htmlSample}`);
    if (finalUrl !== url) {
      console.log(`  ⚠ REDIRECT detected: ${url} → ${finalUrl}`);
      consoleErrors.push(`Redirect: ${url} → ${finalUrl}`);
    }

    // ── Screenshot ──
    // Taken AFTER DOM stabilisation and interstitial dismissal for best quality.
    // For homepage, screenshot is deferred until after consent banner dismissal.
    if (!skipScreenshot) {
      screenshotPath = await takeScreenshot(page, audit.id, pageType);
    }

    // Log proxy detections
    if (potentialProxies.length > 0) {
      console.log(`[Crawler] ⚠ Potential GA4 proxies detected on "${pageType}":`);
      for (const p of potentialProxies) {
        console.log(`  ${p.domain} (${p.reason}): ${p.url}`);
      }
    }

    console.log(
      `[Crawler] Page "${pageType}" done${timedOut ? ' (partial)' : ''} — ` +
      `${dataLayerEvents.length} dataLayer events, ` +
      `${ga4Requests.length} GA4 requests, ` +
      `${gtmRequests.length} GTM loads, ` +
      `${potentialProxies.length > 0 ? potentialProxies.length + ' proxy domains, ' : ''}` +
      `${pageLoadMs}ms load time`
    );

    return {
      pageUrl: url,
      pageType,
      dataLayerEvents,
      ga4Requests,
      gtmRequests,
      consoleErrors,
      screenshotPath,
      pageLoadMs,
      domContentLoadedMs,
      rawNetworkLog,
      potentialProxies,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Crawler] Error on page ${url}:`, errMsg);

    // Even on error, try to salvage dataLayer data and a screenshot
    // if the page loaded at all.
    try {
      await extractPageData(page, dataLayerEvents);
      screenshotPath = await takeScreenshot(page, audit.id, pageType);
    } catch { /* page may be completely dead — that's fine */ }

    return {
      pageUrl: url,
      pageType,
      dataLayerEvents,
      ga4Requests,
      gtmRequests,
      consoleErrors: [...consoleErrors, `Page error: ${errMsg}`],
      screenshotPath,
      pageLoadMs: 0,
      domContentLoadedMs: 0,
      rawNetworkLog,
      potentialProxies,
    };
  } finally {
    await page.close();
  }
}
