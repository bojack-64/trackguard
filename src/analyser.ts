// analyser.ts — AI Analysis Engine
// Sends raw crawl data to the Anthropic API (Claude Sonnet) for expert
// interpretation. Constructs the analysis prompt, calls the API, and
// parses the structured JSON response.

import Anthropic from '@anthropic-ai/sdk';
import { AuditRow, getCrawlPages } from './database';
import { ConsentResult, PageCrawlResult } from './crawler';

// ─── Types for AI analysis output ───────────────────────────────────────────

export interface AnalysisIssue {
  title: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  evidence: string;
  business_impact: string;
  recommendation: string;
}

export interface AnalysisResult {
  health_score: number;
  executive_summary: string;
  data_impact_summary: string;
  issues: AnalysisIssue[];
  positive_findings: string[];
  limitations: string[];
}

export interface Scorecard {
  health_score: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  categories: Record<string, { issues: number; worst_severity: string }>;
}

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert web analytics QA specialist. You are reviewing raw tracking data captured from an automated crawl of a website. Your job is to identify every issue that could affect the reliability of this site's analytics data, conversion tracking, or consent compliance.

For each issue you find, provide:
- A clear, specific issue title
- Severity: critical (data is actively wrong), high (significant data gaps), medium (best practice violation with moderate risk), or low (minor improvement)
- Category: one of "GA4 Configuration", "Event Tracking", "Consent & Privacy", "Tag Health"
- What you observed (cite specific evidence from the crawl data — reference specific event names, measurement IDs, consent states, error messages, or network requests you can see)
- Why it matters (explain the business impact in plain English — how does this affect their reporting, their ad spend, their decision-making?)
- What to fix (specific, actionable recommendation — name the tool, the setting, or the tag that needs changing)

Also provide:
- An overall health score from 0-100
- An executive summary (3-4 sentences) stating the overall state of this site's tracking, the most critical issues, and the single most important thing to fix first
- A "what this likely means for your data" section that translates the technical findings into business consequences (e.g. "your reported conversion rate is likely overstated by approximately X% due to duplicate purchase events")

IMPORTANT ANALYSIS GUIDELINES — read carefully:

1. CRAWL TOOL LIMITATIONS vs CLIENT ISSUES: This data was captured by an external automated crawler. If measurement IDs appear as "G-X", "G-XXXXXX", or similar placeholders/masked values, this is a limitation of the crawl tool's ability to parse certain request formats — NOT a client-side configuration issue. Do not flag masked or placeholder measurement IDs as an issue. Instead, note this in the limitations section as "Some measurement IDs could not be fully resolved from server-side or proxied tracking requests."

8. GOOGLE ADS CCM REQUESTS: Requests labelled [Google Ads CCM] are Google Ads Conversion Measurement pings sent to googlesyndication.com/ccm/collect or doubleclick.net. These do NOT carry a "tid" (measurement ID) parameter — this is by design, not a misconfiguration. Do not flag missing measurement IDs on CCM requests as an issue. They should be counted separately from GA4 measurement requests. Note them as "Google Ads conversion tracking is active via CCM" in positive findings if present.

2. PAGE TYPE VARIATION IS NORMAL: Different page types naturally generate different numbers of GA4 requests and dataLayer events. A product page firing more events than a homepage is expected behaviour (view_item, ecommerce events, etc.). A pricing page may fire different events than an about page. Only flag request volume differences as issues if they indicate genuinely missing or duplicate tracking — not merely different counts across page types.

3. REALISTIC THRESHOLDS FOR "EXCESSIVE" REQUESTS: Fewer than 15 GA4 requests per page load is generally normal for sites with multiple tracking configurations, consent mode, and conversion pixels. Only flag request volume as excessive above 15-20 per page, or if you see clear evidence of duplicate events (same event name firing multiple times with identical parameters) rather than legitimately distinct tracking calls.

4. POSITIVE FINDINGS MUST BE SPECIFIC: Positive findings should cite specific evidence. Instead of generic statements like "GA4 is properly implemented", be specific: reference the actual measurement ID, the number of pages it was consistent across, or the specific events that are firing correctly. Specificity builds credibility. Example: "GA4 measurement ID G-XXXXXXX fires consistently across all 7 pages audited with no duplicate containers detected."

