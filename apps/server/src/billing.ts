import Stripe from "stripe";
import type { Config } from "./config";
import type { Db, UserRow } from "./db";

// Stripe subscriptions: Checkout to upgrade, the Customer Portal to manage or
// cancel, and webhooks as the only thing that changes a user's plan.
export class Billing {
  private readonly stripe: Stripe;

  constructor(
    private readonly config: NonNullable<Config["stripe"]> & { publicUrl: string },
    private readonly db: Db,
    stripe?: Stripe,
  ) {
    this.stripe = stripe ?? new Stripe(config.secretKey);
  }

  async checkoutUrl(user: UserRow): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: this.config.proPriceId, quantity: 1 }],
      client_reference_id: user.id,
      ...(user.stripe_customer_id ? { customer: user.stripe_customer_id } : { customer_email: user.email }),
      success_url: `${this.config.publicUrl}/billing/done`,
      cancel_url: `${this.config.publicUrl}/billing/done`,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return session.url;
  }

  async portalUrl(user: UserRow): Promise<string | null> {
    if (!user.stripe_customer_id) return null;
    const session = await this.stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${this.config.publicUrl}/billing/done`,
    });
    return session.url;
  }

  /** Verifies the signature and applies the event. Throws on a bad signature. */
  async handleWebhook(rawBody: Buffer, signature: string) {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.config.webhookSecret);
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.client_reference_id;
        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
        if (userId && customerId && this.db.userById(userId)) {
          this.db.updateUser(userId, { stripe_customer_id: customerId, plan: "pro" });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
        const user = this.db.userByStripeCustomer(customerId);
        if (!user) break;
        const active = event.type !== "customer.subscription.deleted" && ["active", "trialing", "past_due"].includes(subscription.status);
        this.db.updateUser(user.id, { plan: active ? "pro" : "free" });
        break;
      }
    }
  }

  /** Cancels any subscription immediately (account deletion). */
  async cancelAll(user: UserRow) {
    if (!user.stripe_customer_id) return;
    for await (const subscription of this.stripe.subscriptions.list({ customer: user.stripe_customer_id, status: "active" })) {
      await this.stripe.subscriptions.cancel(subscription.id);
    }
  }
}
