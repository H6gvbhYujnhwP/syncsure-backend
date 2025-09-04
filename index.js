import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import healthRouter from "./routes/health.js";
import dbRouter from "./routes/db.js";
import licensesRouter from "./routes/licenses.js";
import stripeRouter, { stripeRaw } from "./routes/stripe.js";

const app = express();
const port = process.env.PORT || 10000;
const origin = process.env.FRONTEND_ORIGIN || "*";

app.use(cors({ origin }));

// Stripe webhook MUST use raw body and be mounted before json()
app.post("/api/stripe/webhook", stripeRaw, stripeRouter);

// JSON for the rest
app.use(express.json());

// very light rate-limit on /api/*
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

app.get("/", (_req, res) => {
  res.type("text").send("SyncSure Backend is running 🚀");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

