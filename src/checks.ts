// checks.ts — Deterministic 24-check tracking health scorecard engine
// Pure code-based analysis. No AI, no LLM calls.

import { CrawlPageRow } from './database';
import { ConsentResult } from './crawler';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'info';

export type CheckCategory =
  | 'GA4 Detection'
  | 'GTM Detection'
  | 'Consent & Privacy'
  | 'Ecommerce Events'
  | 'Tag Health'
  | 'Page Coverage';

export interface CheckResult {
  id: string;
  category: CheckCategory;
  name: string;
  status: CheckStatus;
  summary: string;
  details: Record<string, unknown> | null;
}

export interface ScorecardResult {
  checks: CheckResult[];
  score: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  infoCount: number;
}

// ─── Helper: parse GA4 collect URL ──────────────────────────────────────────

function parseGA4Url(url: string): {
  event_name: string;
  measurement_id: string;
  gcs: string;
  request_type: 'ga4' | 'google_ads_ccm' | 'unknown';
} {
  const params: Record<string, string> = {};
  let hostname = '';
  let pathname = '';
  try {
    const u = new URL(url);
    hostname = u.hostname;
    pathname = u.pathname;
    u.searchParams.forEach((v, k) => { params[k] = v; });
  } catch {
    const qi = url.indexOf('?');
    if (qi >= 0) {
      url.substring(qi + 1).split('&').forEach(pair => {
        const [k, ...rest] = pair.split('=');
        if (k) params[k] = decodeURIComponent(rest.join('=') || '');
      });
    }
  }

  const isCCM = pathname.includes('/ccm/collect') ||
    hostname.includes('googlesyndication.com') ||
    hostname.includes('doubleclick.net');

  let requestType: 'ga4' | 'google_ads_ccm' | 'unknown' = 'unknown';
  if (isCCM) requestType = 'google_ads_ccm';
  else if (params['tid'] || pathname.includes('/g/collect')) requestType = 'ga4';

  return {
    event_name: params['en']
      || (isCCM && params['ae'] === 'g' ? 'conversion_ping' : '')
      || (requestType === 'ga4' && !params['en'] ? 'session_config' : '')
      || 'unclassified',
    measurement_id: params['tid'] || '',
    gcs: params['gcs'] || '',
    request_type: requestType,
  };
}

// ─── Helper: safe JSON parse ────────────────────────────────────────────────

