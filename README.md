# TrackGuard

Web tracking QA and monitoring tool for performance marketing agencies.

Crawls client websites, captures analytics and consent data, and uses AI to generate professional audit reports — all without requiring access to the client's GA4 property or tag manager.

## Setup

```bash
# Install dependencies
npm install

# Copy environment variables and add your Anthropic API key
cp .env.example .env

# Build
npm run build

# Start
npm start

# Or run in dev mode (auto-rebuild + restart)
npm run dev
```

## Project Structure

```
trackguard/
├── src/
│   ├── server.ts          # Express app, routes, middleware
│   ├── database.ts        # SQLite schema and query helpers
│   ├── crawler.ts         # Playwright crawl engine
│   ├── analyser.ts        # Anthropic API integration
│   ├── reportBuilder.ts   # AI analysis → HTML report
│   └── utils.ts           # Helpers (ref IDs, validation, etc.)
├── views/                 # EJS templates
│   ├── layout.ejs
│   ├── intake.ejs
│   ├── confirmation.ejs
│   ├── admin/
│   │   ├── dashboard.ejs
│   │   └── audit-detail.ejs
│   └── report.ejs
├── public/
│   ├── css/style.css
│   └── screenshots/       # Crawl screenshots
├── data/                  # SQLite database (gitignored)
├── .env.example
└── package.json
```

## Status

V1 — in development.
