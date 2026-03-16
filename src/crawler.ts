// crawler.ts — Playwright crawl engine
// Visits a website with a headless browser and captures tracking evidence:
// dataLayer pushes, GA4 network requests, GTM loads, console errors, screenshots.
//
// V1 basic crawler: homepage only first. Page discovery, consent interaction,
// and Shopify simulation will be added incrementally.

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { insertCrawlPage, updateAuditStatus, AuditRow } from './database';

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

export interface PageCrawlResult {
  pageUrl: string;
  pageType: string;
  dataLayerEvents: DataLayerPush[];
  ga4Requests: GA4Request[];
  gtmRequests: GTMRequest[];
  consoleErrors: string[];
  screenshotPath: string | null;
  pageLoadMs: number;
  rawNetworkLog: { url: string; method: string; status: number | null }[];
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

// ─── Main crawl function ────────────────────────────────────────────────────

/**
 * Crawl a website: homepage first, consent check, then discover and crawl
 * up to 7 more high-value pages (product, category, cart, contact, etc.).
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
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
    });

    // ── Step 1: Crawl homepage ──
    const homepageResult = await crawlPage(context, audit, audit.website_url, 'homepage');
    results.push(homepageResult);
    saveCrawlResult(audit.id, homepageResult);

    // ── Step 2: Consent interaction (homepage only) ──
    try {
      consentResult = await handleConsent(context, audit);
      // Store consent data as a special crawl page entry
      saveCrawlResult(audit.id, {
        pageUrl: audit.website_url,
        pageType: 'consent_check',
        dataLayerEvents: consentResult.postConsentDataLayer,
        ga4Requests: consentResult.postConsentGA4Requests,
        gtmRequests: [],
        consoleErrors: consentResult.errors,
        screenshotPath: consentResult.bannerScreenshot,
        pageLoadMs: 0,
        rawNetworkLog: [],
      });
    } catch (consentErr) {
      console.error('[Crawler] Consent check failed:', consentErr);
    }

    // ── Step 3: Discover pages from homepage links ──
    // We need the homepage page object for link extraction, but crawlPage
    // closes its page. So we open a lightweight page just for link discovery.
    let discoveredPages: DiscoveredPage[] = [];
    try {
      const discoveryPage = await context.newPage();
      // Use domcontentloaded — we only need the DOM, not full load
      try {
        await discoveryPage.goto(audit.website_url, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        });
      } catch (navErr) {
        const msg = navErr instanceof Error ? navErr.message : '';
        if (!msg.includes('Timeout') && !msg.includes('timeout')) throw navErr;
        // Timeout is fine — DOM should be available
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
    raw_network_log: JSON.stringify(result.rawNetworkLog),
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
      /\/cart/i,
      /\/basket/i,
      /\/bag/i,
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
    // Allow 1 of each named type, up to 2 'other' pages for breadth
    const maxPerType = page.pageType === 'other' ? 2 : 1;
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

    // If no named CMP banner found, check for generic consent elements
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

// ─── Single page crawl ─────────────────────────────────────────────────────

/**
 * Crawl one page: inject dataLayer interceptor before load, capture GA4/GTM
 * network requests, take a screenshot, and collect console errors.
 */
async function crawlPage(
  context: BrowserContext,
  audit: AuditRow,
  url: string,
  pageType: string
): Promise<PageCrawlResult> {
  const page = await context.newPage();
  const dataLayerEvents: DataLayerPush[] = [];
  const ga4Requests: GA4Request[] = [];
  const gtmRequests: GTMRequest[] = [];
  const consoleErrors: string[] = [];
  const rawNetworkLog: { url: string; method: string; status: number | null }[] = [];
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
    const startTime = Date.now();
    let timedOut = false;
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

    // Wait for deferred analytics tags to fire.
    // Shorter wait if we already timed out (the page has had 30s+ already).
    await page.waitForTimeout(timedOut ? 2000 : 3000);

    // ── Extract dataLayer + gtag data from the page ──
    // This runs regardless of whether networkidle succeeded or timed out.
    await extractPageData(page, dataLayerEvents);

    // ── Screenshot ──
    screenshotPath = await takeScreenshot(page, audit.id, pageType);

    console.log(
      `[Crawler] Page "${pageType}" done${timedOut ? ' (partial)' : ''} — ` +
      `${dataLayerEvents.length} dataLayer events, ` +
      `${ga4Requests.length} GA4 requests, ` +
      `${gtmRequests.length} GTM loads, ` +
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
      rawNetworkLog,
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
      rawNetworkLog,
    };
  } finally {
    await page.close();
  }
}