function safeJSON<T>(str: string | null, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ─── Helper: short page label ───────────────────────────────────────────────

function pageLabel(page: CrawlPageRow): string {
  const url = page.page_url;
  try {
    const u = new URL(url);
    return u.pathname === '/' ? 'Homepage' : u.pathname;
  } catch {
    return url.length > 50 ? url.substring(0, 47) + '...' : url;
  }
}

// ─── Parsed page data (computed once, shared across checks) ─────────────────

interface ParsedPage {
  row: CrawlPageRow;
  label: string;
  ga4Requests: { url: string; measurement_id: string | null; event_names: string[]; params: Record<string, string> }[];
  gtmRequests: { url: string; container_id: string | null }[];
  dataLayerEvents: { timestamp: number; data: any }[];
  consoleErrors: string[];
  proxies: { domain: string; reason: string; url: string }[];
  rawNetwork: { url: string; method: string; status: number | null }[];
  ga4MeasurementIds: Set<string>;
  gtmContainerIds: Set<string>;
  ga4EventNames: string[];
  pageViewCount: number;
  dclMs: number;
}

/** Deduplicate crawl_pages rows by URL. If the same URL appears twice, keep the row with the higher dataLayer count. */
function deduplicatePages(pages: CrawlPageRow[]): CrawlPageRow[] {
  const byUrl = new Map<string, CrawlPageRow>();
  for (const p of pages) {
    const existing = byUrl.get(p.page_url);
    if (!existing) {
      byUrl.set(p.page_url, p);
    } else {
      const existingDL = safeJSON(existing.datalayer_events, [] as any[]).length;
      const currentDL = safeJSON(p.datalayer_events, [] as any[]).length;
      if (currentDL > existingDL) {
        byUrl.set(p.page_url, p);
      }
    }
  }
  return Array.from(byUrl.values());
}

function parsePages(pages: CrawlPageRow[]): ParsedPage[] {
  return deduplicatePages(pages)
    .filter(p => p.page_type !== 'consent_check')
    .map(row => {
      const ga4Requests = safeJSON(row.ga4_requests, [] as any[]);
      const gtmRequests = safeJSON(row.gtm_requests, [] as any[]);
      const dataLayerEvents = safeJSON(row.datalayer_events, [] as any[]);
      const consoleErrors = safeJSON(row.console_errors, [] as string[]);
      const proxies = safeJSON(row.potential_proxies, [] as any[]);
      const rawNetwork = safeJSON(row.raw_network_log, [] as any[]);

      // Extract measurement IDs (G- prefix) from GA4 requests
      const ga4MeasurementIds = new Set<string>();
      const ga4EventNames: string[] = [];
      let pageViewCount = 0;

      for (const req of ga4Requests) {
        const parsed = parseGA4Url(req.url || '');
        if (parsed.measurement_id && parsed.measurement_id.startsWith('G-')) {
          ga4MeasurementIds.add(parsed.measurement_id);
        }
        ga4EventNames.push(parsed.event_name);
        if (parsed.event_name === 'page_view') pageViewCount++;
      }

      // Extract GTM container IDs
      const gtmContainerIds = new Set<string>();
      for (const req of gtmRequests) {
        if (req.container_id && req.container_id.startsWith('GTM-')) {
          gtmContainerIds.add(req.container_id);
        }
      }

      return {
        row,
        label: pageLabel(row),
        ga4Requests,
        gtmRequests,
        dataLayerEvents,
        consoleErrors,
        proxies,
        rawNetwork,
        ga4MeasurementIds,
        gtmContainerIds,
        ga4EventNames,
        pageViewCount,
        dclMs: row.dom_content_loaded_ms || 0,
      };
    });
}

// ─── Individual check functions ─────────────────────────────────────────────

// 1. GA4 Detected
function checkGA4Detected(pages: ParsedPage[]): CheckResult {
  const allIds = new Set<string>();
  for (const p of pages) {
    for (const id of p.ga4MeasurementIds) allIds.add(id);
  }

  if (allIds.size > 0) {
    return {
      id: 'ga4_detected',
      category: 'GA4 Detection',
      name: 'GA4 Tracking Detected',
      status: 'pass',
      summary: `GA4 measurement ID${allIds.size > 1 ? 's' : ''} detected: ${[...allIds].join(', ')}`,
      details: { measurement_ids: [...allIds] },
    };
  }

  return {
    id: 'ga4_detected',
    category: 'GA4 Detection',
    name: 'GA4 Tracking Detected',
    status: 'fail',
    summary: 'No GA4 measurement IDs (G- prefix) detected on any page',
    details: null,
  };
}

// 2. GA4 on All Pages
function checkGA4AllPages(pages: ParsedPage[]): CheckResult {
  const total = pages.length;
  const withGA4 = pages.filter(p => p.ga4Requests.length > 0);
  const missing = pages.filter(p => p.ga4Requests.length === 0);

  if (missing.length === 0) {
    return {
      id: 'ga4_all_pages',
      category: 'GA4 Detection',
      name: 'GA4 Fires on All Pages',
      status: 'pass',
      summary: `GA4 fires on ${withGA4.length}/${total} pages`,
      details: null,
    };
  }

  return {
    id: 'ga4_all_pages',
    category: 'GA4 Detection',
    name: 'GA4 Fires on All Pages',
    status: 'fail',
    summary: `GA4 fires on ${withGA4.length}/${total} pages`,
    details: { missing_pages: missing.map(p => ({ url: p.row.page_url, page_type: p.row.page_type })) },
  };
}

// 3. GA4 Duplicate Measurement IDs
function checkGA4DuplicateIds(pages: ParsedPage[]): CheckResult {
  const duplicatePages: { label: string; ids: string[] }[] = [];
  for (const p of pages) {
    if (p.ga4MeasurementIds.size > 1) {
      duplicatePages.push({ label: p.label, ids: [...p.ga4MeasurementIds] });
    }
  }

  if (duplicatePages.length === 0) {
    return {
      id: 'ga4_duplicate_ids',
      category: 'GA4 Detection',
      name: 'No Duplicate GA4 Measurement IDs',
      status: 'pass',
      summary: 'Each page fires a single GA4 measurement ID',
      details: null,
    };
  }

  return {
    id: 'ga4_duplicate_ids',
    category: 'GA4 Detection',
    name: 'No Duplicate GA4 Measurement IDs',
    status: 'warn',
    summary: `${duplicatePages.length} page${duplicatePages.length > 1 ? 's' : ''} fire${duplicatePages.length === 1 ? 's' : ''} multiple GA4 measurement IDs`,
    details: { pages_with_duplicates: duplicatePages },
  };
}

// 4. GA4 Duplicate page_view Events
function checkGA4DuplicatePageViews(pages: ParsedPage[]): CheckResult {
  const dupes: { label: string; count: number }[] = [];
  for (const p of pages) {
    if (p.pageViewCount > 1) {
      dupes.push({ label: p.label, count: p.pageViewCount });
    }
  }

  if (dupes.length === 0) {
    return {
      id: 'ga4_duplicate_events',
      category: 'GA4 Detection',
      name: 'No Duplicate page_view Events',
      status: 'pass',
      summary: 'Each page fires 0 or 1 page_view events',
      details: null,
    };
  }

  const totalPages = pages.filter(p => p.pageViewCount > 0).length;
  const counts = [...new Set(dupes.map(d => d.count))];
  const countDesc = counts.length === 1 ? `${counts[0]} page_view events` : `${Math.min(...counts)}-${Math.max(...counts)} page_view events`;

  return {
    id: 'ga4_duplicate_events',
    category: 'GA4 Detection',
    name: 'No Duplicate page_view Events',
    status: 'warn',
    summary: `${dupes.length}/${totalPages} page${totalPages !== 1 ? 's' : ''} fire ${countDesc} each (expected: 1)`,
    details: { duplicate_pages: dupes },
  };
}

// 5. GTM Detected
function checkGTMDetected(pages: ParsedPage[]): CheckResult {
  const allIds = new Set<string>();
  for (const p of pages) {
    for (const id of p.gtmContainerIds) allIds.add(id);
  }

  if (allIds.size > 0) {
    return {
      id: 'gtm_detected',
      category: 'GTM Detection',
      name: 'GTM Container Detected',
      status: 'pass',
      summary: `GTM container${allIds.size > 1 ? 's' : ''} detected: ${[...allIds].join(', ')}`,
      details: { container_ids: [...allIds] },
    };
  }

  return {
    id: 'gtm_detected',
    category: 'GTM Detection',
    name: 'GTM Container Detected',
    status: 'fail',
    summary: 'No GTM containers (GTM- prefix) detected on any page',
    details: null,
  };
}

// 6. GTM on All Pages
function checkGTMAllPages(pages: ParsedPage[]): CheckResult {
  const total = pages.length;
  const withGTM = pages.filter(p => p.gtmContainerIds.size > 0);
  const missing = pages.filter(p => p.gtmContainerIds.size === 0);

  if (missing.length === 0) {
    return {
      id: 'gtm_all_pages',
      category: 'GTM Detection',
      name: 'GTM Loads on All Pages',
      status: 'pass',
      summary: `GTM loads on ${withGTM.length}/${total} pages`,
      details: null,
    };
  }

  return {
    id: 'gtm_all_pages',
    category: 'GTM Detection',
    name: 'GTM Loads on All Pages',
    status: 'fail',
    summary: `GTM loads on ${withGTM.length}/${total} pages`,
    details: { missing_pages: missing.map(p => ({ url: p.row.page_url, page_type: p.row.page_type })) },
  };
}

// 7. GTM Multiple Containers
function checkGTMMultipleContainers(pages: ParsedPage[]): CheckResult {
  const allIds = new Set<string>();
  for (const p of pages) {
    for (const id of p.gtmContainerIds) allIds.add(id);
  }

  const containerPages: Record<string, string[]> = {};
  for (const p of pages) {
    for (const id of p.gtmContainerIds) {
      if (!containerPages[id]) containerPages[id] = [];
      containerPages[id].push(p.label);
    }
  }

  if (allIds.size <= 1) {
    return {
      id: 'gtm_multiple_containers',
      category: 'GTM Detection',
      name: 'Multiple GTM Containers',
      status: 'info',
      summary: allIds.size === 0 ? 'No GTM containers detected' : `Single GTM container: ${[...allIds][0]}`,
      details: { containers: containerPages },
    };
  }

  return {
    id: 'gtm_multiple_containers',
    category: 'GTM Detection',
    name: 'Multiple GTM Containers',
    status: 'info',
    summary: `${allIds.size} GTM containers detected: ${[...allIds].join(', ')}`,
    details: { containers: containerPages },
  };
}

// 8. GTM Present but GA4 Absent
function checkGTMPresentGA4Absent(pages: ParsedPage[]): CheckResult {
  const gtmPages = pages.filter(p => p.gtmContainerIds.size > 0);

  // If no GTM detected at all, this check is not applicable
  if (gtmPages.length === 0) {
    return {
      id: 'gtm_present_ga4_absent',
      category: 'GTM Detection',
      name: 'GTM Pages Have GA4 Requests',
      status: 'info',
      summary: 'No GTM detected — check not applicable',
      details: null,
    };
  }

  const affected = gtmPages.filter(p => p.ga4Requests.length === 0);

  if (affected.length === 0) {
    return {
      id: 'gtm_present_ga4_absent',
      category: 'GTM Detection',
      name: 'GTM Pages Have GA4 Requests',
      status: 'pass',
      summary: 'Every page with GTM also fires GA4 requests',
      details: null,
    };
  }

  return {
    id: 'gtm_present_ga4_absent',
    category: 'GTM Detection',
    name: 'GTM Pages Have GA4 Requests',
    status: 'warn',
    summary: `${affected.length} page${affected.length > 1 ? 's' : ''} load${affected.length === 1 ? 's' : ''} GTM but fire${affected.length === 1 ? 's' : ''} zero GA4 requests`,
    details: { affected_pages: affected.map(p => ({ url: p.row.page_url, page_type: p.row.page_type })) },
  };
}

// 9. Consent Banner Detected
function checkConsentBanner(consent: ConsentResult | null): CheckResult {
  if (!consent || !consent.bannerFound) {
    return {
      id: 'consent_banner_detected',
      category: 'Consent & Privacy',
      name: 'Consent Banner Detected',
      status: 'warn',
      summary: 'No consent banner detected',
      details: consent ? { cmp: consent.cmpDetected } : null,
    };
  }

  return {
    id: 'consent_banner_detected',
    category: 'Consent & Privacy',
    name: 'Consent Banner Detected',
    status: 'pass',
    summary: `Consent banner detected: ${consent.cmpDetected || 'Unknown CMP'}`,
    details: {
      cmp: consent.cmpDetected,
      accept_button_found: consent.acceptButtonFound,
      accept_button_clicked: consent.acceptButtonClicked,
    },
  };
}

// 10. Consent Default State
function checkConsentDefaultState(consent: ConsentResult | null): CheckResult {
  if (!consent) {
    return {
      id: 'consent_default_state',
      category: 'Consent & Privacy',
      name: 'Consent Defaults to Denied',
      status: 'info',
      summary: 'No consent data available',
      details: null,
    };
  }

  const defaults = consent.defaultConsentState;
  const preConsentGA4 = consent.preConsentGA4Requests || [];

  // Check GCS values from pre-consent GA4 requests
  const preConsentGCS: string[] = [];
  for (const req of preConsentGA4) {
    const parsed = parseGA4Url(req.url || '');
    if (parsed.gcs) preConsentGCS.push(parsed.gcs);
  }

  // Check dataLayer consent defaults
  if (defaults) {
    const consentKeys = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];
    const relevantDefaults = Object.entries(defaults).filter(([k]) => consentKeys.includes(k));

    if (relevantDefaults.length > 0) {
      const allDenied = relevantDefaults.every(([, v]) => v === 'denied');
      const anyGranted = relevantDefaults.some(([, v]) => v === 'granted');

      if (allDenied) {
        return {
          id: 'consent_default_state',
          category: 'Consent & Privacy',
          name: 'Consent Defaults to Denied',
          status: 'pass',
          summary: `Consent defaults to denied for all parameters`,
          details: { defaults: Object.fromEntries(relevantDefaults), pre_consent_gcs: preConsentGCS },
        };
      }

      if (anyGranted) {
        return {
          id: 'consent_default_state',
          category: 'Consent & Privacy',
          name: 'Consent Defaults to Denied',
          status: 'fail',
          summary: `Consent defaults to granted before user interaction`,
          details: { defaults: Object.fromEntries(relevantDefaults), pre_consent_gcs: preConsentGCS },
        };
      }
    }
  }

  // Check GCS from pre-consent requests
  if (preConsentGCS.length > 0) {
    // G1xx means ad_storage granted, Gx1x means analytics_storage granted
    const allRestricted = preConsentGCS.every(gcs => {
      if (gcs.length >= 4) {
        // Check if analytics_storage (2nd digit) is denied
        return gcs[2] === '0';
      }
      return false;
    });

    if (allRestricted) {
      return {
        id: 'consent_default_state',
        category: 'Consent & Privacy',
        name: 'Consent Defaults to Denied',
        status: 'pass',
        summary: `Pre-consent GCS shows denied analytics state: ${[...new Set(preConsentGCS)].join(', ')}`,
        details: { pre_consent_gcs: preConsentGCS, defaults },
      };
    }

    return {
      id: 'consent_default_state',
      category: 'Consent & Privacy',
      name: 'Consent Defaults to Denied',
      status: 'fail',
      summary: `Pre-consent GCS shows granted state: ${[...new Set(preConsentGCS)].join(', ')}`,
      details: { pre_consent_gcs: preConsentGCS, defaults },
    };
  }

  return {
    id: 'consent_default_state',
    category: 'Consent & Privacy',
    name: 'Consent Defaults to Denied',
    status: 'info',
    summary: 'No consent mode parameters detected',
    details: { defaults, pre_consent_gcs: preConsentGCS },
  };
}

