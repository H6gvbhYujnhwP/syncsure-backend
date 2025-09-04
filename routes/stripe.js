import express from "express";
import Stripe from "stripe";
import { pool } from "../db.js";

export const stripeRaw = express.raw({ type: "application/json" });
const router = express.Router();

router.post("/", async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  const stripeKey = process.env.STRIPE_SECRET_KEY || "";
  const stripe = stripeKey ? new Stripe(stripeKey, { apiVersion: "2024-06-20" }) : null;

  if (!secret || !stripe) {
    // No secrets: ack without doing anything so deploys don't break
    return res.status(204).send();
  }

  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, secret);

    // TODO: handle:
    // - checkout.session.completed (create customer + license)
    // - customer.subscription.updated (blocks/status change)
    // - customer.subscription.deleted (set canceled)
    console.log("Stripe event:", event.type);

    return res.json({ ok: true, type: event.type });
  } catch (e) {
    console.error("Stripe webhook error:", e.message);
    return res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;

