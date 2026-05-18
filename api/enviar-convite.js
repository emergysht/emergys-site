import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "E-mail obrigatório." });
    }

    const { error } = await supabase.auth.admin.generateLink({
      type: "recovery",
      email,
      options: {
        redirectTo: "https://www.emergys.com.br/login.html",
      },
    });

    if (error) {
      console.error("Erro ao gerar link:", error);
      return res.status(400).json({ error: error.message });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("Erro geral:", err);
    return res.status(500).json({ error: err.message });
  }
}
