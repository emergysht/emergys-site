import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(readable) {
  const chunks = [];

  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const rawBody = await getRawBody(req);

  const signature = req.headers['stripe-signature'];

  let event;

  try {

    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

  } catch (err) {

    console.error('Webhook signature error:', err.message);

    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {

    switch (event.type) {

      case 'checkout.session.completed': {

        const session = event.data.object;

        const customerEmail = session.customer_details?.email;

        if (customerEmail) {

          await supabase
            .from('profiles')
            .update({
              active: true,
              subscription_status: 'active',
            })
            .eq('email', customerEmail);

          console.log('Usuário ativado:', customerEmail);
        }

        break;
      }

      case 'invoice.payment_failed': {

        const invoice = event.data.object;

        const customerEmail = invoice.customer_email;

        if (customerEmail) {

          await supabase
            .from('profiles')
            .update({
              active: false,
              subscription_status: 'payment_failed',
            })
            .eq('email', customerEmail);

          console.log('Pagamento falhou:', customerEmail);
        }

        break;
      }

      case 'customer.subscription.deleted': {

        const subscription = event.data.object;

        const customerId = subscription.customer;

        const { data: profiles } = await supabase
          .from('profiles')
          .select('*')
          .eq('stripe_customer_id', customerId);

        if (profiles?.length > 0) {

          await supabase
            .from('profiles')
            .update({
              active: false,
              subscription_status: 'cancelled',
            })
            .eq('stripe_customer_id', customerId);

          console.log('Assinatura cancelada:', customerId);
        }

        break;
      }

      case 'charge.refunded': {

        const charge = event.data.object;

        const customerId = charge.customer;

        await supabase
          .from('profiles')
          .update({
            active: false,
            subscription_status: 'refunded',
          })
          .eq('stripe_customer_id', customerId);

        console.log('Reembolso realizado:', customerId);

        break;
      }

      default:
        console.log(`Evento ignorado: ${event.type}`);
    }

    return res.status(200).json({
      received: true,
    });

  } catch (error) {

    console.error(error);

    return res.status(500).send('Internal Server Error');
  }
}
