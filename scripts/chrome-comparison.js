const { chromium } = require('playwright');

(async () => {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  const page = await context.newPage();

  // ---- Tracking collectors ----
  const ga4Requests = [];
  const gtmContainers = new Set();
  let preConsentGA4Count = 0;

  page.on('request', (req) => {
    const url = req.url();

    // GA4 collect endpoints
    if (/\/(g\/collect|g\/s\/collect|ccm\/collect)/.test(url)) {
      ga4Requests.push({ url: url, ts: Date.now() });
    }

    // GTM container loads
    const gtmMatch = url.match(/googletagmanager\.com\/(gtm\.js|gtag\/js)\?.*id=(GTM-[A-Z0-9]+|G-[A-Z0-9]+)/);
    if (gtmMatch) {
      gtmContainers.add(gtmMatch[2]);
    }
  });

  // ---- 1. Navigate to homepage ----
  console.log('Navigating to https://www.allbirds.com/ ...');
  try {
    await page.goto('https://www.allbirds.com/', { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    console.log('Navigation timeout (continuing): ' + e.message);
  }

  const finalURL = page.url();
  const title = await page.title();

  // dataLayer length
  const dataLayerLength = await page.evaluate(() => {
    return window.dataLayer ? window.dataLayer.length : 0;
  });

  preConsentGA4Count = ga4Requests.length;

  console.log('');
  console.log('=== ALLBIRDS GROUND TRUTH (Playwright as Chrome) ===');
  console.log('');
  console.log('HOMEPAGE:');
  console.log('  Final URL: ' + finalURL);
  console.log('  Page title: ' + title);
  console.log('  GA4 requests: ' + preConsentGA4Count);
  console.log('  GTM containers: ' + (gtmContainers.size > 0 ? Array.from(gtmContainers).join(', ') : '(none detected)'));
  console.log('  dataLayer events: ' + dataLayerLength);

  // ---- 2. Cookie consent ----
  console.log('');
  console.log('Looking for cookie consent button...');

  let consentClicked = false;
  const consentSelectors = [
    '#onetrust-accept-btn-handler',
    'button#onetrust-accept-btn-handler',
    '[id*="accept"]',
    'button[class*="accept"]',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    'button:has-text("Accept")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    'button:has-text("Allow all")',
    'button:has-text("I Accept")',
    'button:has-text("Got it")',
    'button:has-text("OK")',
  ];

  for (const selector of consentSelectors) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        consentClicked = true;
        console.log('  Clicked consent button: ' + selector);
        break;
      }
    } catch (e) {
      // try next
    }
  }

  if (!consentClicked) {
    console.log('  No consent button found or visible.');
  }

  // Wait for post-consent requests
  await page.waitForTimeout(3000);

  const postConsentGA4 = ga4Requests.length - preConsentGA4Count;
  console.log('');
  console.log('POST-CONSENT:');
  console.log('  New GA4 requests: ' + postConsentGA4);
  console.log('  Total GA4 requests now: ' + ga4Requests.length);

  // ---- 3. Navigate to product page ----
  console.log('');
  console.log('Looking for a product link...');

  let productURL = null;

  // Try to find a product link on the page
  try {
    const links = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a[href*="/products/"]');
      return Array.from(anchors).slice(0, 5).map((a) => a.href);
    });
    if (links.length > 0) {
      productURL = links[0];
      console.log('  Found product link: ' + productURL);
    }
  } catch (e) {
    // fallback
  }

  if (!productURL) {
    // Fallback: try common Allbirds product URLs
    productURL = 'https://www.allbirds.com/products/mens-tree-runners';
    console.log('  Using fallback product URL: ' + productURL);
  }

  // Reset counters for product page
  const productPageGA4Start = ga4Requests.length;
  const productPageGTMStart = new Set(gtmContainers);

  console.log('  Navigating to product page...');
  try {
    await page.goto(productURL, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    console.log('  Product page navigation timeout (continuing): ' + e.message);
  }

  const productFinalURL = page.url();
  const productTitle = await page.title();
  const productGA4 = ga4Requests.length - productPageGA4Start;

  // Any new GTM containers on product page
  const newGTMContainers = Array.from(gtmContainers).filter((c) => !productPageGTMStart.has(c));

  const productDataLayer = await page.evaluate(() => {
    return window.dataLayer ? window.dataLayer.length : 0;
  });

  console.log('');
  console.log('PRODUCT PAGE:');
  console.log('  URL: ' + productFinalURL);
  console.log('  Page title: ' + productTitle);
  console.log('  GA4 requests: ' + productGA4);
  console.log('  GTM containers (all): ' + (gtmContainers.size > 0 ? Array.from(gtmContainers).join(', ') : '(none detected)'));
  if (newGTMContainers.length > 0) {
    console.log('  New GTM containers on product page: ' + newGTMContainers.join(', '));
  }
  console.log('  dataLayer events: ' + productDataLayer);

  // ---- Summary ----
  console.log('');
  console.log('=== SUMMARY ===');
  console.log('Total GA4 requests across session: ' + ga4Requests.length);
  console.log('All GTM containers detected: ' + (gtmContainers.size > 0 ? Array.from(gtmContainers).join(', ') : '(none)'));

  // Print a few sample GA4 request URLs (truncated)
  if (ga4Requests.length > 0) {
    console.log('');
    console.log('Sample GA4 request URLs (first 3):');
    ga4Requests.slice(0, 3).forEach((r, i) => {
      const truncated = r.url.length > 200 ? r.url.substring(0, 200) + '...' : r.url;
      console.log('  [' + (i + 1) + '] ' + truncated);
    });
  }

  await browser.close();
  console.log('');
  console.log('Done.');
})();
