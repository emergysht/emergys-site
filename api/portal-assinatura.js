import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "Usuário não autenticado." });
    }

    const token = authHeader.replace("Bearer ", "");

    const { data: userData, error: userError } =
      await supabase.auth.getUser(token);

    if (userError || !userData?.user?.email) {
      return res.status(401).json({ error: "Sessão inválida." });
    }

    const email = userData.user.email;

    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("email", email)
      .maybeSingle();

    if (subError) {
      return res.status(500).json({ error: subError.message });
    }

    if (!subscription?.stripe_customer_id) {
      return res.status(404).json({
        error: "Cliente Stripe não encontrado para este usuário.",
      });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: subscription.stripe_customer_id,
      configuration: "bpc_1TYFR0IWNPouDhuIFpikvSgH",
      return_url: "https://www.emergys.com.br/app/",
    });

    return res.status(200).json({
      url: portalSession.url,
    });

  } catch (err) {
    console.error("Erro ao criar portal:", err);

    return res.status(500).json({
      error: err.message,
    });
  }
}