// 11. Consent Updates After Accept
function checkConsentUpdates(consent: ConsentResult | null): CheckResult {
  if (!consent || !consent.bannerFound) {
    return {
      id: 'consent_updates_after_accept',
      category: 'Consent & Privacy',
      name: 'Consent State Updates After Accept',
      status: 'info',
      summary: 'No consent banner detected — cannot assess',
      details: null,
    };
  }

  const before = consent.defaultConsentState;
  const after = consent.postConsentState;

  if (!before && !after) {
    return {
      id: 'consent_updates_after_accept',
      category: 'Consent & Privacy',
      name: 'Consent State Updates After Accept',
      status: 'fail',
      summary: 'Consent banner present but no consent state changes detected',
      details: { before, after },
    };
  }

  // Check if state actually changed
  const consentKeys = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];
  const beforeVals = before || {};
  const afterVals = after || {};

  let changed = false;
  const changes: Record<string, { before: string; after: string }> = {};
  for (const k of consentKeys) {
    const b = beforeVals[k] || 'not set';
    const a = afterVals[k] || 'not set';
    if (b !== a) {
      changed = true;
      changes[k] = { before: b, after: a };
    }
  }

  if (changed) {
    return {
      id: 'consent_updates_after_accept',
      category: 'Consent & Privacy',
      name: 'Consent State Updates After Accept',
      status: 'pass',
      summary: `Consent state changes after clicking Accept`,
      details: { changes, before: beforeVals, after: afterVals },
    };
  }

  return {
    id: 'consent_updates_after_accept',
    category: 'Consent & Privacy',
    name: 'Consent State Updates After Accept',
    status: 'fail',
    summary: 'Consent state does not change after clicking Accept',
    details: { before: beforeVals, after: afterVals },
  };
}

