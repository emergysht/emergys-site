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
    chunks.push(typeof chunk === "string"
      ? Buffer.from(chunk)
      : chunk);
  }

  return Buffer.concat(chunks);
}

async function ativarAcesso(session) {

  const email =
    session.customer_details?.email ||
    session.customer_email;

  if (!email) {
    throw new Error("Email não encontrado.");
  }

  const customerId = session.customer;
  const subscriptionId = session.subscription;

  let subscription = null;

  if (subscriptionId) {
    subscription = await stripe.subscriptions.retrieve(
      subscriptionId
    );
  }

  const priceId =
    subscription?.items?.data?.[0]?.price?.id || null;

  let plan = "mensal";

  if (priceId === "price_SEMESTRAL_ID") {
    plan = "semestral";
  }

  if (priceId === "price_ANUAL_ID") {
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

  const { error: subError } = await supabase
    .from("subscriptions")
    .upsert(
      {
        email,
        plan,
        status: "active",
        expires_at: expiresAt.toISOString(),
        stripe_customer_id: customerId || null,
        stripe_subscription_id: subscriptionId || null,
        stripe_session_id: session.id,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "email",
      }
    );

  if (subError) {
    console.error("Erro subscriptions:", subError);
    throw new Error(subError.message);
  }

  const { data: existingUser } =
    await supabase.auth.admin.listUsers();

  let userId = null;

  const found = existingUser.users.find(
    (u) => u.email === email
  );

  if (found) {
    userId = found.id;
  } else {

    const { data: inviteData, error: inviteError } =
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
      console.error("Erro invite:", inviteError);
      throw new Error(inviteError.message);
    }

    userId = inviteData?.user?.id || null;
  }

  if (!userId) {
    throw new Error("Não foi possível obter user ID.");
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

        stripe_customer_id: customerId || null,
        stripe_subscription_id: subscriptionId || null,
        status_assinatura: "active"

      },
      {
        onConflict: "id",
      }
    );

  if (profileError) {
    console.error("Erro profiles:", profileError);
    throw new Error(profileError.message);
  }

  console.log("Acesso liberado:", email);
}

async function bloquearAcesso(email, motivo = "cancelado") {

  const { error } = await supabase
    .from("profiles")
    .update({
      ativo: false,
      status_assinatura: motivo
    })
    .eq("email", email);

  if (error) {
    console.error("Erro bloqueando acesso:", error);
  }
}

async function renovarAssinatura(subscription) {

  const customerId = subscription.customer;

  const { data: subscriptionRow } =
    await supabase
      .from("subscriptions")
      .select("*")
      .eq("stripe_customer_id", customerId)
      .single();

  if (!subscriptionRow) return;

  let expiresAt = new Date(
    subscription.current_period_end * 1000
  );

  const { error } = await supabase
    .from("profiles")
    .update({
      ativo: true,
      validade: expiresAt.toISOString().slice(0, 10),
      status_assinatura: "active"
    })
    .eq("email", subscriptionRow.email);

  if (error) {
    console.error("Erro renovando:", error);
  }
}

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  let event;

  try {

    const rawBody = await getRawBody(req);

    const signature =
      req.headers["stripe-signature"];

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

  } catch (err) {

    console.error("Webhook Error:", err.message);

    return res.status(400).send(
      `Webhook Error: ${err.message}`
    );
  }

  try {

    switch (event.type) {

      case "checkout.session.completed": {

        const session = event.data.object;

        await ativarAcesso(session);

        break;
      }

      case "invoice.paid": {

        const invoice = event.data.object;

        if (invoice.subscription) {

          const subscription =
            await stripe.subscriptions.retrieve(
              invoice.subscription
            );

          await renovarAssinatura(subscription);
        }

        break;
      }

      case "customer.subscription.deleted": {

        const subscription = event.data.object;

        const customerId = subscription.customer;

        const { data } = await supabase
          .from("subscriptions")
          .select("*")
          .eq("stripe_customer_id", customerId)
          .single();

        if (data?.email) {
          await bloquearAcesso(
            data.email,
            "cancelado"
          );
        }

        break;
      }

      case "invoice.payment_failed": {

        const invoice = event.data.object;

        const customerId = invoice.customer;

        const { data } = await supabase
          .from("subscriptions")
          .select("*")
          .eq("stripe_customer_id", customerId)
          .single();

        if (data?.email) {
          await bloquearAcesso(
            data.email,
            "pagamento_falhou"
          );
        }

        break;
      }

      default:
        console.log(
          `Evento ignorado: ${event.type}`
        );
    }

    return res.status(200).json({
      received: true,
    });

  } catch (err) {

    console.error(
      "Webhook processing error:",
      err
    );

    return res.status(500).json({
      error: err.message,
    });
  }
}