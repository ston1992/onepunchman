import type { Plan } from "@twinly/shared";

export interface Config {
  port: number;
  publicUrl: string;
  databasePath: string;
  jwtSecret: string;
  agentId: string;
  environmentId: string;
  /** Hard cap on any single task, in US cents. */
  taskBudgetCents: number;
  stripe?: { secretKey: string; webhookSecret: string; proPriceId: string };
  resend?: { apiKey: string; from: string };
}

/** Monthly list-price spend each plan includes, in US cents. */
export const PLAN_LIMIT_CENTS: Record<Plan, number> = { free: 200, pro: 2500 };

/** Below this much remaining allowance a new task is refused rather than started to die at once. */
export const MIN_TASK_BUDGET_CENTS = 25;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see apps/server/.env.example)`);
  return value;
}

export function loadConfig(): Config {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const jwtSecret = required("JWT_SECRET");
  if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  return {
    port: Number(process.env.PORT || 8787),
    publicUrl: process.env.PUBLIC_URL || "http://localhost:8787",
    databasePath: process.env.DATABASE_PATH || "twinly.db",
    jwtSecret,
    agentId: required("TWIN_AGENT_ID"),
    environmentId: required("TWIN_ENVIRONMENT_ID"),
    taskBudgetCents: Number(process.env.TWIN_TASK_BUDGET_CENTS || 500),
    resend: process.env.RESEND_API_KEY
      ? { apiKey: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM || "Twinly <hello@twinly.app>" }
      : undefined,
    stripe: stripeKey
      ? {
          secretKey: stripeKey,
          webhookSecret: required("STRIPE_WEBHOOK_SECRET"),
          proPriceId: required("STRIPE_PRICE_PRO"),
        }
      : undefined,
  };
}
