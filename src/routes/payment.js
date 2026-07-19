import { Router } from "express";
import { prisma } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveAppBaseUrl, registerPayPalReturnPath } from "../lib/appBaseUrl.js";

export const paymentRouter = Router();

// ─── Stripe ──────────────────────────────────────────────────────────────────

// POST /api/payment/stripe/create-intent
paymentRouter.post("/stripe/create-intent", requireAuth, async (req, res) => {
  try {
    const { membershipFee, confirmStub } = req.body || {};

    if (!membershipFee || ![250, 500].includes(Number(membershipFee))) {
      return res.status(400).json({ error: "Invalid membership fee. Must be 250 or 500." });
    }

    const application = await prisma.application.findFirst({
      where: { userId: req.user.sub },
    });

    if (!application) {
      return res.status(404).json({ error: "No application found" });
    }

    // TODO: wire real Stripe when STRIPE_SECRET_KEY is available
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === "sk_test_placeholder") {
      const stubData = {
        paymentProvider: "STRIPE",
        membershipFee,
      };
      if (confirmStub) {
        stubData.paymentStatus = "PAID";
        stubData.stripePaymentIntentId = `stub_pi_${Date.now()}`;
      }
      await prisma.application.update({
        where: { id: application.id },
        data: stubData,
      });
      return res.json({
        stub: true,
        paid: !!confirmStub,
        clientSecret: confirmStub ? undefined : "stub_secret",
        message: confirmStub
          ? "Dev mode: payment simulated as complete."
          : "Dev mode: select Continue to simulate payment. Add real STRIPE_SECRET_KEY to enable real payments.",
      });
    }

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Number(membershipFee) * 100, // pence
      currency: "gbp",
      metadata: { applicationId: application.id, userId: req.user.sub },
    });

    await prisma.application.update({
      where: { id: application.id },
      data: {
        paymentProvider: "STRIPE",
        membershipFee,
        stripePaymentIntentId: paymentIntent.id,
      },
    });

    return res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("Stripe create-intent error:", err);
    return res.status(500).json({ error: "Failed to create payment intent" });
  }
});

// POST /api/payment/stripe/webhook — Stripe fires this when payment succeeds
paymentRouter.post(
  "/stripe/webhook",
  // Raw body required for signature verification — set in index.js
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    if (!process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET === "whsec_placeholder") {
      return res.status(200).json({ stub: true });
    }

    let event;
    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Stripe webhook signature error:", err.message);
      return res.status(400).json({ error: "Webhook signature invalid" });
    }

    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;
      const { applicationId } = pi.metadata;

      await prisma.$transaction([
        prisma.application.update({
          where: { id: applicationId },
          data: { paymentStatus: "PAID" },
        }),
        prisma.paymentEvent.create({
          data: {
            applicationId,
            provider: "STRIPE",
            providerEventId: event.id,
            type: event.type,
            amount: pi.amount / 100,
            currency: pi.currency,
            status: "succeeded",
          },
        }),
      ]);
    }

    if (event.type === "payment_intent.payment_failed") {
      const pi = event.data.object;
      const { applicationId } = pi.metadata;

      await prisma.application.update({
        where: { id: applicationId },
        data: { paymentStatus: "FAILED" },
      });
    }

    return res.json({ received: true });
  }
);

// ─── PayPal ───────────────────────────────────────────────────────────────────

