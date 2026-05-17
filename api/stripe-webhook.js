import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getRawBody(readable) {
  const chunks = [];

  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  let event;

  try {

    const rawBody = await getRawBody(req);

    const signature = req.headers["stripe-signature"];

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

  } catch (err) {

    console.error("Webhook Error:", err.message);

    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {

    if (event.type === "checkout.session.completed") {

      const session = event.data.object;

      const email =
        session.customer_details?.email ||
        session.customer_email;

      if (!email) {
        return res.status(400).json({
          error: "Email não encontrado na sessão Stripe",
        });
      }

      const customerId = session.customer;

      const subscriptionId = session.subscription;

      let subscription = null;

      if (subscriptionId) {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
      }

      const priceId =
        subscription?.items?.data?.[0]?.price?.id || null;

      let plan = "mensal";

      if (
        priceId === "price_SEMESTRAL_ID"
      ) {
        plan = "semestral";
      }

      if (
        priceId === "price_ANUAL_ID"
      ) {
        plan = "anual";
      }

      let expiresAt = new Date();

      if (plan === "mensal") {
        expiresAt.setMonth(expiresAt.getMonth() + 1);
      }

      if (plan === "semestral") {
        expiresAt.setMonth(expiresAt.getMonth() + 6);
      }

      if (plan === "anual") {
        expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      }

      const { error } = await supabase
        .from("subscriptions")
        .upsert(
          {
            email,
            plan,
            status: "active",
            expires_at: expiresAt.toISOString(),
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
            stripe_session_id: session.id,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "email",
          }
        );

      if (error) {

        console.error("Supabase subscription error:", error);

        return res.status(500).json({
          error: error.message,
        });
      }

      const { error: inviteError } =
        await supabase.auth.admin.inviteUserByEmail(
          email,
          {
            redirectTo:
              "https://www.emergys.com.br/login.html",
          }
        );

      if (
        inviteError &&
        !inviteError.message.includes("already registered")
      ) {

        console.error(
          "Supabase invite error:",
          inviteError
        );

        return res.status(500).json({
          error: inviteError.message,
        });
      }

      console.log("Usuário liberado:", email);
    }

    return res.status(200).json({
      received: true,
    });

  } catch (err) {

    console.error("Webhook processing error:", err);

    return res.status(500).json({
      error: err.message,
    });
  }
}