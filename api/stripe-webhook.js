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

const REDIRECT_NOVA_SENHA = "https://www.emergys.com.br/nova-senha.html";

async function getRawBody(readable) {
  const chunks = [];

  for await (const chunk of readable) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

function calcularValidade(plan) {
  const expiresAt = new Date();

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

async function buscarUsuarioPorEmail(email) {
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw error;

  return data.users.find(
    user => user.email?.toLowerCase() === email.toLowerCase()
  );
}

async function ativarAcesso(session) {
  const email =
    session.customer_details?.email ||
    session.customer_email;

  if (!email) {
    throw new Error("E-mail não encontrado na sessão Stripe.");
  }

  const customerId = session.customer || null;
  const subscriptionId = session.subscription || null;

  let subscription = null;
  let priceId = null;

  if (subscriptionId) {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
    priceId = subscription?.items?.data?.[0]?.price?.id || null;
  }

  let plan = session.metadata?.plan || "mensal";

  if (priceId === process.env.STRIPE_PRICE_SEMESTRAL) {
    plan = "semestral";
  }

  if (priceId === process.env.STRIPE_PRICE_ANUAL) {
    plan = "anual";
  }

  const expiresAt = subscription?.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : calcularValidade(plan);

  const { error: subError } = await supabase
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

  if (subError) {
    throw subError;
  }

  let userId = null;

  const existingUser = await buscarUsuarioPorEmail(email);

  if (existingUser) {
    userId = existingUser.id;
  } else {
    const { data: inviteData, error: inviteError } =
      await supabase.auth.admin.inviteUserByEmail(email, {
        redirectTo: REDIRECT_NOVA_SENHA,
      });

    if (inviteError) {
      throw inviteError;
    }

    userId = inviteData?.user?.id || null;
  }

  if (!userId) {
    throw new Error("Não foi possível localizar ou criar o usuário no Supabase Auth.");
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .upsert(
      {
        id: userId,
        email,
        ativo: true,
        plano: plan,
        validade: expiresAt.toISOString().slice(0, 10),
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        status_assinatura: "active",
      },
      {
        onConflict: "id",
      }
    );

  if (profileError) {
    throw profileError;
  }

  console.log("Acesso ativado:", email);
}

async function bloquearPorSubscription(subscriptionId, motivo) {
  if (!subscriptionId) return;

  const { data: subscriptionRow, error: findError } = await supabase
    .from("subscriptions")
    .select("email")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (findError) {
    throw findError;
  }

  const email = subscriptionRow?.email;

  const { error: subError } = await supabase
    .from("subscriptions")
    .update({
      status: motivo,
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscriptionId);

  if (subError) {
    throw subError;
  }

  if (email) {
    const { error: profileError } = await supabase
      .from("profiles")
      .update({
        ativo: false,
        status_assinatura: motivo,
      })
      .eq("email", email);

    if (profileError) {
      throw profileError;
    }
  }
}

async function renovarPorInvoice(invoice) {
  const subscriptionId = invoice.subscription;

  if (!subscriptionId) return;

  const stripeSubscription =
    await stripe.subscriptions.retrieve(subscriptionId);

  const { data: subscriptionRow, error: findError } = await supabase
    .from("subscriptions")
    .select("email, plan")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (findError) {
    throw findError;
  }

  if (!subscriptionRow?.email) return;

  const expiresAt = stripeSubscription?.current_period_end
    ? new Date(stripeSubscription.current_period_end * 1000)
    : calcularValidade(subscriptionRow.plan || "mensal");

  const { error: subError } = await supabase
    .from("subscriptions")
    .update({
      status: "active",
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", subscriptionId);

  if (subError) {
    throw subError;
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .update({
      ativo: true,
      validade: expiresAt.toISOString().slice(0, 10),
      status_assinatura: "active",
    })
    .eq("email", subscriptionRow.email);

  if (profileError) {
    throw profileError;
  }
}

async function atualizarStatusSubscription(subscription) {
  const subscriptionId = subscription.id;
  const statusStripe = subscription.status;

  if (!subscriptionId) return;

  if (
    statusStripe === "canceled" ||
    statusStripe === "unpaid" ||
    statusStripe === "incomplete_expired"
  ) {
    await bloquearPorSubscription(subscriptionId, statusStripe);
    return;
  }

  if (
    statusStripe === "past_due" ||
    statusStripe === "incomplete"
  ) {
    await bloquearPorSubscription(subscriptionId, statusStripe);
    return;
  }

  if (
    statusStripe === "active" ||
    statusStripe === "trialing"
  ) {
    const { data: subscriptionRow, error: findError } = await supabase
      .from("subscriptions")
      .select("email, plan")
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();

    if (findError) {
      throw findError;
    }

    if (!subscriptionRow?.email) return;

    const expiresAt = subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000)
      : calcularValidade(subscriptionRow.plan || "mensal");

    const { error: subError } = await supabase
      .from("subscriptions")
      .update({
        status: "active",
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", subscriptionId);

    if (subError) {
      throw subError;
    }

    const { error: profileError } = await supabase
      .from("profiles")
      .update({
        ativo: true,
        validade: expiresAt.toISOString().slice(0, 10),
        status_assinatura: "active",
      })
      .eq("email", subscriptionRow.email);

    if (profileError) {
      throw profileError;
    }
  }
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
      await ativarAcesso(event.data.object);
    }

    if (event.type === "invoice.paid") {
      await renovarPorInvoice(event.data.object);
    }

    if (event.type === "invoice.payment_failed") {
      await bloquearPorSubscription(
        event.data.object.subscription,
        "payment_failed"
      );
    }

    if (event.type === "invoice.payment_action_required") {
      await bloquearPorSubscription(
        event.data.object.subscription,
        "payment_action_required"
      );
    }

    if (event.type === "customer.subscription.deleted") {
      await bloquearPorSubscription(
        event.data.object.id,
        "canceled"
      );
    }

    if (event.type === "customer.subscription.updated") {
      await atualizarStatusSubscription(event.data.object);
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