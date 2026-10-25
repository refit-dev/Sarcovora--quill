import { db } from '@/db';
import { stripe } from '@/lib/stripe';
import { headers } from 'next/headers';
import type Stripe from 'stripe';

type PeriodItem = { price?: { id?: string } | null };
type PeriodField = 'current_period_start' | 'current_period_end';
type PlanItem = (items: PeriodItem[]) => PeriodItem | undefined;

// Typed like the removed field, which was also absent at runtime when Stripe omitted it.
function subscriptionPeriod(subscription: object, field: PeriodField, planItem?: PlanItem): number {
  const legacy: unknown = Reflect.get(subscription, field);
  if (typeof legacy === 'number') return legacy;
  const list: unknown = Reflect.get(subscription, 'items');
  const data: unknown = list && typeof list === 'object' ? Reflect.get(list, 'data') : undefined;
  const items = (Array.isArray(data) ? data : []).filter(
    (item): item is PeriodItem => typeof item === 'object' && item !== null,
  );
  const periods = new Set(items.map((item) => Reflect.get(item, field)));
  const chosen = periods.size === 1 ? items[0] : planItem?.(items);
  const value: unknown = chosen ? Reflect.get(chosen, field) : undefined;
  return (typeof value === 'number' ? value : undefined) as number;
}

function getSubscriptionPeriodEnd(subscription: object, planItem?: PlanItem): number {
  return subscriptionPeriod(subscription, 'current_period_end', planItem);
}

// Typed like the removed field under old stripe types, like the new location under new ones.
type InvoiceSubscription<T> = T extends { subscription: infer S }
  ? S
  : T extends { parent: infer P }
    ? NonNullable<P> extends { subscription_details: infer D }
      ? NonNullable<D> extends { subscription: infer S }
        ? S | null
        : string | null
      : string | null
    : string | null;

// The old top-level field when present (old-version payloads), otherwise the new location.
function getInvoiceSubscription<T extends object>(invoice: T): InvoiceSubscription<T> {
  const legacy: unknown = Reflect.get(invoice, 'subscription');
  const parent: unknown = Reflect.get(invoice, 'parent');
  const details: unknown =
    parent && typeof parent === 'object' ? Reflect.get(parent, 'subscription_details') : undefined;
  const moved: unknown =
    details && typeof details === 'object' ? Reflect.get(details, 'subscription') : undefined;
  return (legacy !== undefined ? legacy : (moved ?? null)) as InvoiceSubscription<T>;
}

export async function POST(request: Request) {
  const body = await request.text();
  const signature = headers().get('Stripe-Signature') ?? '';

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET || '',
    );
    console.log('In webhooks/stripe/route.ts & currently in try statement');
  } catch (err) {
    console.log('In webhooks/stripe/route.ts & currently in catch: ' + err);
    return new Response(
      `Webhook Error: ${err instanceof Error ? err.message : 'Unknown Error'}`,
      { status: 400 },
    );
  }

  const session = event.data.object as Stripe.Checkout.Session;

  if (!session?.metadata?.userId) {
    console.log('currently error 200 error');
    return new Response(null, {
      status: 200,
    });
  }

  if (event.type === 'checkout.session.completed') {
    console.log('chekcout complete');
    const subscription = await stripe.subscriptions.retrieve(
      session.subscription as string,
    );

    await db.user.update({
      where: {
        id: session.metadata.userId,
      },
      data: {
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer as string,
        stripePriceId: subscription.items.data[0]?.price.id,
        stripeCurrentPeriodEnd: new Date(
          (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000,
        ),
      },
    });
    console.log('finisehd uploading data');
  }

  if (event.type === 'invoice.payment_succeeded') {
    console.log('invoice payment succeeded');
    // Retrieve the subscription details from Stripe.
    const subscription = await stripe.subscriptions.retrieve(
      (getInvoiceSubscription(session)) as string,
    );
    console.log('retrieved subscription');

    await db.user.update({
      where: {
        stripeSubscriptionId: subscription.id,
      },
      data: {
        stripePriceId: subscription.items.data[0]?.price.id,
        stripeCurrentPeriodEnd: new Date(
          (getSubscriptionPeriodEnd(subscription, (items) => items[0])) * 1000,
        ),
      },
    });
    console.log('updated db')
  }

  return new Response(null, { status: 200 });
}

// import { db } from '@/db';
// import { stripe } from '@/lib/stripe';
// import { headers } from 'next/headers';
// import type Stripe from 'stripe';

// export async function POST(request: Request) {
//   const body = await request.text();
//   const signature = headers().get('Stripe-Signature') ?? '';

//   let event: Stripe.Event;

//   try {
//     event = stripe.webhooks.constructEvent(
//       body,
//       signature,
//       process.env.STRIPE_WEBHOOK_SECRET || '',
//     );
//     console.log("In webhooks/stripe/route.ts & currently in try statement")
//   } catch (err) {
//     console.log("In webhooks/stripe/route.ts & currently in catch: " + err)
//     return new Response(
//       `Webhook Error: ${err instanceof Error ? err.message : 'Unknown Error'}`,
//       { status: 400 },
//     );
//   }

//   const session = event.data.object as Stripe.Checkout.Session;

//   if (!session?.metadata?.userId) {
//     return new Response(null, {
//       status: 200,
//     });
//   }

//   if (event.type === 'checkout.session.completed') {
//     console.log("Checkout section completed!")
//     const subscription = await stripe.subscriptions.retrieve(
//       session.subscription as string,
//     );

//     await db.user.update({
//       where: {
//         id: session.metadata.userId,
//       },
//       data: {
//         stripeSubscriptionId: subscription.id,
//         stripeCustomerId: subscription.customer as string,
//         stripePriceId: subscription.items.data[0]?.price.id,
//         stripeCurrentPeriodEnd: new Date(
//           subscription.current_period_end * 1000,
//         ),
//       },
//     });

//     console.log ("should have just updated the db")
//   }

//   if (event.type === 'invoice.payment_succeeded') {
//     // Retrieve the subscription details from Stripe.
//     const subscription = await stripe.subscriptions.retrieve(
//       session.subscription as string,
//     );

//     await db.user.update({
//       where: {
//         stripeSubscriptionId: subscription.id,
//       },
//       data: {
//         stripePriceId: subscription.items.data[0]?.price.id,
//         stripeCurrentPeriodEnd: new Date(
//           subscription.current_period_end * 1000,
//         ),
//       },
//     });
//   }

//   return new Response(null, { status: 200 });
// }