// POST /api/payment/paypal/create-order
paymentRouter.post("/paypal/create-order", requireAuth, async (req, res) => {
  try {
    const { membershipFee } = req.body || {};

    if (!membershipFee || ![250, 500].includes(Number(membershipFee))) {
      return res.status(400).json({ error: "Invalid membership fee. Must be 250 or 500." });
    }

    const application = await prisma.application.findFirst({
      where: { userId: req.user.sub },
    });

    if (!application) {
      return res.status(404).json({ error: "No application found" });
    }

    // TODO: wire real PayPal when credentials are available
    if (!process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID === "placeholder") {
      const stubOrderId = `stub_order_${Date.now()}`;
      await prisma.application.update({
        where: { id: application.id },
        data: {
          paymentProvider: "PAYPAL",
          membershipFee,
          paypalOrderId: stubOrderId,
        },
      });
      return res.json({
        stub: true,
        orderId: stubOrderId,
        message: "Dev mode: complete payment via the PayPal button. Add real PayPal credentials to enable real payments.",
      });
    }

    // Real PayPal Orders API v2
    const base = process.env.PAYPAL_MODE === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";

    const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();

    const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("PayPal token error:", tokenData);
      return res.status(502).json({
        error: "PayPal authentication failed. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the server.",
      });
    }

    const amountValue = Number(membershipFee).toFixed(2);
    const currency = process.env.PAYPAL_CURRENCY || "GBP";
    const appBase = resolveAppBaseUrl(req, req.body?.returnBaseUrl);

    const orderRes = await fetch(`${base}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: currency,
              value: amountValue,
            },
            custom_id: application.id,
          },
        ],
        application_context: {
          brand_name: "FIPO",
          locale: currency === "USD" ? "en-US" : "en-GB",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url: registerPayPalReturnPath(appBase, {
            form: "1",
            paypalReturn: "1",
          }),
          cancel_url: registerPayPalReturnPath(appBase, {
            form: "1",
            paypalCancel: "1",
          }),
        },
      }),
    });
    const order = await orderRes.json();

    if (!orderRes.ok || !order.id) {
      console.error("PayPal create-order error:", order);
      const issue = order.details?.[0]?.issue ?? "";
      const detail = order.details?.[0]?.description ?? order.message ?? "Unknown PayPal error";
      let hint = "";
      if (issue.includes("CURRENCY") || detail.toLowerCase().includes("currency")) {
        hint = " Your sandbox Business account may not support GBP — set PAYPAL_CURRENCY=USD in backend .env or create a UK sandbox Business account.";
      }
      return res.status(502).json({ error: `PayPal order failed: ${detail}.${hint}` });
    }

    await prisma.application.update({
      where: { id: application.id },
      data: {
        paymentProvider: "PAYPAL",
        membershipFee,
        paypalOrderId: order.id,
      },
    });

    const approveUrl = order.links?.find((link) => link.rel === "approve")?.href;

    return res.json({ orderId: order.id, approveUrl });
  } catch (err) {
    console.error("PayPal create-order error:", err);
    return res.status(500).json({ error: "Failed to create PayPal order" });
  }
});

// POST /api/payment/paypal/capture-order
paymentRouter.post("/paypal/capture-order", requireAuth, async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "orderId is required" });

    const application = await prisma.application.findFirst({
      where: { userId: req.user.sub, paypalOrderId: orderId },
    });

    if (!application) return res.status(404).json({ error: "Order not found" });

    if (!process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID === "placeholder") {
      await prisma.application.update({
        where: { id: application.id },
        data: {
          paymentStatus: "PAID",
          paypalCaptureId: `stub_capture_${Date.now()}`,
        },
      });
      return res.json({ stub: true, status: "COMPLETED" });
    }

    const base = process.env.PAYPAL_MODE === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";

    const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();

    const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("PayPal capture token error:", tokenData);
      return res.status(502).json({
        error: "PayPal authentication failed during capture.",
      });
    }

    const captureRes = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
    });
    const capture = await captureRes.json();

    if (!captureRes.ok) {
      console.error("PayPal capture error:", capture);
      const detail =
        capture.details?.[0]?.description ?? capture.message ?? "Capture failed";
      return res.status(502).json({ error: `PayPal capture failed: ${detail}` });
    }

    const captureId = capture.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    const currency = process.env.PAYPAL_CURRENCY || "GBP";

    await prisma.application.update({
      where: { id: application.id },
      data: { paymentStatus: "PAID", paypalCaptureId: captureId },
    });

    if (captureId) {
      await prisma.paymentEvent.upsert({
        where: { providerEventId: captureId },
        create: {
          applicationId: application.id,
          provider: "PAYPAL",
          providerEventId: captureId,
          type: "PAYMENT.CAPTURE.COMPLETED",
          amount: application.membershipFee ?? 0,
          currency,
          status: "COMPLETED",
        },
        update: {},
      });
    }

    return res.json({ status: "COMPLETED" });
  } catch (err) {
    console.error("PayPal capture error:", err);
    return res.status(500).json({ error: "Failed to capture PayPal order" });
  }
});

// POST /api/payment/paypal/webhook
paymentRouter.post("/paypal/webhook", async (req, res) => {
  // TODO: add PayPal HMAC verification when credentials are available
  const event = req.body;
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const captureId = event.resource?.id;
    const applicationId = event.resource?.custom_id;
    if (applicationId) {
      await prisma.paymentEvent.upsert({
        where: { providerEventId: captureId ?? event.id },
        create: {
          applicationId,
          provider: "PAYPAL",
          providerEventId: captureId ?? event.id,
          type: event.event_type,
          amount: parseFloat(event.resource?.amount?.value ?? "0"),
          currency: event.resource?.amount?.currency_code ?? "GBP",
          status: "COMPLETED",
        },
        update: {},
      });
    }
  }
  return res.json({ received: true });
});
