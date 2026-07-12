// api/webhooks/razorpay.js
// Vercel serverless function (Node runtime — NOT edge, since we need the raw
// request body untouched for signature verification).
//
// Set this exact URL as your webhook endpoint in Razorpay Dashboard →
// Settings → Webhooks, and subscribe to: payment.captured, payment_link.paid
//
// Env vars needed: RAZORPAY_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import crypto from "crypto";

export const config = {
  api: { bodyParser: false }, // we need the raw body for signature verification
};

// Amounts are in cents (USD), since all your payment links are in USD.
// Razorpay sends payment.amount in the smallest currency unit — cents for USD.
const PLAN_AMOUNTS = {
  1000: "starter", // $10.00
  4900: "pro",      // $49.00
  9900: "agency",   // $99.00
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signature, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return expected === signature;
}

async function updateUserByEmail(email, plan) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}`,
    {
      method: "PATCH",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        plan,
        subscription_status: "active",
      }),
    }
  );
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-razorpay-signature"];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!signature || !verifySignature(rawBody, signature, secret)) {
    // Do not process anything on a bad signature — this is the line that
    // stops someone from POSTing a fake "payment succeeded" request.
    return res.status(400).json({ error: "Invalid signature" });
  }

  const body = JSON.parse(rawBody);
  const event = body.event;

  try {
    let payment = null;

    if (event === "payment.captured") {
      payment = body.payload.payment.entity;
    } else if (event === "payment_link.paid") {
      payment = body.payload.payment.entity;
    } else {
      // Not an event we act on (e.g. payment.failed, refund.processed).
      return res.status(200).json({ received: true, handled: false });
    }

    const email = payment.email;
    const amount = payment.amount;
    const plan = PLAN_AMOUNTS[amount];

    if (!email) {
      console.error("Razorpay webhook: no email on payment entity", payment.id);
      return res.status(200).json({ received: true, handled: false, reason: "no email" });
    }

    if (!plan) {
      console.error("Razorpay webhook: unrecognized amount", amount, payment.id);
      return res.status(200).json({ received: true, handled: false, reason: "unrecognized amount" });
    }

    await updateUserByEmail(email, plan);

    return res.status(200).json({ received: true, handled: true, email, plan });
  } catch (err) {
    console.error("Razorpay webhook processing error:", err);
    // Still return 200 if the signature was valid but our own processing
    // failed — otherwise Razorpay will retry for 24 hours on a bug in our
    // code, not just on real delivery failures. Log it and fix it directly.
    return res.status(200).json({ received: true, handled: false, error: "internal" });
  }
}