// 12. GA4 Fires Before Consent
function checkGA4BeforeConsent(consent: ConsentResult | null): CheckResult {
  if (!consent || !consent.bannerFound) {
    return {
      id: 'ga4_fires_before_consent',
      category: 'Consent & Privacy',
      name: 'GA4 Fires Only After Consent',
      status: 'info',
      summary: 'No consent banner detected — cannot assess pre-consent tracking',
      details: null,
    };
  }

  const preConsentCount = (consent.preConsentGA4Requests || []).length;

  if (preConsentCount === 0) {
    return {
      id: 'ga4_fires_before_consent',
      category: 'Consent & Privacy',
      name: 'GA4 Fires Only After Consent',
      status: 'pass',
      summary: 'No GA4 requests fired before consent was granted',
      details: null,
    };
  }

  return {
    id: 'ga4_fires_before_consent',
    category: 'Consent & Privacy',
    name: 'GA4 Fires Only After Consent',
    status: 'fail',
    summary: `${preConsentCount} GA4 request${preConsentCount > 1 ? 's' : ''} fired before consent was granted`,
    details: {
      pre_consent_count: preConsentCount,
      requests: (consent.preConsentGA4Requests || []).slice(0, 5).map(r => ({
        url: r.url?.substring(0, 200),
        measurement_id: r.measurement_id,
      })),
    },
  };
}

