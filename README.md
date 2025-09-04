# SyncSure Backend (Render-Only)

Express API + Worker for licenses, Stripe webhooks, GitHub build automation, and email delivery.

## Services
- Web API: `/api/health`, `/api/db/ping`, `/api/licenses`, `/api/stripe/webhook`
- Background Worker: polls queued/building builds and handles email

## Environment Variables (Render)
- DATABASE_URL (internal)
- DATABASE_SSL=true
- SESSION_SECRET
- FRONTEND_ORIGIN (optional)
- STRIPE_SECRET_KEY (optional)
- STRIPE_WEBHOOK_SECRET (optional)
- GITHUB_OWNER=H6gvbhYujnhwP
- GITHUB_REPO=Syncsure_Tool
- GITHUB_PAT
- RESEND_API_KEY

## Deploy (Render)
- Build: `npm install`
- Start (web): `npm start`
- Start (worker): `npm run worker`

## Health
- `GET /api/health`
- `GET /api/health/deep`
- `GET /api/db/ping`

## Licenses
- `GET /api/licenses`
- `POST /api/licenses` body: `{ "email":"user@x.com", "licenseKey":"KEY", "maxDevices":5 }`

## Worker
- Picks `builds.status='queued'` → triggers GH workflow
- Polls `builds.status='building'` → reads release by tag → marks `released` → emails user

## Local Dev
```bash
npm install
npm start           # web
npm run worker      # worker
npm run db:test     # quick DB check
```

## Project Structure
```
Syncsure-Backend/
├── index.js                 # Main Express server
├── db.js                    # Database connection
├── package.json             # Dependencies and scripts
├── render.yaml              # Render deployment config
├── .env.example             # Environment variables reference
├── README.md                # This file
├── routes/
│   ├── health.js           # Health check endpoints
│   ├── db.js               # Database ping endpoint
│   ├── licenses.js         # License management
│   └── stripe.js           # Stripe webhook handler
├── services/
│   ├── github.js           # GitHub API integration
│   └── email.js            # Email service (Resend)
├── worker.js               # Background worker
├── scripts/
│   └── db-test.js          # Database connection test
└── sql/
    └── schema.sql          # Database schema
```

## Progress Status

With this scaffold checked in and live, you're ~**80%** of the way:
- ✅ Backend API live
- ✅ DB wired
- ✅ Worker scaffolded (GitHub + email paths ready)
- 🔜 Wire real Stripe handlers, finalize GitHub workflow file name, and validate release asset naming
- 🔜 Hook frontend/dashboard to these endpoints

