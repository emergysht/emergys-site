import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método não permitido"
    });
  }

  try {

    const { email, tipo } = req.body;

    if (!email) {
      return res.status(400).json({
        error: "E-mail obrigatório"
      });
    }

    /*
      tipo:
      - invite
      - recovery
    */

    if (tipo === "invite") {

      const { error } =
        await supabase.auth.admin.inviteUserByEmail(
          email,
          {
            redirectTo:
              "https://www.emergys.com.br/login.html"
          }
        );

      if (error) {

        console.error("Erro invite:", error);

        return res.status(500).json({
          error: error.message
        });
      }

      return res.status(200).json({
        success: true
      });
    }

    if (tipo === "recovery") {

      const { error } =
        await supabase.auth.resetPasswordForEmail(
          email,
          {
            redirectTo:
              "https://www.emergys.com.br/login.html"
          }
        );

      if (error) {

        console.error("Erro recovery:", error);

        return res.status(500).json({
          error: error.message
        });
      }

      return res.status(200).json({
        success: true
      });
    }

    return res.status(400).json({
      error: "Tipo inválido"
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message
    });
  }
}