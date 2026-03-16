#!/usr/bin/env node
// Quick test to see what the enriched prompt looks like for an existing audit

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { getCrawlPages, initDatabase } = require('../dist/database');
initDatabase();
const db = require('better-sqlite3')(require('path').join(__dirname, '..', 'data', 'trackguard.db'));

// Find latest Allbirds audit
const audit = db.prepare("SELECT * FROM audits WHERE website_url LIKE '%allbirds%' ORDER BY id DESC LIMIT 1").get();
if (!audit) {
  console.log('No Allbirds audit found');
  process.exit(1);
}
console.log('Audit:', audit.id, audit.reference_id, '\n');

const crawlData = getCrawlPages(audit.id);
const homepage = crawlData.find(p => p.page_type === 'homepage');

if (!homepage) {
  console.log('No homepage data');
  process.exit(1);
}

// Test GA4 URL parsing
const ga4Reqs = JSON.parse(homepage.ga4_requests || '[]');
console.log('=== GA4 REQUESTS ON HOMEPAGE (' + ga4Reqs.length + ') ===');
for (const r of ga4Reqs) {
  if (r.url) {
    try {
      const url = new URL(r.url);
      const params = {};
      url.searchParams.forEach((v, k) => { params[k] = v; });
      console.log(`  Event: ${params['en'] || 'unknown'} | TID: ${params['tid'] || 'none'} | GCS: ${params['gcs'] || 'none'} | Page: ${(params['dl'] || '').substring(0, 80)}`);
    } catch (e) {
      console.log('  (could not parse URL)');
    }
  }
}

// Test dataLayer analysis
const dlEvents = JSON.parse(homepage.datalayer_events || '[]');
console.log('\n=== DATALAYER EVENTS ON HOMEPAGE (' + dlEvents.length + ' total) ===');
const byName = new Map();
for (const dl of dlEvents) {
  const data = dl.data || dl;
  const name = data.event || '(no name)';
  if (!byName.has(name)) byName.set(name, { count: 0, first: data });
  byName.get(name).count++;
}
for (const [name, info] of byName) {
  const payload = JSON.stringify(info.first);
  console.log(`  ${name} (×${info.count}): ${payload.substring(0, 200)}`);
}

// Show e-commerce events with param check
console.log('\n=== E-COMMERCE EVENT PARAM CHECK ===');
const ecomRequired = {
  'add_to_cart': ['currency', 'value', 'items'],
  'purchase': ['transaction_id', 'currency', 'value', 'items'],
  'view_item': ['currency', 'value', 'items'],
  'begin_checkout': ['currency', 'value', 'items'],
};
for (const [name, info] of byName) {
  if (ecomRequired[name]) {
    const data = info.first;
    const missing = ecomRequired[name].filter(p => !(p in data) && !(data.ecommerce && p in data.ecommerce));
    console.log(`  ${name}: ${missing.length === 0 ? '✓ All required params present' : '✗ Missing: ' + missing.join(', ')}`);
  }
}

// Cross-page container coverage
console.log('\n=== CONTAINER COVERAGE ===');
const pages = crawlData.filter(p => p.page_type !== 'consent_check');
for (const page of pages) {
  const gtm = JSON.parse(page.gtm_requests || '[]');
  const containers = gtm.map(r => r.container_id).filter(Boolean);
  const ga4Count = JSON.parse(page.ga4_requests || '[]').length;
  console.log(`  ${page.page_type} (${page.page_url.substring(0, 50)}): GTM=[${containers.join(', ')}] GA4=${ga4Count}`);
}

console.log('\n✓ Enriched data parsing works correctly');