// ─── Ecommerce helpers ──────────────────────────────────────────────────────

function findDLEvent(page: ParsedPage, eventName: string): any[] {
  return page.dataLayerEvents.filter(dl => {
    const d = dl.data || dl;
    return d.event === eventName || d.eventName === eventName;
  });
}

function getEcommercePages(pages: ParsedPage[], type: string): ParsedPage[] {
  return pages.filter(p => {
    const pt = (p.row.page_type || '').toLowerCase();
    return pt === type || pt === type + 's';
  });
}

// 13. Ecommerce view_item
function checkEcommerceViewItem(pages: ParsedPage[]): CheckResult {
  const productPages = getEcommercePages(pages, 'product');

  if (productPages.length === 0) {
    return {
      id: 'ecommerce_view_item',
      category: 'Ecommerce Events',
      name: 'view_item on Product Pages',
      status: 'info',
      summary: 'No product pages were crawled',
      details: null,
    };
  }

  const withEvent = productPages.filter(p => findDLEvent(p, 'view_item').length > 0);

  if (withEvent.length === productPages.length) {
    return {
      id: 'ecommerce_view_item',
      category: 'Ecommerce Events',
      name: 'view_item on Product Pages',
      status: 'pass',
      summary: `view_item fires on ${withEvent.length}/${productPages.length} product pages`,
      details: null,
    };
  }

  return {
    id: 'ecommerce_view_item',
    category: 'Ecommerce Events',
    name: 'view_item on Product Pages',
    status: 'warn',
    summary: `view_item fires on ${withEvent.length}/${productPages.length} product pages`,
    details: {
      missing: productPages
        .filter(p => findDLEvent(p, 'view_item').length === 0)
        .map(p => ({ url: p.row.page_url })),
    },
  };
}

