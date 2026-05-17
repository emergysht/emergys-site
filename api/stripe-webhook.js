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

function calcularValidade(plan, durationDays) {
  const expiresAt = new Date();

  if (durationDays) {
    expiresAt.setDate(expiresAt.getDate() + Number(durationDays));
    return expiresAt;
  }

  if (plan === "semestral") {
    expiresAt.setMonth(expiresAt.getMonth() + 6);
    return expiresAt;
  }

  if (plan === "anual") {
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    return expiresAt;
  }

  expiresAt.setMonth(expiresAt.getMonth() + 1);
  return expiresAt;
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
        return res.status(400).json({
          error: "E-mail não encontrado na sessão Stripe.",
        });
      }

      const customerId = session.customer || null;
      const subscriptionId = session.subscription || null;

      const plan = session.metadata?.plan || "mensal";
      const durationDays = session.metadata?.duration_days || null;

      const expiresAt = calcularValidade(plan, durationDays);

      const { error: subscriptionError } = await supabase
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

      if (subscriptionError) {
        console.error("Erro ao salvar subscription:", subscriptionError);
        return res.status(500).json({
          error: subscriptionError.message,
        });
      }

      const { error: profileError } = await supabase
        .from("profiles")
        .upsert(
          {
            email,
            ativo: true,
            plano: plan,
            validade: expiresAt.toISOString().slice(0, 10),
          },
          {
            onConflict: "email",
          }
        );

      if (profileError) {
        console.error("Erro ao salvar profile:", profileError);
        return res.status(500).json({
          error: profileError.message,
        });
      }

      const { error: inviteError } =
        await supabase.auth.admin.inviteUserByEmail(email, {
          redirectTo: "https://www.emergys.com.br/login.html",
        });

      if (inviteError) {
        const msg = inviteError.message || "";

        if (
          msg.includes("already registered") ||
          msg.includes("User already registered") ||
          msg.includes("already been registered")
        ) {
          console.log("Usuário já existia. Assinatura atualizada:", email);
        } else {
          console.error("Erro ao enviar convite Supabase:", inviteError);
          return res.status(500).json({
            error: inviteError.message,
          });
        }
      }

      console.log("Assinatura liberada e convite processado:", email);
    }

    return res.status(200).json({
      received: true,
    });

  } catch (err) {
    console.error("Erro geral no webhook:", err);

    return res.status(500).json({
      error: err.message,
    });
  }
}