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
    expiresAt.setDate(expiresAt.getDate() + 180);
    return expiresAt;
  }

  if (plan === "anual") {
    expiresAt.setDate(expiresAt.getDate() + 365);
    return expiresAt;
  }

  expiresAt.setDate(expiresAt.getDate() + 30);
  return expiresAt;
}

async function buscarUsuarioPorEmail(email) {
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });

  if (error) throw error;

  return data.users.find(
    (user) => user.email?.toLowerCase() === email.toLowerCase()
  );
}

async function ativarAcesso({ email, plan, expiresAt, customerId, subscriptionId, sessionId }) {
  const { error: subscriptionError } = await supabase
    .from("subscriptions")
    .upsert(
      {
        email,
        plan,
        status: "active",
        expires_at: expiresAt.toISOString(),
        stripe_customer_id: customerId || null,
        stripe_subscription_id: subscriptionId || null,
        stripe_session_id: sessionId || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email" }
    );

  if (subscriptionError) {
    throw subscriptionError;
  }

  let userId = null;

  const { data: inviteData, error: inviteError } =
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
      const existingUser = await buscarUsuarioPorEmail(email);
      userId = existingUser?.id || null;
    } else {
      throw inviteError;
    }
  } else {
    userId = inviteData?.user?.id || null;
  }

  if (!userId) {
    const existingUser = await buscarUsuarioPorEmail(email);
    userId = existingUser?.id || null;
  }

  if (!userId) {
    throw new Error("Usuário criado/encontrado, mas ID não localizado no Supabase Auth.");
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
      },
      { onConflict: "id" }
    );

  if (profileError) {
    throw profileError;
  }
}

async function bloquearPorSubscription(subscriptionId, motivo = "inactive") {
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

  const { data: subscriptionRow, error: findError } = await supabase
    .from("subscriptions")
    .select("email, plan")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (findError) {
    throw findError;
  }

  if (!subscriptionRow?.email) return;

  const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);

  let expiresAt = null;

  if (stripeSubscription?.current_period_end) {
    expiresAt = new Date(stripeSubscription.current_period_end * 1000);
  } else {
    expiresAt = calcularValidade(subscriptionRow.plan || "mensal", null);
  }

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
      : calcularValidade(subscriptionRow.plan || "mensal", null);

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
      })
      .eq("email", subscriptionRow.email);

    if (profileError) {
      throw profileError;
    }
  }

  if (
    statusStripe === "past_due" ||
    statusStripe === "incomplete"
  ) {
    await bloquearPorSubscription(subscriptionId, statusStripe);
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
      const session = event.data.object;

      const email =
        session.customer_details?.email ||
        session.customer_email;

      if (!email) {
        return res.status(400).json({
          error: "E-mail não encontrado na sessão Stripe.",
        });
      }

      const plan = session.metadata?.plan || "mensal";
      const durationDays = session.metadata?.duration_days || null;
      const expiresAt = calcularValidade(plan, durationDays);

      await ativarAcesso({
        email,
        plan,
        expiresAt,
        customerId: session.customer || null,
        subscriptionId: session.subscription || null,
        sessionId: session.id,
      });

      console.log("Acesso ativado via checkout:", email);
    }

    if (event.type === "invoice.paid") {
      await renovarPorInvoice(event.data.object);
      console.log("Assinatura renovada por invoice.paid");
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      await bloquearPorSubscription(invoice.subscription, "payment_failed");
      console.log("Acesso bloqueado por falha de pagamento");
    }

    if (event.type === "invoice.payment_action_required") {
      const invoice = event.data.object;
      await bloquearPorSubscription(invoice.subscription, "payment_action_required");
      console.log("Acesso bloqueado por ação de pagamento pendente");
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      await bloquearPorSubscription(subscription.id, "canceled");
      console.log("Acesso bloqueado por assinatura cancelada");
    }

    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      await atualizarStatusSubscription(subscription);
      console.log("Status de assinatura atualizado");
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