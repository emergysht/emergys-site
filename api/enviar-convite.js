import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const REDIRECT_NOVA_SENHA = "https://www.emergys.com.br/nova-senha.html";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido",
    });
  }

  try {
    const { email, tipo } = req.body;

    if (!email) {
      return res.status(400).json({
        error: "E-mail obrigatório.",
      });
    }

    if (tipo === "invite") {
      const { error } = await supabase.auth.admin.inviteUserByEmail(email, {
        redirectTo: REDIRECT_NOVA_SENHA,
      });

      if (error) {
        console.error("Erro invite:", error);
        return res.status(500).json({
          error: error.message,
        });
      }

      return res.status(200).json({
        success: true,
        message: "Convite enviado com sucesso.",
      });
    }

    if (tipo === "recovery") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: REDIRECT_NOVA_SENHA,
      });

      if (error) {
        console.error("Erro recovery:", error);
        return res.status(500).json({
          error: error.message,
        });
      }

      return res.status(200).json({
        success: true,
        message: "E-mail de recuperação enviado com sucesso.",
      });
    }

    return res.status(400).json({
      error: "Tipo inválido. Use invite ou recovery.",
    });

  } catch (err) {
    console.error("Erro geral enviar-convite:", err);

    return res.status(500).json({
      error: err.message,
    });
  }
}