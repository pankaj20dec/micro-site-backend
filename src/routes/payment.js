import { Router } from "express";
import { prisma } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveAppBaseUrl, registerPayPalReturnPath } from "../lib/appBaseUrl.js";

export const paymentRouter = Router();

function prismaErrorCode(err) {
  return String(err?.code || err?.meta?.code || "");
}

function isUniqueConstraintError(err) {
  return prismaErrorCode(err) === "P2002";
}

function isMissingColumnError(err, column) {
  const message = String(err?.message || err?.meta?.column || "");
  return prismaErrorCode(err) === "P2022" || message.includes(column);
}

async function markApplicationPaid(applicationId, extra = {}) {
  const data = {
    paymentStatus: "PAID",
    paidAt: new Date(),
    ...extra,
  };
  try {
    return await prisma.application.update({
      where: { id: applicationId },
      data,
    });
  } catch (err) {
    if (!isMissingColumnError(err, "paidAt")) throw err;
    delete data.paidAt;
    return prisma.application.update({
      where: { id: applicationId },
      data,
    });
  }
}

async function recordPaymentEvent(data) {
  try {
    await prisma.paymentEvent.upsert({
      where: { providerEventId: data.providerEventId },
      create: data,
      update: {
        status: data.status,
        type: data.type,
      },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) return;
    console.warn("Payment event save failed:", err?.message || err);
  }
}

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
        stubData.paidAt = new Date();
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

// POST /api/payment/stripe/confirm — verify PaymentIntent with Stripe after client checkout
paymentRouter.post("/stripe/confirm", requireAuth, async (req, res) => {
  try {
    const { paymentIntentId } = req.body || {};

    const application = await prisma.application.findFirst({
      where: { userId: req.user.sub },
    });

    if (!application) {
      return res.status(404).json({ error: "No application found" });
    }

    if (application.paymentStatus === "PAID") {
      return res.json({ paid: true, status: "PAID" });
    }

    const intentId = paymentIntentId || application.stripePaymentIntentId;
    if (!intentId) {
      return res.status(400).json({ error: "No Stripe payment to confirm" });
    }

    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === "sk_test_placeholder") {
      await markApplicationPaid(application.id, {
        stripePaymentIntentId: intentId,
      });
      return res.json({ stub: true, paid: true, status: "PAID" });
    }

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const paymentIntent = await stripe.paymentIntents.retrieve(intentId);

    const metadataAppId = paymentIntent.metadata?.applicationId;
    const belongsToApplication =
      metadataAppId === application.id ||
      application.stripePaymentIntentId === paymentIntent.id;
    if (!belongsToApplication) {
      return res.status(403).json({ error: "Payment does not belong to this application" });
    }

    if (paymentIntent.status !== "succeeded" && paymentIntent.status !== "processing") {
      return res.status(400).json({
        error: "Payment not completed",
        status: paymentIntent.status,
      });
    }

    await markApplicationPaid(application.id, {
      stripePaymentIntentId: paymentIntent.id,
    });
    await recordPaymentEvent({
      applicationId: application.id,
      provider: "STRIPE",
      providerEventId: paymentIntent.id,
      type: "payment_intent.confirm",
      amount: paymentIntent.amount / 100,
      currency: paymentIntent.currency,
      status: paymentIntent.status,
    });

    return res.json({ paid: true, status: "PAID" });
  } catch (err) {
    console.error("Stripe confirm error:", err);
    const stripeMessage = err?.raw?.message || err?.message;
    if (err?.type === "StripeInvalidRequestError" || err?.statusCode === 404) {
      return res.status(400).json({
        error: stripeMessage || "Stripe payment could not be found. Try the card payment again.",
      });
    }
    if (isUniqueConstraintError(err)) {
      return res.json({ paid: true, status: "PAID" });
    }
    return res.status(500).json({
      error: stripeMessage || "Failed to confirm Stripe payment",
    });
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
      if (applicationId) {
        await markApplicationPaid(applicationId, {
          stripePaymentIntentId: pi.id,
        });
        await recordPaymentEvent({
          applicationId,
          provider: "STRIPE",
          providerEventId: event.id,
          type: event.type,
          amount: pi.amount / 100,
          currency: pi.currency,
          status: "succeeded",
        });
      }
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

function paypalApiBase() {
  return process.env.PAYPAL_MODE === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function paypalCheckoutUrl(order) {
  const links = Array.isArray(order?.links) ? order.links : [];
  return (
    links.find((link) => link.rel === "approve")?.href ||
    links.find((link) => link.rel === "payer-action")?.href ||
    null
  );
}

function paypalCaptureFromOrder(order) {
  return order?.purchase_units?.[0]?.payments?.captures?.[0] || null;
}

function paypalErrorDetail(body) {
  return (
    body?.details?.[0]?.description ||
    body?.message ||
    body?.error_description ||
    body?.error ||
    "Unknown PayPal error"
  );
}

function paypalErrorIssue(body) {
  return String(body?.details?.[0]?.issue || body?.name || "");
}

async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret || clientId === "placeholder") return null;

  const tokenRes = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || !tokenData.access_token) {
    const err = new Error(
      tokenData.error_description || tokenData.error || "PayPal authentication failed"
    );
    err.code = "PAYPAL_AUTH";
    throw err;
  }
  return tokenData.access_token;
}

async function fetchPayPalOrder(orderId, accessToken) {
  const orderRes = await fetch(`${paypalApiBase()}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const order = await orderRes.json();
  if (!orderRes.ok) {
    const err = new Error(paypalErrorDetail(order));
    err.code = paypalErrorIssue(order) || "PAYPAL_ORDER";
    throw err;
  }
  return order;
}

function isAlreadyCapturedIssue(issue) {
  const value = String(issue || "").toUpperCase();
  return (
    value.includes("ORDER_ALREADY_CAPTURED") ||
    value.includes("CAPTURE_ALREADY_EXISTS") ||
    value.includes("ORDER_ALREADY_COMPLETED")
  );
}

async function markPayPalOrderPaid(application, order, orderId) {
  const capture = paypalCaptureFromOrder(order);
  const captureId = capture?.id || application.paypalCaptureId || null;
  await markApplicationPaid(application.id, {
    paymentProvider: "PAYPAL",
    paypalOrderId: order?.id || orderId || application.paypalOrderId,
    ...(captureId ? { paypalCaptureId: captureId } : {}),
  });
  if (captureId) {
    await recordPaymentEvent({
      applicationId: application.id,
      provider: "PAYPAL",
      providerEventId: captureId,
      type: "PAYMENT.CAPTURE.COMPLETED",
      amount: application.membershipFee ?? 0,
      currency: process.env.PAYPAL_CURRENCY || "GBP",
      status: capture?.status || "COMPLETED",
    });
  }
  return captureId;
}

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

    let accessToken;
    try {
      accessToken = await getPayPalAccessToken();
    } catch (err) {
      console.error("PayPal token error:", err);
      return res.status(502).json({
        error: "PayPal authentication failed. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the server.",
      });
    }
    if (!accessToken) {
      return res.status(502).json({
        error: "PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
      });
    }

    const amountValue = Number(membershipFee).toFixed(2);
    const currency = (process.env.PAYPAL_CURRENCY || "GBP").toUpperCase();
    const appBase = resolveAppBaseUrl(req, req.body?.returnBaseUrl);

    const orderRes = await fetch(`${paypalApiBase()}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
      const issue = paypalErrorIssue(order);
      const detail = paypalErrorDetail(order);
      let hint = "";
      if (issue.includes("CURRENCY") || detail.toLowerCase().includes("currency")) {
        hint = " Your PayPal account may not support this currency — set PAYPAL_CURRENCY to a supported currency (GBP or USD) and match NEXT_PUBLIC_PAYPAL_CURRENCY.";
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

    const approveUrl = paypalCheckoutUrl(order);
    if (!approveUrl) {
      console.error("PayPal create-order missing checkout URL:", order.links);
      return res.status(502).json({ error: "PayPal did not return a checkout URL." });
    }

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
      where: { userId: req.user.sub },
    });

    if (!application) return res.status(404).json({ error: "Order not found" });

    if (application.paymentStatus === "PAID") {
      return res.json({ status: "COMPLETED", alreadyPaid: true });
    }

    if (!process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENT_ID === "placeholder") {
      await markApplicationPaid(application.id, {
        paypalCaptureId: `stub_capture_${Date.now()}`,
      });
      return res.json({ stub: true, status: "COMPLETED" });
    }

    let accessToken;
    try {
      accessToken = await getPayPalAccessToken();
    } catch (err) {
      console.error("PayPal capture token error:", err);
      return res.status(502).json({
        error: "PayPal authentication failed during capture.",
      });
    }
    if (!accessToken) {
      return res.status(502).json({ error: "PayPal is not configured." });
    }

    const captureRes = await fetch(
      `${paypalApiBase()}/v2/checkout/orders/${orderId}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          "PayPal-Request-Id": `capture-${orderId}`,
        },
        body: "{}",
      }
    );
    const capture = await captureRes.json();

    let order = capture;
    if (!captureRes.ok) {
      const issue = paypalErrorIssue(capture);
      console.error("PayPal capture error:", capture);
      if (isAlreadyCapturedIssue(issue) || capture.status === "COMPLETED") {
        try {
          order = await fetchPayPalOrder(orderId, accessToken);
        } catch (err) {
          console.error("PayPal order lookup after capture failed:", err);
          return res.status(502).json({ error: `PayPal capture failed: ${paypalErrorDetail(capture)}` });
        }
      } else {
        try {
          order = await fetchPayPalOrder(orderId, accessToken);
        } catch {
          order = capture;
        }
        if (String(order.status || "").toUpperCase() !== "COMPLETED") {
          const detail = paypalErrorDetail(capture);
          const status =
            issue.includes("ORDER_NOT_APPROVED") || issue.includes("PAYER_ACTION")
              ? 400
              : 502;
          return res.status(status).json({ error: `PayPal capture failed: ${detail}` });
        }
      }
    }

    const orderStatus = String(order.status || "").toUpperCase();
    if (orderStatus && orderStatus !== "COMPLETED" && orderStatus !== "PENDING") {
      return res.status(400).json({
        error: `PayPal payment is not complete yet (status: ${order.status}). Return from PayPal and try again.`,
      });
    }

    const captureId = await markPayPalOrderPaid(application, order, orderId);
    return res.json({ status: "COMPLETED", captureId });
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
