import type { Account } from "@twinly/shared";
import { PLAN_LIMIT_CENTS } from "./config";
import type { Db, UserRow } from "./db";

/** Allowances reset on the first of each calendar month, UTC. */
export function periodStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function remainingCents(db: Db, user: UserRow): number {
  return PLAN_LIMIT_CENTS[user.plan] - db.usageCents(user.id, periodStart(), true);
}

export function accountView(db: Db, user: UserRow, billingEnabled: boolean): Account {
  return {
    email: user.email,
    emailVerified: user.email_verified === 1,
    plan: user.plan,
    usageCents: db.usageCents(user.id, periodStart()),
    limitCents: PLAN_LIMIT_CENTS[user.plan],
    billingEnabled,
  };
}