// 14. Ecommerce view_item_list
function checkEcommerceViewItemList(pages: ParsedPage[]): CheckResult {
  const categoryPages = pages.filter(p => {
    const pt = (p.row.page_type || '').toLowerCase();
    return pt === 'category' || pt === 'collection' || pt === 'collections';
  });

  if (categoryPages.length === 0) {
    return {
      id: 'ecommerce_view_item_list',
      category: 'Ecommerce Events',
      name: 'view_item_list on Category Pages',
      status: 'info',
      summary: 'No category/collection pages were crawled',
      details: null,
    };
  }

  const withEvent = categoryPages.filter(p => findDLEvent(p, 'view_item_list').length > 0);

  if (withEvent.length === categoryPages.length) {
    return {
      id: 'ecommerce_view_item_list',
      category: 'Ecommerce Events',
      name: 'view_item_list on Category Pages',
      status: 'pass',
      summary: `view_item_list fires on ${withEvent.length}/${categoryPages.length} category pages`,
      details: null,
    };
  }

  return {
    id: 'ecommerce_view_item_list',
    category: 'Ecommerce Events',
    name: 'view_item_list on Category Pages',
    status: 'warn',
    summary: `view_item_list fires on ${withEvent.length}/${categoryPages.length} category pages`,
    details: {
      missing: categoryPages
        .filter(p => findDLEvent(p, 'view_item_list').length === 0)
        .map(p => ({ url: p.row.page_url })),
    },
  };
}

// 15. Ecommerce DataLayer Quality
function checkEcommerceDLQuality(pages: ParsedPage[]): CheckResult {
  const ecommerceEvents = ['view_item', 'view_item_list', 'add_to_cart', 'purchase', 'begin_checkout'];
  const requiredParams = ['item_id', 'item_name', 'price'];

  const found: { event: string; page: string; present: string[]; missing: string[] }[] = [];

  for (const p of pages) {
    for (const evtName of ecommerceEvents) {
      const events = findDLEvent(p, evtName);
      for (const evt of events) {
        const d = evt.data || evt;
        const ecom = d.ecommerce || d;
        const items = ecom.items || d.items || [];
        const firstItem = Array.isArray(items) && items.length > 0 ? items[0] : null;

        if (firstItem) {
          const present = requiredParams.filter(param => firstItem[param] !== undefined && firstItem[param] !== null && firstItem[param] !== '');
          const missing = requiredParams.filter(param => !present.includes(param));
          found.push({ event: evtName, page: p.label, present, missing });
        }
      }
    }
  }

  if (found.length === 0) {
    return {
      id: 'ecommerce_datalayer_quality',
      category: 'Ecommerce Events',
      name: 'Ecommerce DataLayer Quality',
      status: 'info',
      summary: 'No ecommerce events with item data detected',
      details: null,
    };
  }

  const withMissing = found.filter(f => f.missing.length > 0);

  if (withMissing.length === 0) {
    return {
      id: 'ecommerce_datalayer_quality',
      category: 'Ecommerce Events',
      name: 'Ecommerce DataLayer Quality',
      status: 'pass',
      summary: `All ecommerce events contain item_id, item_name, and price`,
      details: { events_checked: found },
    };
  }

  return {
    id: 'ecommerce_datalayer_quality',
    category: 'Ecommerce Events',
    name: 'Ecommerce DataLayer Quality',
    status: 'warn',
    summary: `${withMissing.length} ecommerce event${withMissing.length > 1 ? 's' : ''} missing required parameters`,
    details: { events_with_issues: withMissing },
  };
}

// 16. Ecommerce Conversion Note
function checkEcommerceConversionNote(): CheckResult {
  return {
    id: 'ecommerce_conversion_note',
    category: 'Ecommerce Events',
    name: 'Conversion Events Disclosure',
    status: 'info',
    summary: 'purchase, add_to_cart, and begin_checkout events require user interaction that this automated scan cannot trigger. Their presence could not be verified.',
    details: null,
  };
}

// 17. Console Errors (Analytics-Related)
function checkConsoleErrors(pages: ParsedPage[]): CheckResult {
  const analyticsKeywords = /gtm|gtag|analytics|ga4|onetrust|cookiebot|consent|tracking|google.tag|googletagmanager/i;

  const found: { page: string; errors: string[] }[] = [];

  for (const p of pages) {
    const relevant = p.consoleErrors.filter(e => analyticsKeywords.test(e));
    if (relevant.length > 0) {
      found.push({ page: p.label, errors: relevant.slice(0, 5) });
    }
  }

  if (found.length === 0) {
    return {
      id: 'console_errors_analytics',
      category: 'Tag Health',
      name: 'No Analytics Console Errors',
      status: 'pass',
      summary: 'No analytics-related console errors detected',
      details: null,
    };
  }

  const totalErrors = found.reduce((sum, f) => sum + f.errors.length, 0);
  return {
    id: 'console_errors_analytics',
    category: 'Tag Health',
    name: 'No Analytics Console Errors',
    status: 'warn',
    summary: `${totalErrors} analytics-related console error${totalErrors > 1 ? 's' : ''} on ${found.length} page${found.length > 1 ? 's' : ''}`,
    details: { pages_with_errors: found },
  };
}

