#!/usr/bin/env node
// Debug: find GA4 requests with missing tid parameter

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const { getCrawlPages, initDatabase } = require('../dist/database');
initDatabase();

const db = require('better-sqlite3')(require('path').join(__dirname, '..', 'data', 'trackguard.db'));
const audit = db.prepare("SELECT * FROM audits WHERE website_url LIKE '%allbirds%' ORDER BY id DESC LIMIT 1").get();
const crawlData = getCrawlPages(audit.id);

console.log('Audit:', audit.id, audit.reference_id, '\n');

let withTid = 0;
let withoutTid = 0;

for (const page of crawlData) {
  if (page.page_type === 'consent_check') continue;
  const ga4Reqs = JSON.parse(page.ga4_requests || '[]');

  for (const r of ga4Reqs) {
    if (!r.url) continue;

    try {
      const url = new URL(r.url);
      const tid = url.searchParams.get('tid');
      const en = url.searchParams.get('en');

      if (!tid) {
        withoutTid++;
        console.log(`\n=== NO TID on ${page.page_type} (${page.page_url}) ===`);
        console.log('Event name (en):', en);
        console.log('Full URL:', r.url.substring(0, 500));
        console.log('All params with "id" in name:');
        for (const [k, v] of url.searchParams) {
          if (k.includes('id') || k === 'tid' || k === 'cid' || k === 'uid') {
            console.log(`  ${k} = ${v}`);
          }
        }
        // Check if it uses a different format
        console.log('URL host:', url.hostname);
        console.log('URL path:', url.pathname);
      } else {
        withTid++;
      }
    } catch (e) {
      console.log('Could not parse URL:', r.url.substring(0, 200));
    }
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`With tid: ${withTid}`);
console.log(`Without tid: ${withoutTid}`);
console.log(`Total: ${withTid + withoutTid}`);
