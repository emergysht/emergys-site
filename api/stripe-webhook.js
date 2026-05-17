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

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const sig = req.headers["stripe-signature"];
  const rawBody = await getRawBody(req);

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const email =
        session.customer_details?.email ||
        session.customer_email;

      if (!email) {
        return res.status(400).json({ error: "E-mail não encontrado na sessão." });
      }

      const plan = session.metadata?.plan || "mensal";
      const durationDays = Number(session.metadata?.duration_days || 30);

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + durationDays);

      // 1. Salva assinatura
      const { error: subError } = await supabase
        .from("subscriptions")
        .upsert(
          {
            email,
            plan,
            status: "active",
            expires_at: expiresAt.toISOString(),
            stripe_customer_id: session.customer,
            stripe_session_id: session.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "email" }
        );

      if (subError) {
        console.error("Supabase subscription error:", subError);
        return res.status(500).json({ error: subError.message });
      }

      // 2. Cria convite para o usuário definir senha
      const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(
        email,
        {
          redirectTo: "https://www.emergys.com.br/login.html",
        }
      );

      if (inviteError && !inviteError.message.includes("already registered")) {
        console.error("Supabase invite error:", inviteError);
        return res.status(500).json({ error: inviteError.message });
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("General webhook error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}