// 18. Google Ads Detected
function checkGoogleAdsDetected(pages: ParsedPage[]): CheckResult {
  const awIds = new Set<string>();

  for (const p of pages) {
    for (const req of p.ga4Requests) {
      const parsed = parseGA4Url(req.url || '');
      if (parsed.measurement_id && parsed.measurement_id.startsWith('AW-')) {
        awIds.add(parsed.measurement_id);
      }
      // Also check tid from the raw request
      if (req.measurement_id && req.measurement_id.startsWith('AW-')) {
        awIds.add(req.measurement_id);
      }
    }
    // Check raw network for CCM requests
    for (const net of p.rawNetwork) {
      if (net.url && (net.url.includes('/ccm/collect') || net.url.includes('googlesyndication.com'))) {
        const parsed = parseGA4Url(net.url);
        if (parsed.measurement_id && parsed.measurement_id.startsWith('AW-')) {
          awIds.add(parsed.measurement_id);
        }
      }
    }
  }

  if (awIds.size > 0) {
    return {
      id: 'google_ads_detected',
      category: 'Tag Health',
      name: 'Google Ads Conversion Tracking',
      status: 'info',
      summary: `Google Ads conversion tracking detected: ${[...awIds].join(', ')}`,
      details: { ads_ids: [...awIds] },
    };
  }

  return {
    id: 'google_ads_detected',
    category: 'Tag Health',
    name: 'Google Ads Conversion Tracking',
    status: 'info',
    summary: 'No Google Ads tags detected',
    details: null,
  };
}

// 19. Third-Party Tags
function checkThirdPartyTags(pages: ParsedPage[]): CheckResult {
  const tags: Record<string, boolean> = {};

  const patterns: [RegExp, string][] = [
    [/connect\.facebook\.net|facebook\.com\/tr/i, 'Meta (Facebook) Pixel'],
    [/analytics\.tiktok\.com|tiktok\.com\/i18n/i, 'TikTok Pixel'],
    [/snap\.licdn\.com|linkedin\.com\/insight/i, 'LinkedIn Insight'],
    [/static\.hotjar\.com|hotjar\.com/i, 'Hotjar'],
    [/cdn\.segment\.com|api\.segment\.io/i, 'Segment'],
    [/bat\.bing\.com|clarity\.ms/i, 'Microsoft Clarity/Bing'],
    [/sc-static\.net|tr\.snapchat\.com/i, 'Snapchat Pixel'],
    [/pinterest\.com\/ct\.html|pinimg\.com\/ct/i, 'Pinterest Tag'],
    [/ct\.pinterest\.com/i, 'Pinterest Tag'],
    [/cdn\.heapanalytics\.com/i, 'Heap Analytics'],
    [/cdn\.amplitude\.com/i, 'Amplitude'],
    [/cdn\.mxpnl\.com|api\.mixpanel\.com/i, 'Mixpanel'],
    [/plausible\.io/i, 'Plausible Analytics'],
    [/cdn\.cookielaw\.org/i, 'OneTrust'],
    [/consent\.cookiebot\.com/i, 'Cookiebot'],
  ];

  for (const p of pages) {
    for (const net of p.rawNetwork) {
      for (const [regex, name] of patterns) {
        if (regex.test(net.url || '')) {
          tags[name] = true;
        }
      }
    }
  }

  const detected = Object.keys(tags);

  return {
    id: 'third_party_tags',
    category: 'Tag Health',
    name: 'Third-Party Tags Detected',
    status: 'info',
    summary: detected.length > 0 ? `Detected: ${detected.join(', ')}` : 'No third-party tracking tags detected',
    details: detected.length > 0 ? { tags: detected } : null,
  };
}

// 20. Pages Crawled
function checkPagesCrawled(pages: ParsedPage[]): CheckResult {
  return {
    id: 'pages_crawled',
    category: 'Page Coverage',
    name: 'Pages Crawled',
    status: 'info',
    summary: `${pages.length} page${pages.length !== 1 ? 's' : ''} crawled`,
    details: {
      pages: pages.map(p => ({
        url: p.row.page_url,
        page_type: p.row.page_type,
      })),
    },
  };
}

// 21. Pages Failed
function checkPagesFailed(pages: ParsedPage[]): CheckResult {
  // A page "failed" if DCL is 0 or very low and it has no GA4/GTM/dataLayer
  const failed = pages.filter(p =>
    p.dclMs < 100 &&
    p.ga4Requests.length === 0 &&
    p.gtmRequests.length === 0 &&
    p.dataLayerEvents.length === 0
  );

  if (failed.length === 0) {
    return {
      id: 'pages_failed',
      category: 'Page Coverage',
      name: 'All Pages Loaded Successfully',
      status: 'pass',
      summary: 'All pages loaded successfully',
      details: null,
    };
  }

  return {
    id: 'pages_failed',
    category: 'Page Coverage',
    name: 'All Pages Loaded Successfully',
    status: 'warn',
    summary: `${failed.length} page${failed.length > 1 ? 's' : ''} failed to load`,
    details: { failed_pages: failed.map(p => ({ url: p.row.page_url, page_type: p.row.page_type })) },
  };
}

