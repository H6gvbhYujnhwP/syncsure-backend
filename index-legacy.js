import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { requestLogger, errorHandler } from "./middleware/logging.js";
import healthRouter from "./routes/health.js";
import dbRouter from "./routes/db.js";
import licensesRouter from "./routes/licenses.js";
import authRouter from "./routes/auth.js";
import migrationRouter from "./routes/migration.js";
import buildsRouter from "./routes/builds.js";
import adminRouter from "./routes/admin.js";
import stripeRouter, { stripeRaw } from "./routes/stripe.js";
import agentRouter from "./routes/agent.js";
import dashboardRouter from "./routes/dashboard.js";
import { initializeDatabase } from "./scripts/deploy-init-db.js";

const app = express();
const port = process.env.PORT || 10000;

// Trust proxy for Render deployment (required for rate limiting and correct client IPs)
app.set('trust proxy', 1);

// CORS Configuration - SyncSure V8 Blueprint Compliant
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
      console.log(`🚫 CORS blocked origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Stripe webhook MUST use raw body and be mounted before json()
app.post("/api/stripe/webhook", stripeRaw, stripeRouter);

// JSON for the rest
app.use(express.json());

// Cookie parser for session management
app.use(cookieParser());

// Request logging middleware
app.use(requestLogger);

// Very light rate-limit on /api/*
app.use(
  "/api",
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true
  })
);

// routes
app.use("/api/health", healthRouter);
app.use("/api/db", dbRouter);
app.use("/api/licenses", licensesRouter);
app.use("/api/auth", authRouter);
app.use("/api/migration", migrationRouter);
app.use("/api/builds", buildsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/stripe", stripeRouter);
app.use("/api/agent", agentRouter);
app.use("/api/dashboard", dashboardRouter);

// Backward compatibility routes for existing agents
app.use("/api", agentRouter); // This allows /api/bind, /api/heartbeat to work

// Error handling middleware (must be last)
app.use(errorHandler);

app.get("/", (_req, res) => {
  res.type("text").send("SyncSure Backend is running 🚀");
});

// Initialize database and start server
async function startServer() {
  try {
    console.log("🔄 Starting SyncSure Backend...");
    
    // Initialize database schema
    await initializeDatabase();
    
    // Start the server
    app.listen(port, () => {
      console.log(`✅ SyncSure Backend running on port ${port}`);
      console.log(`🌐 CORS: Allow all origins with credentials`);
      console.log(`🗄️ Database initialized and ready`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();
