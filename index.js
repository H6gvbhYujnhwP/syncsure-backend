/**
 * SyncSure V9 Backend - Single License, Quantity-Based System
 */

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { requestLogger, errorHandler } from "./middleware/logging.js";

// V9 Routes
import healthRouter from "./routes/health.js";
import dbRouter from "./routes/db.js";
import licensesRouter from "./routes/licenses.js";
import authRouter from "./routes/auth.js";
import migrationRouter from "./routes/migration.js";
import buildsRouter from "./routes/builds.js";
import adminRouter from "./routes/admin.js";
import agentRouter from "./routes/agent.js";

// V9 Specific Routes (ES6 modules)
import stripeV9Router from './routes/stripe-v9.mjs';
import dashboardV9Router from './routes/dashboard-v9-complete.mjs';

// Legacy routes for backward compatibility
import stripeRouter, { stripeRaw } from "./routes/stripe.js";
import dashboardRouter from "./routes/dashboard.js";

import { initializeDatabase } from "./scripts/deploy-init-db.js";

const app = express();
const port = process.env.PORT || 10000;

// Trust proxy for Render deployment
app.set('trust proxy', 1);

// CORS Configuration - V9 Enhanced
const allowedOrigins = [
  'https://syncsure.cloud',
  'https://syncsure-website.onrender.com', 
  'https://syncsure-dashboard.onrender.com',
  'http://localhost:5173',  // Vite dev server
  'http://localhost:3000',  // React dev server
  'http://localhost:8080'   // Alternative dev server
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman, agent)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.log(`🚫 [V9] CORS blocked origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Stripe webhook needs raw body (before JSON parsing)
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeV9Router);

// V9 Stripe webhook (new endpoint)
app.post("/api/v9/stripe/webhook", express.raw({ type: "application/json" }), stripeV9Router);

// JSON for the rest
app.use(express.json());

// Cookie parser for session management
app.use(cookieParser());

// Request logging middleware
app.use(requestLogger);

// Rate limiting
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    message: { error: 'Too many requests, please try again later.' }
  })
);

// V9 Routes (Primary)
app.use("/api/v9/stripe", stripeV9Router);
app.use("/api/v9/dashboard", dashboardV9Router);

// Core routes
app.use("/api/health", healthRouter);
app.use("/api/db", dbRouter);
app.use("/api/licenses", licensesRouter);
app.use("/api/auth", authRouter);
app.use("/api/migration", migrationRouter);
app.use("/api/builds", buildsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/agent", agentRouter);

// Legacy routes (backward compatibility)
app.use("/api/stripe", stripeRouter);
app.use("/api/dashboard", dashboardRouter);

// Backward compatibility for existing agents
app.use("/api", agentRouter); // Allows /api/bind, /api/heartbeat

// Error handling middleware (must be last)
app.use(errorHandler);

// Root endpoint
app.get("/", (_req, res) => {
  res.type("text").send("SyncSure V9 Backend - Single License System 🚀");
});

// Health check with V9 info
app.get("/api/version", (_req, res) => {
  res.json({
    version: "9.0.0",
    system: "single-license-quantity-based",
    features: [
      "single-license-per-account",
      "quantity-based-pricing",
      "self-healing-dashboard",
      "stripe-sync-endpoints",
      "comprehensive-audit-logging"
    ],
    timestamp: new Date().toISOString()
  });
});

// Initialize database and start server
async function startServer() {
  try {
    console.log("🚀 Starting SyncSure V9 Backend...");
    console.log("📋 System: Single License, Quantity-Based");
    
    // Initialize database schema
    await initializeDatabase();
    
    // Start the server
    app.listen(port, () => {
      console.log(`✅ SyncSure V9 Backend running on port ${port}`);
      console.log(`🌐 CORS: Configured for production and development`);
      console.log(`🗄️ Database: V9 schema initialized`);
      console.log(`🔧 Features: Single license per account, quantity-based pricing`);
      console.log(`🔄 Endpoints: V9 Stripe sync, self-healing dashboard`);
      console.log(`📊 Monitoring: Comprehensive audit logging enabled`);
    });
  } catch (error) {
    console.error("❌ Failed to start V9 server:", error.message);
    process.exit(1);
  }
}

startServer();