// 22. Pages Redirected (cross-domain)
function checkPagesRedirected(pages: ParsedPage[]): CheckResult {
  const redirected: { original_url: string; page_type: string }[] = [];

  // Detect if the crawled URL domain differs from what was expected
  // This is limited by what the crawler captures — check raw network for 3xx
  for (const p of pages) {
    const redirects = p.rawNetwork.filter(n =>
      n.status !== null && n.status >= 300 && n.status < 400 &&
      n.url && n.url.includes(p.row.page_url.split('/')[2] || '')
    );
    if (redirects.length > 0) {
      redirected.push({ original_url: p.row.page_url, page_type: p.row.page_type || 'unknown' });
    }
  }

  return {
    id: 'pages_redirected',
    category: 'Page Coverage',
    name: 'Cross-Domain Redirects',
    status: 'info',
    summary: redirected.length > 0
      ? `${redirected.length} page${redirected.length > 1 ? 's' : ''} with detected redirects`
      : 'No cross-domain redirects detected',
    details: redirected.length > 0 ? { redirected } : null,
  };
}

// 23. Load Times
function checkLoadTimes(pages: ParsedPage[]): CheckResult {
  const slow = pages.filter(p => p.dclMs > 10000);
  const times = pages.map(p => ({
    page: p.label,
    dcl_ms: p.dclMs,
    dcl_display: p.dclMs > 100 ? `${(p.dclMs / 1000).toFixed(1)}s` : 'Failed to load',
  }));

  if (slow.length === 0) {
    return {
      id: 'load_times',
      category: 'Page Coverage',
      name: 'Page Load Times',
      status: 'pass',
      summary: 'All pages load under 10 seconds',
      details: { times },
    };
  }

  return {
    id: 'load_times',
    category: 'Page Coverage',
    name: 'Page Load Times',
    status: 'warn',
    summary: `${slow.length} page${slow.length > 1 ? 's' : ''} exceed 10s load time`,
    details: { times, slow_pages: slow.map(p => ({ page: p.label, dcl_ms: p.dclMs })) },
  };
}

// ─── Main engine ────────────────────────────────────────────────────────────

/**
 * Run all 24 deterministic checks against crawl data.
 * Returns structured scorecard with checks and computed score.
 */
export function runChecks(
  crawlPages: CrawlPageRow[],
  consent: ConsentResult | null
): ScorecardResult {
  const pages = parsePages(crawlPages);

  const checks: CheckResult[] = [
    // GA4 Detection (1-4)
    checkGA4Detected(pages),
    checkGA4AllPages(pages),
    checkGA4DuplicateIds(pages),
    checkGA4DuplicatePageViews(pages),
    // GTM Detection (5-8)
    checkGTMDetected(pages),
    checkGTMAllPages(pages),
    checkGTMMultipleContainers(pages),
    checkGTMPresentGA4Absent(pages),
    // Consent & Privacy (9-12)
    checkConsentBanner(consent),
    checkConsentDefaultState(consent),
    checkConsentUpdates(consent),
    checkGA4BeforeConsent(consent),
    // Ecommerce Events (13-16)
    checkEcommerceViewItem(pages),
    checkEcommerceViewItemList(pages),
    checkEcommerceDLQuality(pages),
    checkEcommerceConversionNote(),
    // Tag Health (17-19)
    checkConsoleErrors(pages),
    checkGoogleAdsDetected(pages),
    checkThirdPartyTags(pages),
    // Page Coverage (20-24 minus overall_score)
    checkPagesCrawled(pages),
    checkPagesFailed(pages),
    checkPagesRedirected(pages),
    checkLoadTimes(pages),
  ];

  // Compute score: start at 100, -15 per FAIL, -5 per WARN, floor 0
  let score = 100;
  let passCount = 0, warnCount = 0, failCount = 0, infoCount = 0;

  for (const c of checks) {
    switch (c.status) {
      case 'pass': passCount++; break;
      case 'warn': warnCount++; score -= 5; break;
      case 'fail': failCount++; score -= 15; break;
      case 'info': infoCount++; break;
    }
  }

  score = Math.max(0, score);

  // Add the overall_score as check #24
  checks.push({
    id: 'overall_score',
    category: 'Page Coverage',
    name: 'Overall Health Score',
    status: score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail',
    summary: `Score: ${score}/100 — ${passCount} passed, ${warnCount} warnings, ${failCount} failures`,
    details: { score, passCount, warnCount, failCount, infoCount },
  });

  return { checks, score, passCount, warnCount, failCount, infoCount };
}
