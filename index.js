import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import healthRouter from "./routes/health.js";
import dbRouter from "./routes/db.js";
import licensesRouter from "./routes/licenses.js";
import authRouter from "./routes/auth.js";
import stripeRouter, { stripeRaw } from "./routes/stripe.js";
import { initializeDatabase } from "./scripts/deploy-init-db.js";

const app = express();
const port = process.env.PORT || 10000;

// CORS Configuration - Allow all origins for now
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Stripe webhook MUST use raw body and be mounted before json()
app.post("/api/stripe/webhook", stripeRaw, stripeRouter);

// JSON for the rest
app.use(express.json());

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
