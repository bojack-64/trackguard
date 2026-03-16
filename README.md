# TrackGuard

Web tracking QA and monitoring tool for performance marketing agencies.

Crawls client websites, captures analytics and consent data, and uses AI to generate professional audit reports — all without requiring access to the client's GA4 property or tag manager.

## Setup

```bash
# Install dependencies
npm install

# Install Playwright browser (Chromium)
npx playwright install chromium

# Copy environment variables
cp .env.example .env
# Edit .env and add your Anthropic API key (ANTHROPIC_API_KEY=sk-ant-...)

# Build TypeScript
npm run build

# Start the server
npm start
# Server runs on http://localhost:3000

# Or run in dev mode (auto-rebuild + restart on file changes)
npm run dev
```

## Running a Full Audit

### Step 1: Submit an audit via the intake form

Go to **http://localhost:3000** and fill in the intake form:
- **Website URL** — the site you want to audit (e.g. `https://www.allbirds.com`)
- **Client name** — for the report header
- **Contact email** — where the report link will eventually be sent
- **Audit type** — Full Audit or Quick Scan (currently both run the same crawl)

You'll get a confirmation page with a reference ID like `TG-2026-0014`.

### Step 2: Start the crawl from the admin dashboard

Go to **http://localhost:3000/admin** and find your audit in the table. Click into it, then click **Start Crawl**.

The crawl takes 2-4 minutes depending on the site. The page shows a spinner and auto-refreshes every 10 seconds. You'll see it move from `crawling` to `crawled` when done.

**What the crawl captures:**
- Homepage + up to 6 internal pages (product, blog, about, contact, etc.)
- All GA4 network requests (including server-side GTM proxies)
- GTM container IDs
- Full dataLayer contents on each page
- Consent state before and after accepting the cookie banner
- Homepage and consent banner screenshots
- Console errors

### Step 3: Generate the AI report

Once the crawl finishes, a **Generate Report** button appears. Click it.

Report generation takes 30-60 seconds (one Anthropic API call). The page auto-refreshes until the status changes to `report_ready`.

### Step 4: View the report

Click **View Report** on the audit detail page. The report opens at a shareable URL:

```
http://localhost:3000/report/TG-2026-0014
```

This URL works without being logged into the admin — it's what you send to clients. If the report isn't ready yet, visitors see a branded "in progress" page.

## The Report

Each report is a self-contained HTML page with:
- **Score** (0-100) — overall tracking health
- **Data Impact Summary** — plain-English business consequences of any issues found
- **Consent Analysis** — before/after table showing consent state changes when the cookie banner is accepted
- **Detailed Findings** — issue cards with severity, evidence, business impact, and fix recommendations
- **What's Working** — positive findings with specific evidence
- **Pages Audited** — table of all pages crawled with event counts
- **Limitations** — what the crawl couldn't see (no GA4 property access, etc.)

Screenshots are embedded inline (base64) so the report is fully portable — save it, email it, host it anywhere.

## Project Structure

```
trackguard/
├── src/
│   ├── server.ts          # Express app, routes, status flow
│   ├── database.ts        # SQLite schema and queries
│   ├── crawler.ts         # Playwright crawl engine
│   ├── analyser.ts        # Anthropic API analysis
│   ├── reportBuilder.ts   # HTML report generator
│   └── utils.ts           # Ref IDs, validation, helpers
├── views/                 # EJS templates
│   ├── layout.ejs
│   ├── intake.ejs
│   ├── confirmation.ejs
│   └── admin/
│       ├── dashboard.ejs
│       └── audit-detail.ejs
├── public/
│   ├── css/style.css
│   └── screenshots/       # Crawl screenshots (gitignored)
├── data/                  # SQLite database (gitignored, auto-created)
├── test-reports/          # Saved test report HTML files (gitignored)
├── .env.example
└── package.json
```

## Key Technical Details

- **Node.js + TypeScript + Express + EJS** — server-rendered, no frontend framework
- **SQLite** (better-sqlite3) — zero-config database, stored in `data/`
- **Playwright** — headless Chromium for crawling
- **Anthropic API** (Claude Sonnet) — AI analysis of crawl data
- **GA4 detection** catches server-side GTM proxies (matches `/g/collect` on any domain, not just Google)
- **Consent interaction** supports OneTrust, Cookiebot, HubSpot CMP, Quantcast, and generic cookie banners
- **Screenshots** are viewport-sized (1280x800) for the report, not full-page scrolls

## Environment Variables

```
PORT=3000                          # Server port (default: 3000)
ANTHROPIC_API_KEY=sk-ant-...       # Required for report generation
```

## Status

V1 — complete and operational. Ready for real audits.