5. EVIDENCE-BASED ONLY: Do not invent issues that aren't supported by the evidence. If the data for a particular check is missing or inconclusive, say so rather than guessing. Do not pad the report with generic best practices — only report issues you can see evidence for in the crawl data.

6. FIRST-PARTY GA4 PROXIES: Some sites route GA4 tracking through a first-party proxy domain (e.g. "analytics.example.com" instead of "google-analytics.com"). When the crawl data shows GTM containers loading and dataLayer events firing BUT zero GA4 collect requests to Google domains, AND potential proxy domains are detected, this means GA4 is likely proxied — NOT missing. In this case:
   - Do NOT flag "No GA4 tracking detected" as a critical issue
   - DO note the proxy as an observation: "GA4 appears to be routed through a first-party proxy ([domain]), which limits external observation of measurement IDs and individual event data. This is a legitimate privacy/performance practice but means this audit cannot fully validate GA4 event configuration without access to the proxy endpoint or the GA4 property."
   - Adjust the health score appropriately: a proxied site with active GTM and dataLayer should not score as if it has no analytics at all. Score based on what IS observable (consent compliance, GTM configuration, dataLayer quality, etc.)
   - Include this in the limitations section rather than as an issue

7. MISSING CONSENT BANNER WITH ACTIVE CONSENT STATE: If a CMP is detected in the dataLayer (e.g. OneTrust consent events, Cookiebot config) but no visible consent banner was shown, this is likely because the CMP is configured to auto-apply consent defaults without showing a banner in certain jurisdictions (e.g. a deny-all default in regions where that's sufficient). Do NOT flag this as "Missing consent banner" or "CMP not working." Instead note it as an observation: "CMP ([name]) detected in dataLayer with consent defaults applied, but no visible banner was shown during the crawl. This is likely jurisdiction-based banner suppression." Only flag it as an issue if consent defaults are set to granted (which could indicate misconfigured implied consent).

When analysing consent data, pay special attention to:
- Whether consent defaults are set to denied (as required by GDPR)
- Whether analytics tags fire BEFORE consent is granted (a compliance violation)
- Whether the consent state changes correctly after the user accepts
- Whether all GA4 consent mode v2 parameters are implemented (ad_storage, analytics_storage, ad_user_data, ad_personalization)
- Whether tags that should be gated behind consent are actually gated

When analysing GA4 configuration, look for:
- Multiple measurement IDs (could indicate duplicate tracking)
- Multiple GTM containers (check if intentional or problematic)
- Missing or misconfigured events
- Consistency of tracking across different page types (remembering that different page types legitimately fire different events — see guideline 2)

ENRICHED DATA YOU WILL RECEIVE — use it:
- **DataLayer events** are deduplicated by event name, showing count and the FULL first payload. Check e-commerce events for required parameters (items, currency, value, transaction_id). Flag events with empty/null parameter values.
- **GA4 requests** are parsed into individual fields: event name (en=), measurement ID (tid=), page location (dl=), Google Consent State (gcs=), session engagement (seg=), and whether it's an Enhanced Measurement event. Use the GCS value to verify consent is actually being passed to Google — e.g. "G111" means all consent granted, "G100" means only analytics_storage granted.
- **Cross-page consistency matrices** show which GTM containers and dataLayer events appear on which pages/page types. Use these to identify pages with missing containers or events that only fire on some page types when they should fire everywhere.
- **GA4 events by page** lists the specific event names captured per page. Use this to identify missing page_view events, duplicate events, or pages where expected events (like view_item on product pages) are absent.

GCS (Google Consent State) values to know:
- G1xx = ad_storage granted; G0xx = denied
- Gx1x = analytics_storage granted; Gx0x = denied
- Gxx1 = ad_user_data granted; Gxx0 = denied
- Example: G111 = all granted, G100 = only ad_storage granted, G000 = all denied

Respond in JSON format with this exact structure:
{
  "health_score": number,
  "executive_summary": string,
  "data_impact_summary": string,
  "issues": [
    {
      "title": string,
      "severity": "critical" | "high" | "medium" | "low",
      "category": string,
      "evidence": string,
      "business_impact": string,
      "recommendation": string
    }
  ],
  "positive_findings": [string],
  "limitations": [string]
}`;

// ─── Data enrichment helpers ────────────────────────────────────────────────

/**
 * Parse GA4 collect URL parameters into structured data.
 * Extracts event name, page location, measurement ID, consent state, etc.
 */
function parseGA4CollectUrl(url: string): {
  event_name: string;
  measurement_id: string;
  page_location: string;
  gcs: string;          // Google Consent State
  session_engaged: string;
  enhanced_measurement: boolean;
  request_type: 'ga4' | 'google_ads_ccm' | 'unknown';
  all_params: Record<string, string>;
} {
  const params: Record<string, string> = {};
  let hostname = '';
  let pathname = '';
  try {
    const urlObj = new URL(url);
    hostname = urlObj.hostname;
    pathname = urlObj.pathname;
    urlObj.searchParams.forEach((v, k) => { params[k] = v; });
  } catch {
    // Some collect URLs may be malformed; try manual parse
    const qIdx = url.indexOf('?');
    if (qIdx >= 0) {
      url.substring(qIdx + 1).split('&').forEach(pair => {
        const [k, ...rest] = pair.split('=');
        if (k) params[k] = decodeURIComponent(rest.join('=') || '');
      });
    }
  }

  const enhancedMeasurementEvents = ['scroll', 'click', 'file_download', 'video_start', 'video_progress', 'video_complete', 'view_search_results'];

  // Detect Google Ads CCM (Conversion Measurement) requests — these use /ccm/collect
  // and don't carry a tid parameter. They use gdid instead.
  const isCCM = pathname.includes('/ccm/collect') ||
    hostname.includes('googlesyndication.com') ||
    hostname.includes('doubleclick.net');

  let requestType: 'ga4' | 'google_ads_ccm' | 'unknown' = 'unknown';
  if (isCCM) {
    requestType = 'google_ads_ccm';
  } else if (params['tid'] || pathname.includes('/g/collect')) {
    requestType = 'ga4';
  }

  return {
    event_name: params['en'] || 'unknown',
    measurement_id: params['tid'] || '',
    page_location: params['dl'] || '',
    gcs: params['gcs'] || '',
    session_engaged: params['seg'] || '',
    enhanced_measurement: enhancedMeasurementEvents.includes(params['en'] || ''),
    request_type: requestType,
    all_params: params,
  };
}

/**
 * Analyse dataLayer events: deduplicate by event name, include first full payload,
 * flag empty/null values, identify e-commerce events missing required params.
 */
function analyseDataLayerEvents(dlEvents: any[]): {
  summary: string;
  unique_events: { name: string; count: number; first_payload: Record<string, any>; issues: string[] }[];
  total_count: number;
} {
  const byName = new Map<string, { count: number; first: any; issues: string[] }>();

  const ecommerceRequiredParams: Record<string, string[]> = {
    'add_to_cart': ['currency', 'value', 'items'],
    'remove_from_cart': ['currency', 'value', 'items'],
    'begin_checkout': ['currency', 'value', 'items'],
    'purchase': ['transaction_id', 'currency', 'value', 'items'],
    'view_item': ['currency', 'value', 'items'],
    'view_item_list': ['item_list_id', 'items'],
    'select_item': ['items'],
    'add_payment_info': ['currency', 'value', 'payment_type'],
    'add_shipping_info': ['currency', 'value', 'shipping_tier'],
  };

  for (const dl of dlEvents) {
    const data = dl.data || dl;
    const eventName = data.event || data.eventName || '(no event name)';

    if (!byName.has(eventName)) {
      const issues: string[] = [];

      // Check for empty/null values in payload
      const nullKeys = Object.entries(data)
        .filter(([k, v]) => k !== 'event' && k !== 'gtm.uniqueEventId' && (v === null || v === '' || v === 'null' || v === undefined))
        .map(([k]) => k);
      if (nullKeys.length > 0) {
        issues.push(`Empty/null values in: ${nullKeys.join(', ')}`);
      }

      // Check e-commerce required params
      if (ecommerceRequiredParams[eventName]) {
        const missing = ecommerceRequiredParams[eventName].filter(p => !(p in data) && !(data.ecommerce && p in data.ecommerce));
        if (missing.length > 0) {
          issues.push(`Missing required e-commerce params: ${missing.join(', ')}`);
        }
      }

      // Check for page_view required params
      if (eventName === 'page_view' || eventName === 'gtm.js') {
        // page_view should ideally have page info
      }

      byName.set(eventName, { count: 0, first: data, issues });
    }
    byName.get(eventName)!.count++;
  }

  const unique_events = [...byName.entries()].map(([name, info]) => ({
    name,
    count: info.count,
    first_payload: info.first,
    issues: info.issues,
  }));

  return {
    summary: unique_events.map(e => `${e.name} (×${e.count})`).join(', '),
    unique_events,
    total_count: dlEvents.length,
  };
}

/**
 * Build cross-page consistency matrices: which containers/events appear on which pages.
 */
function buildConsistencyMatrices(pageEntries: any[]): {
  containerMatrix: string;
  eventMatrix: string;
  ga4ZeroPages: string[];
  avgGA4Count: number;
} {
  // Container coverage matrix
  const allContainers = new Set<string>();
  const pageContainers = new Map<string, Set<string>>();

  for (const page of pageEntries) {
    const key = `${page.page_type}: ${page.page_url}`;
    const gtmReqs = safeParseJSON(page.gtm_requests, []);
    const containers = new Set<string>();
    for (const r of gtmReqs) {
      if (r.container_id) {
        allContainers.add(r.container_id);
        containers.add(r.container_id);
      }
    }
    pageContainers.set(key, containers);
  }

  let containerMatrix = '';
  if (allContainers.size > 0) {
    const containerIds = [...allContainers];
    containerMatrix = `| Page | ${containerIds.join(' | ')} |\n`;
    containerMatrix += `| --- | ${containerIds.map(() => '---').join(' | ')} |\n`;
    for (const [pageKey, containers] of pageContainers) {
      const shortKey = pageKey.length > 40 ? pageKey.substring(0, 40) + '...' : pageKey;
      containerMatrix += `| ${shortKey} | ${containerIds.map(c => containers.has(c) ? '✓' : '✗').join(' | ')} |\n`;
    }
  }

  // Event coverage matrix (by page type, not individual page)
  const allEventNames = new Set<string>();
  const typeEvents = new Map<string, Set<string>>();

  for (const page of pageEntries) {
    const dlEvents = safeParseJSON(page.datalayer_events, []);
    if (!typeEvents.has(page.page_type)) typeEvents.set(page.page_type, new Set());
    for (const dl of dlEvents) {
      const name = (dl.data || dl).event || (dl.data || dl).eventName;
      if (name && !name.startsWith('gtm.')) {
        allEventNames.add(name);
        typeEvents.get(page.page_type)!.add(name);
      }
    }
  }

  let eventMatrix = '';
  if (allEventNames.size > 0) {
    const eventNames = [...allEventNames].slice(0, 20); // Cap at 20 to keep manageable
    const types = [...typeEvents.keys()];
    eventMatrix = `| Event | ${types.join(' | ')} |\n`;
    eventMatrix += `| --- | ${types.map(() => '---').join(' | ')} |\n`;
    for (const evt of eventNames) {
      eventMatrix += `| ${evt} | ${types.map(t => typeEvents.get(t)!.has(evt) ? '✓' : '✗').join(' | ')} |\n`;
    }
  }

  // Pages with zero GA4
  const ga4ZeroPages: string[] = [];
  let totalGA4 = 0;
  for (const page of pageEntries) {
    const count = safeParseJSON(page.ga4_requests, []).length;
    totalGA4 += count;
    if (count === 0) ga4ZeroPages.push(`${page.page_type}: ${page.page_url}`);
  }

  return {
    containerMatrix,
    eventMatrix,
    ga4ZeroPages,
    avgGA4Count: pageEntries.length > 0 ? Math.round(totalGA4 / pageEntries.length * 10) / 10 : 0,
  };
}

// ─── Prompt construction ────────────────────────────────────────────────────

/**
 * Build the user prompt with all crawl data for the AI to analyse.
 * Carefully structured so the AI has everything it needs.
 */
function buildUserPrompt(
  audit: AuditRow,
  crawlData: ReturnType<typeof getCrawlPages>,
  consentData: ConsentResult | null
): string {
  const sections: string[] = [];

  // ── Audit context ──
  sections.push(`## Audit Context
- Website: ${audit.website_url}
- Platform: ${audit.platform}
- Stated conversion events: ${audit.conversion_events}
- Consent Management Platform: ${audit.cmp}
- Recent changes: ${audit.recent_changes || 'None specified'}
- Company: ${audit.company_name}`);

  // ── Consent analysis ──
  if (consentData) {
    sections.push(`## Consent Analysis

### CMP Detection
- CMP detected: ${consentData.cmpDetected || 'None detected'}
- Consent banner found: ${consentData.bannerFound}
- Accept button found: ${consentData.acceptButtonFound}
- Accept button clicked: ${consentData.acceptButtonClicked}

### Default Consent State (BEFORE user interaction)
${consentData.defaultConsentState
  ? Object.entries(consentData.defaultConsentState)
      .filter(([k]) => !['region', 'wait_for_update', 'gtm.uniqueEventId'].includes(k))
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n')
  : 'No consent state detected'}

### Post-Consent State (AFTER clicking Accept All)
${consentData.postConsentState
  ? Object.entries(consentData.postConsentState)
      .filter(([k]) => !['region', 'wait_for_update', 'gtm.uniqueEventId'].includes(k))
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n')
  : 'No post-consent state detected'}

### GA4 Requests That Fired After Consent Was Granted
${consentData.postConsentGA4Requests.length > 0
  ? consentData.postConsentGA4Requests
      .map(r => {
        const parsed = parseGA4CollectUrl(r.url || '');
        return `- Event: ${parsed.event_name} | Measurement ID: ${r.measurement_id || parsed.measurement_id || 'unknown'} | GCS: ${parsed.gcs || 'not present'} | Page: ${parsed.page_location || 'unknown'}`;
      })
      .join('\n')
  : 'No GA4 requests fired after consent was granted'}

### Post-Consent DataLayer Events
${consentData.postConsentDataLayer.length > 0
  ? consentData.postConsentDataLayer
      .slice(0, 15)
      .map(d => `- ${JSON.stringify(d.data).substring(0, 300)}`)
      .join('\n')
  : 'No post-consent dataLayer events captured'}`);
  }

  // ── Consent-without-banner context ──
  if (consentData && !consentData.bannerFound && consentData.defaultConsentState) {
    sections.push(`## Consent Context Note
The crawl detected consent state values in the dataLayer (see above) but NO visible consent banner was displayed. The CMP may be configured to suppress the banner in certain jurisdictions while still applying deny-all defaults. This does NOT necessarily indicate a misconfiguration.`);
  }

  // ── Per-page crawl data (enriched) ──
  const pageEntries = crawlData.filter(p => p.page_type !== 'consent_check');
  sections.push(`## Pages Crawled (${pageEntries.length} pages)\n`);

  for (const page of pageEntries) {
    const dlEvents = safeParseJSON(page.datalayer_events, []);
    const ga4Reqs = safeParseJSON(page.ga4_requests, []);
    const gtmReqs = safeParseJSON(page.gtm_requests, []);
    const consoleErrs = safeParseJSON(page.console_errors, []);
    const proxies = safeParseJSON(page.potential_proxies, []);

    // Enriched dataLayer analysis
    const dlAnalysis = analyseDataLayerEvents(dlEvents);

    // Enriched GA4 request parsing
    const parsedGA4 = ga4Reqs.map((r: any) => parseGA4CollectUrl(r.url || ''));

    // Format load time — if it's >= 29000ms, it's likely a networkidle timeout, not a real measurement
    const loadMs = page.page_load_ms || 0;
    const loadTimeDisplay = loadMs >= 29000
      ? `${(loadMs / 1000).toFixed(1)}s+ (networkidle timeout — page was still loading)`
      : `${loadMs}ms`;

    sections.push(`### Page: ${page.page_type} — ${page.page_url}
- Load time: ${loadTimeDisplay}
- DataLayer events: ${dlAnalysis.total_count} total, ${dlAnalysis.unique_events.length} unique
- GA4 network requests: ${ga4Reqs.length}
- GTM container loads: ${gtmReqs.length}
- Console errors/warnings: ${consoleErrs.length}

#### DataLayer Events (deduplicated with first payload)
${dlAnalysis.unique_events.length > 0
  ? dlAnalysis.unique_events.slice(0, 25).map(e => {
      // Show event name, count, key parameters (not gtm internals)
      const cleanPayload = { ...e.first_payload };
      delete cleanPayload['gtm.uniqueEventId'];
      delete cleanPayload['gtm.start'];
      delete cleanPayload['gtm.triggers'];
      delete cleanPayload['gtm.scrollThreshold'];
      delete cleanPayload['gtm.scrollUnits'];
      delete cleanPayload['gtm.scrollDirection'];
      delete cleanPayload['gtm.oldHistoryUrl'];
      delete cleanPayload['gtm.newHistoryUrl'];
      delete cleanPayload['gtm.oldUrl'];
      delete cleanPayload['gtm.newUrl'];
      const payloadStr = JSON.stringify(cleanPayload).substring(0, 500);
      let line = `- **${e.name}** (×${e.count}): ${payloadStr}`;
      if (e.issues.length > 0) {
        line += `\n  ⚠️ ${e.issues.join('; ')}`;
      }
      return line;
    }).join('\n')
  : '(none captured)'}

#### GA4 Requests (parsed)
${parsedGA4.length > 0
  ? parsedGA4.map((p: any) => {
      const typeLabel = p.request_type === 'google_ads_ccm' ? '[Google Ads CCM]' : '[GA4]';
      let line = `- ${typeLabel} **${p.event_name}** → ${p.measurement_id || (p.request_type === 'google_ads_ccm' ? '(CCM — no tid expected)' : 'no tid')}`;
      if (p.gcs) line += ` | GCS: ${p.gcs}`;
      if (p.session_engaged) line += ` | Engaged: ${p.session_engaged}`;
      if (p.enhanced_measurement) line += ` | [Enhanced Measurement]`;
      if (p.page_location) line += ` | Page: ${p.page_location.substring(0, 100)}`;
      return line;
    }).join('\n')
  : '(none captured)'}

#### GTM Containers
${gtmReqs.length > 0
  ? gtmReqs.map((r: any) => `- Container: ${r.container_id || 'unknown'}`).join('\n')
  : '(none detected)'}

#### Console Errors/Warnings
${consoleErrs.length > 0
  ? consoleErrs.slice(0, 10).map((e: string) => `- ${e}`).join('\n')
  : '(none)'}
${proxies.length > 0
  ? `\n#### Potential First-Party GA4 Proxies\n${proxies.map((p: any) => `- Domain: ${p.domain} (detected via: ${p.reason}) — ${p.url}`).join('\n')}`
  : ''}`);
  }

  // ── Summary of all measurement IDs seen ──
  const allMeasurementIds = new Set<string>();
  const allContainerIds = new Set<string>();
  for (const page of pageEntries) {
    const ga4Reqs = safeParseJSON(page.ga4_requests, []);
    const gtmReqs = safeParseJSON(page.gtm_requests, []);
    for (const r of ga4Reqs) {
      if (r.measurement_id) allMeasurementIds.add(r.measurement_id);
    }
    for (const r of gtmReqs) {
      if (r.container_id) allContainerIds.add(r.container_id);
    }
  }

  // ── Collect all proxy domains across pages ──
  const allProxyDomains = new Set<string>();
  for (const page of pageEntries) {
    const proxies = safeParseJSON(page.potential_proxies, []);
    for (const p of proxies) {
      if (p.domain) allProxyDomains.add(p.domain);
    }
  }

  sections.push(`## Summary of IDs Detected Across All Pages
- GA4/Google Ads Measurement IDs: ${[...allMeasurementIds].join(', ') || 'none'}
- GTM Container IDs: ${[...allContainerIds].join(', ') || 'none'}
- Potential First-Party Analytics Proxy Domains: ${[...allProxyDomains].join(', ') || 'none'}`);

  // ── Cross-page consistency matrices ──
  const consistency = buildConsistencyMatrices(pageEntries);

  let consistencySection = `## Cross-Page Consistency Analysis\n`;
  consistencySection += `- Average GA4 requests per page: ${consistency.avgGA4Count}\n`;

  if (consistency.ga4ZeroPages.length > 0) {
    consistencySection += `- ⚠️ Pages with ZERO GA4 requests: ${consistency.ga4ZeroPages.join('; ')}\n`;
  } else {
    consistencySection += `- All pages have at least one GA4 request ✓\n`;
  }

  if (consistency.containerMatrix) {
    consistencySection += `\n### GTM Container Coverage Matrix\n${consistency.containerMatrix}`;
  }

  if (consistency.eventMatrix) {
    consistencySection += `\n### DataLayer Event Coverage by Page Type\n${consistency.eventMatrix}`;
  }

  // Per-page GA4 event breakdown
  consistencySection += `\n### GA4 Events by Page\n`;
  for (const page of pageEntries) {
    const ga4Reqs = safeParseJSON(page.ga4_requests, []);
    const eventNames = ga4Reqs.map((r: any) => parseGA4CollectUrl(r.url || '').event_name);
    consistencySection += `- ${page.page_type} (${page.page_url}): ${eventNames.length > 0 ? eventNames.join(', ') : 'none'}\n`;
  }

  sections.push(consistencySection);

  return sections.join('\n\n');
}

// ─── API call ───────────────────────────────────────────────────────────────

/**
 * Run the AI analysis on crawl data for a given audit.
 * Returns the parsed analysis result and the raw API response.
 */
export async function analyseAudit(
  audit: AuditRow,
  consentData: ConsentResult | null
): Promise<{ analysis: AnalysisResult; scorecard: Scorecard; rawResponse: string }> {

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in environment variables');
  }

  const client = new Anthropic({ apiKey });
  const crawlData = getCrawlPages(audit.id);

  if (crawlData.length === 0) {
    throw new Error('No crawl data found for this audit. Run the crawl first.');
  }

  const userPrompt = buildUserPrompt(audit, crawlData, consentData);

  console.log(`[Analyser] Sending ${userPrompt.length} chars to Anthropic API for audit ${audit.id}...`);

  console.log(`[Analyser] System prompt: ${SYSTEM_PROMPT.length} chars`);
  console.log(`[Analyser] User prompt: ${userPrompt.length} chars`);
  console.log(`[Analyser] Total prompt size: ~${Math.round((SYSTEM_PROMPT.length + userPrompt.length) / 1000)}k chars`);

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });
  } catch (apiErr: any) {
    console.error(`[Analyser] Anthropic API call failed:`);
    console.error(`  Status: ${apiErr?.status || 'unknown'}`);
    console.error(`  Message: ${apiErr?.message || apiErr}`);
    if (apiErr?.error) console.error(`  Error body:`, JSON.stringify(apiErr.error, null, 2));
    throw apiErr;
  }

  // Extract the text response
  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Anthropic API');
  }

  const rawResponse = textBlock.text;
  console.log(`[Analyser] Got ${rawResponse.length} char response from API`);

  // Parse the JSON response — the AI should return valid JSON but may wrap it in markdown
  let jsonStr = rawResponse;
  // Strip markdown code fences if present
  const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  let analysis: AnalysisResult;
  try {
    analysis = JSON.parse(jsonStr);
  } catch (parseErr) {
    console.error('[Analyser] Failed to parse AI response as JSON:', rawResponse.substring(0, 500));
    throw new Error('Failed to parse AI analysis response as JSON');
  }

  // Validate required fields
  if (typeof analysis.health_score !== 'number') analysis.health_score = 50;
  if (!analysis.executive_summary) analysis.executive_summary = 'Analysis completed but summary was not generated.';
  if (!analysis.data_impact_summary) analysis.data_impact_summary = '';
  if (!Array.isArray(analysis.issues)) analysis.issues = [];
  if (!Array.isArray(analysis.positive_findings)) analysis.positive_findings = [];
  if (!Array.isArray(analysis.limitations)) analysis.limitations = [];

  // Build the scorecard
  const scorecard = buildScorecard(analysis);

  console.log(
    `[Analyser] Analysis complete — score: ${analysis.health_score}/100, ` +
    `${analysis.issues.length} issues (${scorecard.critical_count} critical, ` +
    `${scorecard.high_count} high)`
  );

  return { analysis, scorecard, rawResponse };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildScorecard(analysis: AnalysisResult): Scorecard {
  const categories: Record<string, { issues: number; worst_severity: string }> = {};
  const severityRank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

  let critical = 0, high = 0, medium = 0, low = 0;

  for (const issue of analysis.issues) {
    switch (issue.severity) {
      case 'critical': critical++; break;
      case 'high': high++; break;
      case 'medium': medium++; break;
      case 'low': low++; break;
    }

    const cat = issue.category || 'Other';
    if (!categories[cat]) {
      categories[cat] = { issues: 0, worst_severity: 'low' };
    }
    categories[cat].issues++;
    if ((severityRank[issue.severity] || 0) > (severityRank[categories[cat].worst_severity] || 0)) {
      categories[cat].worst_severity = issue.severity;
    }
  }

  return {
    health_score: analysis.health_score,
    critical_count: critical,
    high_count: high,
    medium_count: medium,
    low_count: low,
    categories,
  };
}

function safeParseJSON(str: string | null, fallback: any): any {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
