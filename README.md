# SyncSure Backend

This is the Render-only backend for SyncSure.

## Features
- Express API with health route
- PostgreSQL connection (via `pg`)
- Ready for Render deployment with `render.yaml`

## Running locally
```bash
npm install
npm start
```

## Project Structure
```
Syncsure-Backend/
├── index.js
├── package.json
├── package-lock.json
├── render.yaml
├── routes/
│   └── health.js
├── db/
│   └── db-test.js
└── README.md
```

## Environment Variables
- `DATABASE_URL` - PostgreSQL connection string
- `DATABASE_SSL` - Set to "true" for SSL connections
- `SESSION_SECRET` - Secret for session management
- `PORT` - Server port (defaults to 10000)

## API Endpoints
- `GET /` - Root endpoint
- `GET /api/health` - Health check endpoint

## Deployment
This project is configured for deployment on Render using the `render.yaml` file.

