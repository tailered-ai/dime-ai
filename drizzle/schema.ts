import {
  bigint,
  boolean,
  decimal,
  double,
  index,
  int,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  smallint,
  text,
  timestamp,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Legacy OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── App Users (custom accounts managed by owner) ────────────────────────────

export const appUsers = mysqlTable("app_users", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  username: varchar("username", { length: 64 }).notNull().unique(),
  passwordHash: varchar("passwordHash", { length: 255 }).notNull(),
  role: mysqlEnum("role", ["owner", "admin", "handicapper", "user"]).default("user").notNull(),
  /**
   * Master access switch. DEFAULT FALSE (flipped 2026-08-01): both live insert
   * paths (owner createUser, post-payment webhook) set this explicitly, so the
   * default only ever applies to a FUTURE insert path someone forgets to wire —
   * and a forgotten path must fail closed (no access until granted), not open.
   * The old default('1') was vestigial from the invite-only era and made any
   * bare INSERT a silent lifetime grant (expiryDate NULL = lifetime).
   */
  hasAccess: boolean("hasAccess").default(false).notNull(),
  /** NULL means lifetime access; otherwise a UTC timestamp in ms */
  expiryDate: bigint("expiryDate", { mode: "number" }),
  /**
   * Soft delete. NULL = live account; a timestamp = retired.
   *
   * `app_users` has no foreign keys pointing at it (all 56 FKs in this schema
   * are in the World Cup tables) and `deleteAppUser` was a bare DELETE, so
   * removing an account stranded everything it owned. That is not theoretical:
   * account 60002 left 278 verified bets, a login session and an owner-reviewed
   * edit request behind, invisible in the picker for months while still
   * counting toward global totals.
   *
   * Retiring an account is now a flag, so history stays attributed and the
   * operation is reversible. EVERY account-resolution path must exclude
   * soft-deleted rows or this column is decorative — see getAppUserById,
   * lookupAppUserByIdFresh, getAppUserByEmail, getAppUserByUsername.
   */
  deletedAt: bigint("deletedAt", { mode: "number" }),
  /** Whether the user has accepted the Age & Responsibility notice */
  termsAccepted: boolean("termsAccepted").default(false).notNull(),
  /** UTC timestamp (ms) when the user accepted the terms; NULL if not yet accepted */
  termsAcceptedAt: bigint("termsAcceptedAt", { mode: "number" }),
  /**
   * Session invalidation version. Incremented on force-logout.
   * JWT payload must carry a matching `tv` claim — mismatches are rejected immediately.
   * forceLogout(userId): increment this user's tokenVersion
   * forceLogoutAll(): increment ALL users' tokenVersion in one SQL UPDATE
   */
  tokenVersion: int("tokenVersion").default(1).notNull(),
  // ─── Discord account linking ────────────────────────────────────────────────
  /** Discord user ID (snowflake string), NULL = not linked */
  discordId: varchar("discordId", { length: 32 }),
  /** Discord username, e.g. "prezb3ts" */
  discordUsername: varchar("discordUsername", { length: 64 }),
  /** Discord avatar hash for CDN URL construction */
  discordAvatar: varchar("discordAvatar", { length: 128 }),
  /** UTC timestamp (ms) when the Discord account was linked */
  discordConnectedAt: bigint("discordConnectedAt", { mode: "number" }),
  /** Manual Discord ID pre-registered by owner. On first Discord login, promoted to discordId and cleared. */
  manualDiscordId: varchar("manualDiscordId", { length: 32 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn"),
  /**
   * Password reset token (SHA-256 hex of a random 32-byte secret).
   * NULL when no reset is pending. Cleared on successful reset or expiry.
   */
  passwordResetToken: varchar("passwordResetToken", { length: 64 }),
  /**
   * UTC timestamp (ms) when the password reset token expires.
   * Tokens are valid for 30 minutes from issuance.
   */
  passwordResetExpiresAt: bigint("passwordResetExpiresAt", { mode: "number" }),
  // ─── Per-account login lockout (credential-stuffing defense) ────────────────
  // DB-backed so failures against THIS account are counted no matter which IP
  // they come from (a botnet defeats the per-IP loginRateMap). See
  // server/accountLockout.ts for the pure decision logic. Expand-only, safe
  // defaults — old code that never touches these columns is unaffected.
  //
  // ⚠️ DEPLOY-ORDER LAW: Drizzle emits an explicit column list, so the moment
  // code carrying THIS schema deploys, every app_users SELECT names these
  // columns. If the DB hasn't had migration 0133 applied yet, MySQL 1054 →
  // auth resolvers swallow it → SITE-WIDE silent auth failure. Always run
  // db-push.yml (migration 0133) BEFORE deploying code that includes these
  // columns. The ACCOUNT_LOCKOUT_DISABLED kill-switch does NOT cover this.
  /** Failed login attempts in the current rolling window. */
  failedLoginCount: int("failedLoginCount").default(0).notNull(),
  /** ms timestamp of the first failure in the current window (window anchor). */
  firstFailedLoginAt: bigint("firstFailedLoginAt", { mode: "number" }),
  /** ms timestamp until which the account is locked; NULL = not locked. */
  lockedUntil: bigint("lockedUntil", { mode: "number" }),
  // ─── Stripe subscription ────────────────────────────────────────────────────
  /**
   * Stripe Customer ID (cus_xxx). Set on first successful checkout.
   * Used to look up payment history and manage subscriptions via Stripe API.
   */
  stripeCustomerId: varchar("stripeCustomerId", { length: 64 }),
  /**
   * Active Stripe Subscription ID (sub_xxx). NULL = no active subscription.
   * Set by webhook on checkout.session.completed / subscription events.
   */
  stripeSubscriptionId: varchar("stripeSubscriptionId", { length: 64 }),
  /**
   * Subscription plan slug (FK-by-value to subscription_plans.slug). NULL = no
   * active subscription. Widened 16→64 to hold owner-created plan slugs; the
   * legacy values ('monthly'|'annual'|'pro'|'sharp'|'operator') still fit.
   */
  stripePlanId: varchar("stripePlanId", { length: 64 }),
  /**
   * Which plan_prices row (i.e. which billing interval) this user is subscribed
   * on. NULL = unknown/legacy — every row predating this column, plus users with
   * no subscription. FK-by-value to plan_prices.id, joined in the application:
   * this repo declares NO DB-level foreign keys, so nothing cascades and nothing
   * is enforced by the database.
   *
   * WHY THE ID AND NOT THE INTERVAL STRING: "month" is ambiguous across plans and
   * across repricings. plan_prices rows are immutable-by-convention (a repriced
   * interval mints a NEW row and archives the old one), so the id records the
   * exact price the user actually bought — the amount, currency, cadence, trial
   * and promo they are still being billed at after the plan was repriced.
   */
  planPriceId: int("planPriceId"),
  /**
   * TRUE when the Stripe subscription is set to cancel at period end (user clicked Cancel).
   * FALSE/NULL = subscription is active and will auto-renew.
   * Set to TRUE by cancelSubscription, FALSE by reactivateSubscription.
   */
  cancelAtPeriodEnd: boolean("cancelAtPeriodEnd").default(false).notNull(),
  // ─── Pending account setup (new users who paid before creating an account) ───
  /**
   * TRUE when a new user has paid via Stripe but has not yet set their email/password.
   * The webhook creates the account with a random passwordHash and sets this flag.
   * The SubscribeSuccess page prompts them to set email + password.
   * Once they complete setup, this is set to FALSE and Discord role is assigned.
   */
  pendingSetup: boolean("pendingSetup").default(false).notNull(),
  /**
   * The email address collected by Stripe during checkout (customer_details.email).
   * Pre-filled in the SubscribeSuccess account setup form.
   * Cleared (set to NULL) after the user completes account setup.
   */
  pendingEmail: varchar("pendingEmail", { length: 320 }),
  /**
   * The desired username collected via Stripe custom_fields during checkout.
   * Pre-filled in the SubscribeSuccess account setup form.
   * Cleared (set to NULL) after the user completes account setup.
   */
  pendingUsername: varchar("pendingUsername", { length: 64 }),
  /**
   * The Stripe Checkout Session ID (cs_xxx) that created this pending account.
   * Used by the SubscribeSuccess page to look up the account and verify payment.
   * Cleared (set to NULL) after the user completes account setup.
   */
  pendingStripeSessionId: varchar("pendingStripeSessionId", { length: 128 }),
  /**
   * UTC ms when the pending-setup claim expires. After this instant the
   * pendingStripeSessionId can no longer be redeemed to claim the account.
   * NULL = legacy row created before the claim window existed.
   */
  pendingSetupExpiresAt: bigint("pendingSetupExpiresAt", { mode: "number" }),
  /**
   * Last known RAW Stripe subscription status, stored verbatim so the app can
   * reason about states `hasAccess` alone cannot express:
   * active | trialing | past_due | unpaid | paused | incomplete |
   * incomplete_expired | canceled. NULL = never observed.
   */
  stripeSubscriptionStatus: varchar("stripeSubscriptionStatus", { length: 32 }),
  /**
   * `event.created` (converted to UTC ms) of the most recent APPLIED Stripe
   * subscription event. Out-of-order guard: a webhook whose event.created is
   * older than this value must NOT overwrite entitlement state.
   */
  lastStripeEventAt: bigint("lastStripeEventAt", { mode: "number" }),
}, (table) => ({
  discordIdUnique: uniqueIndex("app_users_discord_id_unique").on(table.discordId),
  manualDiscordIdUnique: uniqueIndex("app_users_manual_discord_id_unique").on(table.manualDiscordId),
  /**
   * Stripe identity uniqueness. All three columns are nullable and MySQL/TiDB
   * allow unlimited NULLs in a unique index, so unsubscribed rows are unaffected.
   * These prevent two app_users rows ever sharing one Stripe customer /
   * subscription / checkout session — the root shape of double-entitlement bugs.
   */
  stripeCustomerIdUnique: uniqueIndex("app_users_stripe_customer_id_unique").on(table.stripeCustomerId),
  stripeSubscriptionIdUnique: uniqueIndex("app_users_stripe_subscription_id_unique").on(table.stripeSubscriptionId),
  pendingStripeSessionIdUnique: uniqueIndex("app_users_pending_stripe_session_id_unique").on(table.pendingStripeSessionId),
  /**
   * "Who is on this billing interval?" — the query behind per-interval revenue
   * and behind migrating subscribers off a retired plan_prices row. Without this
   * it is a full table scan of app_users.
   */
  planPriceIdIdx: index("app_users_plan_price_idx").on(table.planPriceId),
  /**
   * stripePlanId is an FK-BY-VALUE into subscription_plans.slug and was, until
   * now, entirely unindexed — despite being read on every entitlement check and
   * rewritten in bulk whenever a plan rename changes a slug (syncPlanSlug in
   * server/stripe/planProvisioning.ts updates every referrer by this column).
   * Non-unique on purpose: many users share one plan.
   */
  stripePlanIdIdx: index("app_users_stripe_plan_id_idx").on(table.stripePlanId),
}));

// ─── Subscription plan catalog (owner-managed, Stripe-backed) ────────────────
/**
 * subscription_plans — the DB-backed replacement for the static PLANS record in
 * server/stripe/products.ts. Each row maps to a Stripe Product; its prices live
 * in plan_prices. `slug` is the stable entitlement key written to
 * app_users.stripePlanId and to Stripe session metadata (plan_id).
 */
export const subscriptionPlans = mysqlTable("subscription_plans", {
  id: int("id").autoincrement().primaryKey(),
  /** Stable, unique entitlement key (kebab/short). Matches app_users.stripePlanId. */
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  planType: mysqlEnum("planType", ["recurring", "one_time", "fixed_date"]).default("recurring").notNull(),
  /** Stripe Product ID (prod_xxx). NULL until provisioned / for legacy backfill. */
  stripeProductId: varchar("stripeProductId", { length: 64 }),
  active: boolean("active").default(true).notNull(),
  /** UTC ms when archived; NULL = live. */
  archivedAt: bigint("archivedAt", { mode: "number" }),
  /** fixed_date plans: access is granted until this UTC ms (phase 4). */
  accessUntil: bigint("accessUntil", { mode: "number" }),
  /** Limited-quantity cap on active subscribers; NULL = unlimited (phase 4). */
  maxSubscribers: int("maxSubscribers"),
  /** Auto-restock FOMO loop (phase 3). `availableQuantity` is the live
   *  "spots left" counter shown publicly; it decrements on each subscribe and,
   *  when `autoRestock` is on and it drops below `restockThreshold`, resets to
   *  `restockAmount` — an endless scarcity loop. NULL availableQuantity = the
   *  limited-quantity feature is off for this plan (unlimited). */
  autoRestock: boolean("autoRestock").default(false).notNull(),
  availableQuantity: int("availableQuantity"),
  restockThreshold: int("restockThreshold"),
  restockAmount: int("restockAmount"),
  /** Per-plan Discord role to grant (phase 5). */
  discordRoleId: varchar("discordRoleId", { length: 32 }),
  /** Per-plan Telegram chat/channel to grant (phase 5). */
  telegramChatId: varchar("telegramChatId", { length: 64 }),
  /** Stripe mode this plan was provisioned in — TRUE=live, FALSE=test/sandbox.
   *  Live checkout only offers livemode plans (a test price fails in live mode). */
  livemode: boolean("livemode").default(true).notNull(),
  sortOrder: int("sortOrder").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (table) => ({
  slugIdx: index("subscription_plans_slug_idx").on(table.slug),
}));

/**
 * plan_prices — one row per Stripe Price. Multiple rows per plan support billing
 * variants (e.g. monthly + annual). Editing an amount/interval archives the old
 * row (active=false) and inserts a new one, mirroring Stripe price immutability.
 */
export const planPrices = mysqlTable("plan_prices", {
  id: int("id").autoincrement().primaryKey(),
  /** subscription_plans.id (joined in app; no DB-level FK, matching this repo). */
  planId: int("planId").notNull(),
  /** Stripe Price ID (price_xxx). */
  stripePriceId: varchar("stripePriceId", { length: 64 }).notNull(),
  label: varchar("label", { length: 80 }),
  amountCents: int("amountCents").notNull(),
  currency: varchar("currency", { length: 8 }).default("usd").notNull(),
  /** Recurring cadence; NULL for one-time prices. DB column `billingInterval`. */
  interval: mysqlEnum("billingInterval", ["day", "week", "month", "year"]),
  intervalCount: int("intervalCount"),
  trialPeriodDays: int("trialPeriodDays"),
  /** Per-interval promo (phase 3). `promoType` NULL = no promo. `percent` →
   *  `promoValue` is 1–100; `amount` → `promoValue` is a discount in cents. A
   *  Stripe coupon (duration=forever) is provisioned per promo and applied at
   *  checkout for THIS price; `promoCode`, if set, is also registered as a
   *  shareable Stripe promotion code. */
  promoType: mysqlEnum("promoType", ["percent", "amount"]),
  promoValue: int("promoValue"),
  promoCode: varchar("promoCode", { length: 64 }),
  stripeCouponId: varchar("stripeCouponId", { length: 64 }),
  stripePromoCodeId: varchar("stripePromoCodeId", { length: 64 }),
  active: boolean("active").default(true).notNull(),
  isDefault: boolean("isDefault").default(false).notNull(),
  /** Owner-hidden interval: retained, but not offered at checkout or shown
   *  publicly (eyeball toggle). Distinct from active=false (archived). */
  hidden: boolean("hidden").default(false).notNull(),
  /** Display order among a plan's intervals — drag-to-reorder (⠿ handle). */
  sortOrder: int("sortOrder").default(0).notNull(),
  /** Stripe mode of this Price — TRUE=live, FALSE=test/sandbox. Mirrors the plan. */
  livemode: boolean("livemode").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  planIdIdx: index("plan_prices_plan_id_idx").on(table.planId),
  /**
   * One row per Stripe Price — a duplicate price row silently doubles a plan's
   * checkout options and breaks price→plan resolution. Declared under a NEW
   * name because the legacy non-unique KEY `plan_prices_stripe_price_id_idx`
   * still exists in production; the hardening migration is additive-only and
   * does NOT drop it (a redundant secondary index is harmless).
   */
  stripePriceIdUnique: uniqueIndex("plan_prices_stripe_price_id_unique").on(table.stripePriceId),
}));

/**
 * plan_features — which marketing/entitlement features a plan advertises, one
 * row per (plan, feature).
 *
 * WHY A JOIN TABLE AND NOT A JSON/TEXT COLUMN ON subscription_plans: feature
 * membership is a query, not prose. "Which plans include player prop
 * projections?" is an indexed equality lookup here; against a JSON blob or a
 * comma-joined string it degrades to a LIKE over free text that cannot use an
 * index and matches substrings by accident (`daily_lineups` inside
 * `daily_lineups_beta`). A row per feature also makes reordering, per-feature
 * analytics, and future per-feature metadata additive column work instead of a
 * blob rewrite, and it lets the DB — not application code — enforce that a plan
 * cannot list the same feature twice.
 */
export const planFeatures = mysqlTable("plan_features", {
  id: int("id").autoincrement().primaryKey(),
  /** subscription_plans.id (joined in app; no DB-level FK, matching this repo). */
  planId: int("planId").notNull(),
  /**
   * A key from shared/planFeatures.ts — the KEY is stored, never the label, so
   * marketing can reword a feature without a data migration.
   */
  featureKey: varchar("featureKey", { length: 64 }).notNull(),
  /** Display order within the plan — drag-to-reorder in the plan editor. */
  sortOrder: int("sortOrder").default(0).notNull(),
  /** UTC ms, matching the bigint time columns elsewhere in this file. */
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
}, (table) => ({
  /**
   * One row per feature per plan. This is what makes a re-save idempotent: the
   * editor can upsert the selected set without first proving what is already
   * there, and a double-submit cannot duplicate a chip.
   */
  planFeatureUnique: uniqueIndex("plan_features_plan_feature_unique").on(table.planId, table.featureKey),
  /** Powers the reverse lookup: "which plans include feature X?". */
  featureIdx: index("plan_features_feature_idx").on(table.featureKey),
  /** Powers the ordered render of one plan's feature list without a filesort. */
  planSortIdx: index("plan_features_plan_sort_idx").on(table.planId, table.sortOrder),
}));

export type SubscriptionPlan = typeof subscriptionPlans.$inferSelect;
export type InsertSubscriptionPlan = typeof subscriptionPlans.$inferInsert;
export type PlanPrice = typeof planPrices.$inferSelect;
export type InsertPlanPrice = typeof planPrices.$inferInsert;
export type PlanFeature = typeof planFeatures.$inferSelect;
export type InsertPlanFeature = typeof planFeatures.$inferInsert;

export type AppUser = typeof appUsers.$inferSelect;
export type InsertAppUser = typeof appUsers.$inferInsert;

// ─── Stripe webhook idempotency ledger ───────────────────────────────────────
/**
 * stripe_webhook_events — one row per Stripe event the webhook has APPLIED.
 * Stripe guarantees at-least-once delivery, so the same event.id can arrive
 * twice (retries, replays, concurrent deliveries). The handler inserts here
 * FIRST: a duplicate-key violation on `stripeEventId` is the proof the event
 * was already processed, and the handler acks 200 without re-applying money
 * effects. `livemode` is recorded so test-mode traffic can never be mistaken
 * for live traffic during an audit.
 */
export const stripeWebhookEvents = mysqlTable("stripe_webhook_events", {
  id: int("id").autoincrement().primaryKey(),
  /** Stripe `event.id` (evt_xxx). The idempotency key — UNIQUE. */
  stripeEventId: varchar("stripeEventId", { length: 255 }).notNull(),
  /** Stripe `event.type`, e.g. 'customer.subscription.updated'. */
  eventType: varchar("eventType", { length: 64 }).notNull(),
  /** Stripe `event.livemode` — TRUE=live keys, FALSE=test/sandbox. */
  livemode: boolean("livemode").default(false).notNull(),
  /** Stripe `event.created` converted to UTC ms. NULL = not supplied. */
  eventCreatedAt: bigint("eventCreatedAt", { mode: "number" }),
  /** UTC ms when this row was written (i.e. when the event was applied). */
  processedAt: bigint("processedAt", { mode: "number" }).notNull(),
  /** 'processed' | 'skipped' | 'failed' — outcome of the applied attempt. */
  status: varchar("status", { length: 16 }).default("processed").notNull(),
}, (table) => ({
  stripeEventIdUnique: uniqueIndex("stripe_webhook_events_event_id_unique").on(table.stripeEventId),
  eventTypeIdx: index("stripe_webhook_events_event_type_idx").on(table.eventType),
}));

export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;
export type InsertStripeWebhookEvent = typeof stripeWebhookEvents.$inferInsert;

// ─── Entitlement audit trail (durable money-event log) ───────────────────────
/**
 * entitlement_events — append-only record of every change to a user's paid
 * access, with the BEFORE and AFTER of each entitlement field. This is the
 * forensic trail for "why does this user have (or not have) access?": logs
 * rotate, this table does not. `actor` distinguishes automated Stripe webhook
 * changes from manual owner/admin grants. Rows are never updated or deleted.
 */
/**
 * Checkout attempt ledger — one row per Stripe Checkout Session.
 *
 * Written BEFORE the buyer is redirected to Stripe, then resolved by the
 * webhook. Prior to this, a checkout existed only inside Stripe; the sole local
 * trace was `app_users.pendingStripeSessionId`, set only for logged-in buyers,
 * so an anonymous purchase left nothing behind and an abandoned one left
 * nothing at all.
 *
 * `status` and `fulfillment` are deliberately independent. A session can be
 * status='completed' (Stripe captured the money) while fulfillment='dropped'
 * (we granted no access). Those two being indistinguishable is precisely what
 * hid two live dropped payments.
 */
export const checkoutSessions = mysqlTable("checkout_sessions", {
  id: int("id").autoincrement().primaryKey(),
  /** Stripe `cs_...` id. UNIQUE — makes the webhook write-back an idempotent upsert. */
  stripeSessionId: varchar("stripeSessionId", { length: 255 }).notNull().unique(),
  livemode: boolean("livemode").default(true).notNull(),
  /** "subscription" | "payment" */
  mode: varchar("mode", { length: 16 }).notNull(),
  /** Stripe-side lifecycle: created | completed | expired */
  status: varchar("status", { length: 16 }).default("created").notNull(),
  /** Our side: pending | fulfilled | dropped | skipped */
  fulfillment: varchar("fulfillment", { length: 16 }).default("pending").notNull(),
  /** Why not fulfilled. NULL once fulfilled. */
  fulfillmentReason: varchar("fulfillmentReason", { length: 120 }),
  /** NULL for anonymous checkout — the case that used to be unrecoverable. */
  userId: int("userId"),
  planId: varchar("planId", { length: 64 }),
  planPriceId: int("planPriceId"),
  stripePriceId: varchar("stripePriceId", { length: 64 }),
  amountCents: int("amountCents"),
  currency: varchar("currency", { length: 8 }),
  desiredUsername: varchar("desiredUsername", { length: 64 }),
  customerEmail: varchar("customerEmail", { length: 255 }),
  stripeCustomerId: varchar("stripeCustomerId", { length: 64 }),
  stripeSubscriptionId: varchar("stripeSubscriptionId", { length: 64 }),
  stripePaymentIntentId: varchar("stripePaymentIntentId", { length: 64 }),
  paymentStatus: varchar("paymentStatus", { length: 32 }),
  origin: varchar("origin", { length: 255 }),
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
  completedAt: bigint("completedAt", { mode: "number" }),
  resolvedAt: bigint("resolvedAt", { mode: "number" }),
}, (t) => ({
  fulfillmentIdx: index("checkout_sessions_fulfillment_idx").on(t.fulfillment, t.status),
  statusCreatedIdx: index("checkout_sessions_status_created_idx").on(t.status, t.createdAt),
  userIdx: index("checkout_sessions_user_idx").on(t.userId),
  customerIdx: index("checkout_sessions_customer_idx").on(t.stripeCustomerId),
  planIdx: index("checkout_sessions_plan_idx").on(t.planId),
  emailIdx: index("checkout_sessions_email_idx").on(t.customerEmail),
}));

/**
 * Payment ledger — every money movement, recorded locally.
 *
 * Before this, the money existed only inside Stripe. `entitlement_events` said
 * access changed and `checkout_sessions` said a checkout resolved, but no row
 * anywhere carried an AMOUNT — so "what did we collect", "which renewals
 * failed" and "how much is in dispute" all required opening Stripe.
 *
 * `outcome` is separate from `kind` for the same reason it is on
 * checkout_sessions: what Stripe did and what WE did about it are different
 * facts, and collapsing them is how a silent drop hides.
 */
export const paymentEvents = mysqlTable("payment_events", {
  id: int("id").autoincrement().primaryKey(),
  stripeEventId: varchar("stripeEventId", { length: 255 }).notNull(),
  eventType: varchar("eventType", { length: 64 }).notNull(),
  livemode: boolean("livemode").default(true).notNull(),
  /** The Stripe money object (pi_/in_/ch_/dp_). */
  objectId: varchar("objectId", { length: 64 }).notNull(),
  objectType: varchar("objectType", { length: 32 }).notNull(),
  /** succeeded | failed | refunded | disputed | uncollectible */
  kind: varchar("kind", { length: 24 }).notNull(),
  /** What we did: recorded | granted | revoked | noop */
  outcome: varchar("outcome", { length: 16 }).default("recorded").notNull(),
  outcomeReason: varchar("outcomeReason", { length: 160 }),
  amountCents: int("amountCents"),
  currency: varchar("currency", { length: 8 }),
  amountRefundedCents: int("amountRefundedCents"),
  userId: int("userId"),
  stripeCustomerId: varchar("stripeCustomerId", { length: 64 }),
  stripeSubscriptionId: varchar("stripeSubscriptionId", { length: 64 }),
  stripeInvoiceId: varchar("stripeInvoiceId", { length: 64 }),
  customerEmail: varchar("customerEmail", { length: 255 }),
  failureCode: varchar("failureCode", { length: 64 }),
  failureMessage: varchar("failureMessage", { length: 255 }),
  attemptCount: int("attemptCount"),
  occurredAt: bigint("occurredAt", { mode: "number" }).notNull(),
  recordedAt: bigint("recordedAt", { mode: "number" }).notNull(),
}, (t) => ({
  kindOccurredIdx: index("payment_events_kind_occurred_idx").on(t.kind, t.occurredAt),
  userIdx: index("payment_events_user_idx").on(t.userId, t.occurredAt),
  customerIdx: index("payment_events_customer_idx").on(t.stripeCustomerId),
  subscriptionIdx: index("payment_events_subscription_idx").on(t.stripeSubscriptionId),
  invoiceIdx: index("payment_events_invoice_idx").on(t.stripeInvoiceId),
  outcomeIdx: index("payment_events_outcome_idx").on(t.outcome, t.kind),
  eventObjectUnique: uniqueIndex("payment_events_event_object_unique").on(t.stripeEventId, t.objectId),
}));

/**
 * subscription_events — append-only record of every subscription lifecycle
 * transition: creation, plan change, cancel scheduled/reverted, status move,
 * deletion, renewal, and trial/renewal previews.
 *
 * Why it exists (avenues #3/#4/#8, 2026-08-01): plan changes route through the
 * Stripe Customer Portal — the recommended pattern — which means no in-app code
 * runs when a member switches plans. The ONLY local trace of any transition was
 * whatever grantUserAccess happened to overwrite on app_users, which is current
 * state, not history. "Who downgraded last month", "how many scheduled
 * cancellations were reverted", and "which subscription did this renewal
 * extend" were unanswerable without opening Stripe.
 *
 * `kind` (what happened to the subscription) is stored separately from
 * `outcome` (what WE did about it) with a reason — the same rule as
 * checkout_sessions and payment_events, because collapsing those two facts is
 * exactly how the original checkout incident stayed hidden.
 *
 * from/to price ids are Stripe price ids, not plan_prices row ids: prices are
 * immutable in Stripe, so the pair pins the exact SKUs either side of a
 * transition even after a repricing retires the row.
 */
export const subscriptionEvents = mysqlTable("subscription_events", {
  id: int("id").autoincrement().primaryKey(),
  /** Stripe event id; NULL for app-initiated actions (cancel/reactivate). */
  stripeEventId: varchar("stripeEventId", { length: 255 }),
  /** Stripe event type, or a synthetic `app.*` type for in-app actions. */
  eventType: varchar("eventType", { length: 64 }).notNull(),
  livemode: boolean("livemode").default(true).notNull(),
  stripeSubscriptionId: varchar("stripeSubscriptionId", { length: 64 }).notNull(),
  stripeCustomerId: varchar("stripeCustomerId", { length: 64 }),
  userId: int("userId"),
  /** created | plan_changed | cancel_scheduled | cancel_reverted |
   *  status_changed | updated | deleted | renewed | trial_ending |
   *  renewal_upcoming | payment_failed */
  kind: varchar("kind", { length: 24 }).notNull(),
  /** What we did: recorded | granted | revoked | noop */
  outcome: varchar("outcome", { length: 16 }).default("recorded").notNull(),
  outcomeReason: varchar("outcomeReason", { length: 160 }),
  /** Plan slugs (app_users.stripePlanId vocabulary). */
  fromPlanId: varchar("fromPlanId", { length: 64 }),
  toPlanId: varchar("toPlanId", { length: 64 }),
  /** Stripe price ids — immutable SKU identity either side of the transition. */
  fromPriceId: varchar("fromPriceId", { length: 64 }),
  toPriceId: varchar("toPriceId", { length: 64 }),
  fromInterval: varchar("fromInterval", { length: 16 }),
  toInterval: varchar("toInterval", { length: 16 }),
  /** Stripe subscription status after the event. */
  status: varchar("status", { length: 24 }),
  cancelAtPeriodEnd: boolean("cancelAtPeriodEnd"),
  /** End of the billing period this event governs, UTC ms. */
  periodEnd: bigint("periodEnd", { mode: "number" }),
  /** webhook | user | owner | system */
  actor: varchar("actor", { length: 16 }).default("webhook").notNull(),
  occurredAt: bigint("occurredAt", { mode: "number" }).notNull(),
  recordedAt: bigint("recordedAt", { mode: "number" }).notNull(),
}, (t) => ({
  subOccurredIdx: index("subscription_events_sub_occurred_idx").on(t.stripeSubscriptionId, t.occurredAt),
  userOccurredIdx: index("subscription_events_user_occurred_idx").on(t.userId, t.occurredAt),
  kindOccurredIdx: index("subscription_events_kind_occurred_idx").on(t.kind, t.occurredAt),
  customerIdx: index("subscription_events_customer_idx").on(t.stripeCustomerId),
  outcomeKindIdx: index("subscription_events_outcome_kind_idx").on(t.outcome, t.kind),
  /** Redelivery guard. NULL stripeEventId rows (app-initiated) are exempt. */
  eventKindUnique: uniqueIndex("subscription_events_event_kind_unique").on(t.stripeEventId, t.kind),
}));

export type SubscriptionEvent = typeof subscriptionEvents.$inferSelect;
export type InsertSubscriptionEvent = typeof subscriptionEvents.$inferInsert;

export const entitlementEvents = mysqlTable("entitlement_events", {
  id: int("id").autoincrement().primaryKey(),
  /** app_users.id whose entitlement changed (joined in app; no DB-level FK). */
  userId: int("userId").notNull(),
  /** Stripe `event.id` that caused the change; NULL for manual/admin actions. */
  stripeEventId: varchar("stripeEventId", { length: 255 }),
  /** Stripe event type, or a synthetic type for non-Stripe changes. */
  eventType: varchar("eventType", { length: 64 }).notNull(),
  /** Short machine reason, e.g. 'subscription_deleted', 'manual_grant'. */
  reason: varchar("reason", { length: 64 }).notNull(),
  /** Who applied it: 'webhook' (default), 'owner', 'admin', 'cron', 'backfill'. */
  actor: varchar("actor", { length: 64 }).default("webhook").notNull(),
  beforeHasAccess: boolean("beforeHasAccess"),
  afterHasAccess: boolean("afterHasAccess"),
  beforePlanId: varchar("beforePlanId", { length: 64 }),
  afterPlanId: varchar("afterPlanId", { length: 64 }),
  /** UTC ms; NULL carries the "lifetime access" meaning of app_users.expiryDate. */
  beforeExpiryDate: bigint("beforeExpiryDate", { mode: "number" }),
  afterExpiryDate: bigint("afterExpiryDate", { mode: "number" }),
  /** UTC ms when this audit row was written. */
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
}, (table) => ({
  userCreatedIdx: index("entitlement_events_user_created_idx").on(table.userId, table.createdAt),
  stripeEventIdIdx: index("entitlement_events_stripe_event_id_idx").on(table.stripeEventId),
}));

export type EntitlementEvent = typeof entitlementEvents.$inferSelect;
export type InsertEntitlementEvent = typeof entitlementEvents.$inferInsert;

// ─── Discord OAuth CSRF state store (DB-backed, survives server restarts) ────
//
// WHY DB-BACKED:
//   Cloud Run can run multiple instances simultaneously. The /connect request
//   may hit instance A (stores state in memory) while the /callback request
//   hits instance B (empty pendingStates → state_mismatch → OAuth fails).
//   Storing state in the DB ensures all instances share the same state store.
//
// TTL: 10 minutes. Expired rows are cleaned up on each /callback request.
export const discordOAuthStates = mysqlTable("discord_oauth_states", {
  /** Random CSRF state token generated in /connect */
  state:     varchar("state",     { length: 64 }).primaryKey(),
  /** app_users.id of the user who initiated the OAuth flow */
  userId:    int("userId").notNull(),
  /** UTC timestamp (ms) when this state expires (10 min from creation) */
  expiresAt: bigint("expiresAt", { mode: "number" }).notNull(),
  /** UTC timestamp (ms) when this row was created */
  createdAt: bigint("createdAt", { mode: "number" }).notNull(),
});

export type DiscordOAuthState = typeof discordOAuthStates.$inferSelect;
export type InsertDiscordOAuthState = typeof discordOAuthStates.$inferInsert;

// ─── Model files (uploaded CSVs) ────────────────────────────────────────────

export const modelFiles = mysqlTable("model_files", {
  id: int("id").autoincrement().primaryKey(),
  uploadedBy: int("uploadedBy").notNull(),
  filename: varchar("filename", { length: 255 }).notNull(),
  fileKey: varchar("fileKey", { length: 512 }).notNull(),
  fileUrl: text("fileUrl").notNull(),
  mimeType: varchar("mimeType", { length: 128 }).notNull().default("text/csv"),
  sizeBytes: int("sizeBytes").notNull().default(0),
  sport: varchar("sport", { length: 64 }).notNull().default("NCAAM"),
  gameDate: varchar("gameDate", { length: 20 }),
  status: mysqlEnum("status", ["pending", "processing", "done", "error"])
    .notNull()
    .default("pending"),
  rowsImported: int("rowsImported").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ModelFile = typeof modelFiles.$inferSelect;
export type InsertModelFile = typeof modelFiles.$inferInsert;

// ─── Games (parsed from CSV) ─────────────────────────────────────────────────

export const games = mysqlTable("games", {
  id: int("id").autoincrement().primaryKey(),
  fileId: int("fileId").notNull(),
  gameDate: varchar("gameDate", { length: 20 }).notNull(),
  startTimeEst: varchar("startTimeEst", { length: 12 }).notNull().default("TBD"),
  awayTeam: varchar("awayTeam", { length: 128 }).notNull(),
  awayBookSpread: decimal("awayBookSpread", { precision: 6, scale: 1 }),
  awayModelSpread: decimal("awayModelSpread", { precision: 6, scale: 1 }),
  homeTeam: varchar("homeTeam", { length: 128 }).notNull(),
  homeBookSpread: decimal("homeBookSpread", { precision: 6, scale: 1 }),
  homeModelSpread: decimal("homeModelSpread", { precision: 6, scale: 1 }),
  bookTotal: decimal("bookTotal", { precision: 6, scale: 1 }),
  modelTotal: decimal("modelTotal", { precision: 6, scale: 1 }),
  spreadEdge: varchar("spreadEdge", { length: 128 }),
  spreadDiff: decimal("spreadDiff", { precision: 5, scale: 1 }),
  totalEdge: varchar("totalEdge", { length: 128 }),
  totalDiff: decimal("totalDiff", { precision: 5, scale: 1 }),
  sport: varchar("sport", { length: 64 }).notNull().default("NCAAM"),
  /** 'regular_season' or 'conference_tournament' */
  gameType: mysqlEnum("gameType", ["regular_season", "conference_tournament"]).notNull().default("regular_season"),
  /** Conference name for tournament games, e.g. 'MAC', 'Big East' */
  conference: varchar("conference", { length: 128 }),
  /** Whether this game has been published to the member feed by the owner */
  publishedToFeed: boolean("publishedToFeed").notNull().default(false),
  /** Whether the model projections for this game have been approved by the owner for public display */
  publishedModel: boolean("publishedModel").notNull().default(false),
  // ─── VSiN Betting Splits (integer 0-100, null = not yet scraped) ───────────
  /** % of spread bets placed on the away team */
  spreadAwayBetsPct: tinyint("spreadAwayBetsPct"),
  /** % of spread money wagered on the away team */
  spreadAwayMoneyPct: tinyint("spreadAwayMoneyPct"),
  /** % of total (O/U) bets placed on the Over */
  totalOverBetsPct: tinyint("totalOverBetsPct"),
  /** % of total (O/U) money wagered on the Over */
  totalOverMoneyPct: tinyint("totalOverMoneyPct"),
  /** % of moneyline bets placed on the away team */
  mlAwayBetsPct: tinyint("mlAwayBetsPct"),
  /** % of moneyline money wagered on the away team */
  mlAwayMoneyPct: tinyint("mlAwayMoneyPct"),
  /** Away team moneyline odds, e.g. "+120" or "-900" */
  awayML: varchar("awayML", { length: 16 }),
  /** Home team moneyline odds, e.g. "-142" or "+600" */
  homeML: varchar("homeML", { length: 16 }),
  /**
   * Puck line / spread juice for the away team, e.g. "-226" or "+184".
   * Populated from MetaBet consensus board for NHL games.
   * For NCAAM/NBA the spread is almost always -110 so this is typically null.
   */
  awaySpreadOdds: varchar("awaySpreadOdds", { length: 16 }),
  /** Puck line / spread juice for the home team, e.g. "+184" or "-226" */
  homeSpreadOdds: varchar("homeSpreadOdds", { length: 16 }),
  /** Over odds for the O/U total, e.g. "-107" (null = not available / standard -110) */
  overOdds: varchar("overOdds", { length: 16 }),
  /** Under odds for the O/U total, e.g. "-113" (null = not available / standard -110) */
  underOdds: varchar("underOdds", { length: 16 }),
  // ─── Action Network Open Lines (opening odds at time of market creation) ─────
  /** AN opening spread for the away team, e.g. "+8.5" or "-3" */
  openAwaySpread: varchar("openAwaySpread", { length: 16 }),
  /** AN opening spread juice for the away team, e.g. "-102" or "-110" */
  openAwaySpreadOdds: varchar("openAwaySpreadOdds", { length: 16 }),
  /** AN opening spread for the home team, e.g. "-8.5" or "+3" */
  openHomeSpread: varchar("openHomeSpread", { length: 16 }),
  /** AN opening spread juice for the home team, e.g. "-120" or "-110" */
  openHomeSpreadOdds: varchar("openHomeSpreadOdds", { length: 16 }),
  /** AN opening total (over line), e.g. "151.5" */
  openTotal: varchar("openTotal", { length: 16 }),
  /** AN opening over juice, e.g. "-110" */
  openOverOdds: varchar("openOverOdds", { length: 16 }),
  /** AN opening under juice, e.g. "-110" */
  openUnderOdds: varchar("openUnderOdds", { length: 16 }),
  /** AN opening moneyline for the away team, e.g. "+285" */
  openAwayML: varchar("openAwayML", { length: 16 }),
  /** AN opening moneyline for the home team, e.g. "-365" */
  openHomeML: varchar("openHomeML", { length: 16 }),
  // Note: DK NJ current lines are stored in the primary book columns:
  // awayBookSpread, homeBookSpread, bookTotal, awayML, homeML,
  // awaySpreadOdds, homeSpreadOdds, overOdds, underOdds
  // These are populated by the ingestAnHtml tRPC procedure (AN HTML best-odds table).
  /** Model fair value moneyline for the away team, e.g. "+225" or "-670" */
  modelAwayML: varchar("modelAwayML", { length: 16 }),
  /** Model fair value moneyline for the home team, e.g. "-225" or "+670" */
  modelHomeML: varchar("modelHomeML", { length: 16 }),
  /** Model projected score for the away team (decimal, hundredths precision) */
  modelAwayScore: decimal("modelAwayScore", { precision: 6, scale: 2 }),
  /** Model projected score for the home team (decimal, hundredths precision) */
  modelHomeScore: decimal("modelHomeScore", { precision: 6, scale: 2 }),
  /** Model over rate from 400k simulations (0-100) */
  modelOverRate: decimal("modelOverRate", { precision: 5, scale: 2 }),
  /** Model under rate from 400k simulations (0-100) */
  modelUnderRate: decimal("modelUnderRate", { precision: 5, scale: 2 }),
  /** Model fair odds for away team at book spread line, e.g. "-118" or "+105" */
  modelAwaySpreadOdds: varchar("modelAwaySpreadOdds", { length: 16 }),
  /** Model fair odds for home team at book spread line, e.g. "+105" or "-118" */
  modelHomeSpreadOdds: varchar("modelHomeSpreadOdds", { length: 16 }),
  /** Away team win probability from model (0-100) */
  modelAwayWinPct: decimal("modelAwayWinPct", { precision: 5, scale: 2 }),
  /** Home team win probability from model (0-100) */
  modelHomeWinPct: decimal("modelHomeWinPct", { precision: 5, scale: 2 }),
  /** Whether the model spread was clamped to band limit */
  modelSpreadClamped: boolean("modelSpreadClamped").default(false),
  /** Whether the model total was clamped to band limit */
  modelTotalClamped: boolean("modelTotalClamped").default(false),
  /** Cover/total correlation direction: 'OVER', 'UNDER', or 'NONE' */
  modelCoverDirection: varchar("modelCoverDirection", { length: 8 }),
  /** UTC timestamp (ms) when the model last ran for this game */
  modelRunAt: bigint("modelRunAt", { mode: "number" }),
  /** WagerTalk rotation numbers e.g. '689/690' (away/home) */
  rotNums: varchar("rotNums", { length: 32 }),
  /** WagerTalk display order — lower number appears first */
  sortOrder: int("sortOrder").notNull().default(9999),
  /** NCAA contest ID (unique per game) — used to dedup NCAA-only games (e.g. TBA vs TBA) */
  ncaaContestId: varchar("ncaaContestId", { length: 20 }),
  // ─── March Madness Bracket Progression ──────────────────────────────────────
  /** NCAA.com bracket game ID, e.g. 101 (FF), 201-232 (R64), 301-316 (R32), etc. */
  bracketGameId: int("bracketGameId"),
  /** Tournament round: 'FIRST_FOUR', 'R64', 'R32', 'S16', 'E8', 'F4', 'CHAMPIONSHIP' */
  bracketRound: varchar("bracketRound", { length: 20 }),
  /** Tournament region: 'EAST', 'WEST', 'SOUTH', 'MIDWEST', 'FINAL_FOUR' */
  bracketRegion: varchar("bracketRegion", { length: 20 }),
  /** Slot within the region (1-8 for R64, 1-4 for R32, 1-2 for S16, 1 for E8) */
  bracketSlot: int("bracketSlot"),
  /** NCAA.com bracket game ID of the next-round game this winner advances to */
  nextBracketGameId: int("nextBracketGameId"),
  /** Whether the winner of this game fills the 'top' or 'bottom' slot in the next game */
  nextBracketSlot: mysqlEnum("nextBracketSlot", ["top", "bottom"]),
  /** Game status: 'upcoming' (pre-game), 'live' (in-progress), 'final' (completed), 'postponed' (game postponed/cancelled) */
  gameStatus: mysqlEnum("gameStatus", ["upcoming", "live", "final", "postponed", "suspended"]).notNull().default("upcoming"),
  /** Away team current/final score (null = not started) */
  awayScore: int("awayScore"),
  /** Home team current/final score (null = not started) */
  homeScore: int("homeScore"),
  /** Game clock string for live games, e.g. "15:07 1st" or "HALF" (null = not live) */
  gameClock: varchar("gameClock", { length: 32 }),
  // ─── MLB-specific fields ──────────────────────────────────────────────────
  /** MLB.com gamePk (unique game ID from statsapi.mlb.com) */
  mlbGamePk: int("mlbGamePk"),
  /** Primary TV broadcaster for the game, e.g. "Netflix", "ESPN", "FOX" */
  broadcaster: varchar("broadcaster", { length: 128 }),
  /** Away team starting pitcher name, e.g. "Gerrit Cole" */
  awayStartingPitcher: varchar("awayStartingPitcher", { length: 128 }),
  /** Home team starting pitcher name, e.g. "Logan Webb" */
  homeStartingPitcher: varchar("homeStartingPitcher", { length: 128 }),
  /** Whether the away starting pitcher is confirmed (true) or projected (false) */
  awayPitcherConfirmed: boolean("awayPitcherConfirmed").default(false),
  /** Whether the home starting pitcher is confirmed (true) or projected (false) */
  homePitcherConfirmed: boolean("homePitcherConfirmed").default(false),
  /** Ballpark / venue name, e.g. "Oracle Park" */
  venue: varchar("venue", { length: 128 }),
  /**
   * MLB Stats API doubleheader flag: 'N'=no, 'Y'=traditional doubleheader,
   * 'S'=split (separate-admission) doubleheader. Grouping metadata only —
   * event identity is mlbGamePk, never this flag.
   */
  doubleHeader: varchar("doubleHeader", { length: 2 }).default("N"),
  /** Game number within a doubleheader (1 or 2; 1 for non-DH games) */
  gameNumber: tinyint("gameNumber").default(1),
  /**
   * Original scheduled date "YYYY-MM-DD" when this game is a rescheduled
   * makeup (statsapi `rescheduledFrom`), e.g. the 2026-07-17 TB@BOS G1 makeup
   * carries "2026-05-09". Null for games played on their original date.
   */
  rescheduledFrom: varchar("rescheduledFrom", { length: 10 }),
  /** Away team run line (spread), e.g. "-1.5" or "+1.5" */
  awayRunLine: varchar("awayRunLine", { length: 8 }),
  /** Home team run line (spread), e.g. "+1.5" or "-1.5" */
  homeRunLine: varchar("homeRunLine", { length: 8 }),
  /** Away run line juice, e.g. "+135" or "-160" */
  awayRunLineOdds: varchar("awayRunLineOdds", { length: 16 }),
  /** Home run line juice, e.g. "-160" or "+135" */
  homeRunLineOdds: varchar("homeRunLineOdds", { length: 16 }),
  /** % of run line bets placed on the away team */
  rlAwayBetsPct: tinyint("rlAwayBetsPct"),
  /** % of run line money wagered on the away team */
  rlAwayMoneyPct: tinyint("rlAwayMoneyPct"),
  // ─── NHL-specific fields ──────────────────────────────────────────────────
  /** Starting goalie for the away team (NHL only), e.g. "Jeremy Swayman" */
  awayGoalie: varchar("awayGoalie", { length: 128 }),
  /** Starting goalie for the home team (NHL only), e.g. "Andrei Vasilevskiy" */
  homeGoalie: varchar("homeGoalie", { length: 128 }),
  /** Whether the away goalie is confirmed (true) or projected (false) */
  awayGoalieConfirmed: boolean("awayGoalieConfirmed").default(false),
  /** Whether the home goalie is confirmed (true) or projected (false) */
  homeGoalieConfirmed: boolean("homeGoalieConfirmed").default(false),
  /** Model puck line cover probability for the away team (0-100) */
  modelAwayPLCoverPct: decimal("modelAwayPLCoverPct", { precision: 5, scale: 2 }),
  /** Model puck line cover probability for the home team (0-100) */
  modelHomePLCoverPct: decimal("modelHomePLCoverPct", { precision: 5, scale: 2 }),
  /** Model puck line spread for the away team, e.g. "+1.5" or "-2.5" */
  modelAwayPuckLine: varchar("modelAwayPuckLine", { length: 8 }),
  /** Model puck line spread for the home team, e.g. "-1.5" or "+2.5" */
  modelHomePuckLine: varchar("modelHomePuckLine", { length: 8 }),
  /** Model fair value odds for the away puck line, e.g. "-133" or "+115" */
  modelAwayPLOdds: varchar("modelAwayPLOdds", { length: 16 }),
  /** Model fair value odds for the home puck line, e.g. "+133" or "-115" */
  modelHomePLOdds: varchar("modelHomePLOdds", { length: 16 }),
  /** Model fair value odds for the Over, e.g. "+131" or "-108" */
  modelOverOdds: varchar("modelOverOdds", { length: 16 }),
  /** Model fair value odds for the Under, e.g. "-131" or "+108" */
  modelUnderOdds: varchar("modelUnderOdds", { length: 16 }),

  // ─── Full Game Backtest Results ──────────────────────────────────────────────
  /** Actual away team final score (populated after game FINAL) */
  actualAwayScore: int("actualAwayScore"),
  /** Actual home team final score (populated after game FINAL) */
  actualHomeScore: int("actualHomeScore"),
  /** FG ML backtest result: 'WIN' | 'LOSS' | 'PUSH' | 'PENDING' */
  fgMlResult: varchar("fgMlResult", { length: 16 }),
  /** FG Run Line backtest result: 'WIN' | 'LOSS' | 'PUSH' | 'PENDING' */
  fgRlResult: varchar("fgRlResult", { length: 16 }),
  /** FG Total backtest result: 'OVER' | 'UNDER' | 'PUSH' | 'PENDING' */
  fgTotalResult: varchar("fgTotalResult", { length: 16 }),
  /** Model ML prediction correct: 1=yes 0=no null=pending */
  fgMlCorrect: tinyint("fgMlCorrect"),
  /** Model RL prediction correct: 1=yes 0=no null=pending */
  fgRlCorrect: tinyint("fgRlCorrect"),
  /** Model Total prediction correct: 1=yes 0=no null=pending */
  fgTotalCorrect: tinyint("fgTotalCorrect"),
  /** UTC ms when FG backtest was last run */
  fgBacktestRunAt: bigint("fgBacktestRunAt", { mode: "number" }),

  // ─── First Five Innings (F5) — FanDuel NJ source ────────────────────────────
  /** F5 away run line from FanDuel NJ, e.g. "-0.5" */
  f5AwayRunLine: varchar("f5AwayRunLine", { length: 8 }),
  /** F5 home run line from FanDuel NJ, e.g. "+0.5" */
  f5HomeRunLine: varchar("f5HomeRunLine", { length: 8 }),
  /** F5 away run line odds from FanDuel NJ, e.g. "+106" */
  f5AwayRunLineOdds: varchar("f5AwayRunLineOdds", { length: 16 }),
  /** F5 home run line odds from FanDuel NJ, e.g. "-138" */
  f5HomeRunLineOdds: varchar("f5HomeRunLineOdds", { length: 16 }),
  /** F5 total line from FanDuel NJ, e.g. "4.5" */
  f5Total: varchar("f5Total", { length: 8 }),
  /** F5 over odds from FanDuel NJ, e.g. "-115" */
  f5OverOdds: varchar("f5OverOdds", { length: 16 }),
  /** F5 under odds from FanDuel NJ, e.g. "-105" */
  f5UnderOdds: varchar("f5UnderOdds", { length: 16 }),
  /** F5 away ML from FanDuel NJ, e.g. "-130" */
  f5AwayML: varchar("f5AwayML", { length: 16 }),
  /** F5 home ML from FanDuel NJ, e.g. "+110" */
  f5HomeML: varchar("f5HomeML", { length: 16 }),
  /** Model projected away team score through 5 innings */
  modelF5AwayScore: decimal("modelF5AwayScore", { precision: 5, scale: 2 }),
  /** Model projected home team score through 5 innings */
  modelF5HomeScore: decimal("modelF5HomeScore", { precision: 5, scale: 2 }),
  /** Model projected F5 total (combined runs through 5 innings) */
  modelF5Total: decimal("modelF5Total", { precision: 5, scale: 1 }),
  /**
   * Model F5 over probability — **0-1 UNIT SCALE, not 0-100**.
   * Producer: mlbModelRunner.ts `p_f5_over.toFixed(4)` — no *100 anywhere.
   *
   * The "(0-100)" this comment used to claim is what caused audit M-203:
   * brierScore() believed it and divided by 100, scoring a genuine 0.52 as
   * 0.0052 and making brierF5Total garbage for the whole 2026 season.
   *
   * Widened 5,2 -> 7,4 (2026-08-08): the producer writes 4 decimals but the
   * column only held 2, so every stored value was truncated (0.5234 -> 0.52).
   *
   * Why 7,4 and not the 6,4 its sibling 0-1 probabilities (modelF5PushPct,
   * modelF5PushRaw) use: those were CREATED at 6,4, whereas this is an ALTER
   * over existing production rows. decimal(5,2) admits values up to 999.99
   * while decimal(6,4) caps at 99.9999, so 6,4 NARROWS the integer range —
   * and since this column's own doc wrongly claimed "0-100" for a season, a
   * percent-scaled value in any historical row would put the ALTER out of
   * range. 7,4 (max 999.9999) is strictly wider than the column it replaces,
   * so the migration cannot fail on data the column already holds, while
   * still fixing the truncation. Constraining the domain to [0,1] is a
   * separate concern that does not belong in a migration which can abort.
   */
  modelF5OverRate: decimal("modelF5OverRate", { precision: 7, scale: 4 }),
  /** Model F5 under probability — 0-1 UNIT SCALE. See modelF5OverRate. */
  modelF5UnderRate: decimal("modelF5UnderRate", { precision: 7, scale: 4 }),
  /** Model F5 away win probability (0-100) */
  modelF5AwayWinPct: decimal("modelF5AwayWinPct", { precision: 5, scale: 2 }),
  /** Model F5 home win probability (0-100) */
  modelF5HomeWinPct: decimal("modelF5HomeWinPct", { precision: 5, scale: 2 }),
  /** Model F5 away ML fair value odds, e.g. "-133" */
  modelF5AwayML: varchar("modelF5AwayML", { length: 16 }),
  /** Model F5 home ML fair value odds, e.g. "+113" */
  modelF5HomeML: varchar("modelF5HomeML", { length: 16 }),
  /** Model F5 away run line cover probability (0-100) */
  modelF5AwayRLCoverPct: decimal("modelF5AwayRLCoverPct", { precision: 5, scale: 2 }),
  /** Model F5 home run line cover probability (0-100) */
  modelF5HomeRLCoverPct: decimal("modelF5HomeRLCoverPct", { precision: 5, scale: 2 }),
  /** Model F5 away run line fair value odds, e.g. "-118" */
  modelF5AwayRlOdds: varchar("modelF5AwayRlOdds", { length: 16 }),
  /** Model F5 home run line fair value odds, e.g. "+104" */
  modelF5HomeRlOdds: varchar("modelF5HomeRlOdds", { length: 16 }),
  /** Model F5 over fair value odds, e.g. "-108" */
  modelF5OverOdds: varchar("modelF5OverOdds", { length: 16 }),
  /** Model F5 under fair value odds, e.g. "+108" */
  modelF5UnderOdds: varchar("modelF5UnderOdds", { length: 16 }),
  /** Model P(F5 push/tie) — three-way Bayesian-blended push probability (0-100) */
  modelF5PushPct: decimal("modelF5PushPct", { precision: 6, scale: 4 }),
  /** Raw simulation P(F5 push/tie) before Bayesian blending with empirical 15.07% (0-100, diagnostic) */
  modelF5PushRaw: decimal("modelF5PushRaw", { precision: 6, scale: 4 }),
  /** Actual away team score through 5 innings (populated after game) */
  actualF5AwayScore: int("actualF5AwayScore"),
  /** Actual home team score through 5 innings (populated after game) */
  actualF5HomeScore: int("actualF5HomeScore"),
  /** F5 ML backtest result: 'WIN' | 'LOSS' | 'PUSH' | 'PENDING' */
  f5MlResult: varchar("f5MlResult", { length: 16 }),
  /** F5 Run Line backtest result: 'WIN' | 'LOSS' | 'PUSH' | 'PENDING' */
  f5RlResult: varchar("f5RlResult", { length: 16 }),
  /** F5 Total backtest result: 'OVER' | 'UNDER' | 'PUSH' | 'PENDING' */
  f5TotalResult: varchar("f5TotalResult", { length: 16 }),
  /** Model F5 ML prediction correct: 1=yes 0=no null=pending */
  f5MlCorrect: tinyint("f5MlCorrect"),
  /** Model F5 RL prediction correct: 1=yes 0=no null=pending */
  f5RlCorrect: tinyint("f5RlCorrect"),
  /** Model F5 Total prediction correct: 1=yes 0=no null=pending */
  f5TotalCorrect: tinyint("f5TotalCorrect"),
  /** UTC ms when F5 backtest was last run */
  f5BacktestRunAt: bigint("f5BacktestRunAt", { mode: "number" }),

  // ─── NRFI / YRFI — FanDuel NJ source ────────────────────────────────────────
  /** NRFI over (no run) odds from FanDuel NJ, e.g. "-130" */
  nrfiOverOdds: varchar("nrfiOverOdds", { length: 16 }),
  /** YRFI under (yes run) odds from FanDuel NJ, e.g. "+110" */
  yrfiUnderOdds: varchar("yrfiUnderOdds", { length: 16 }),
  /**
   * Model P(NRFI) — probability no run scores in inning 1.
   * **0-1 UNIT SCALE, not 0-100.** Producer: mlbModelRunner.ts
   * `p_nrfi.toFixed(4)`. Same M-203 history and same 5,2 -> 6,4 widening as
   * modelF5OverRate; see that column for the full note, including why the
   * target is 7,4 rather than the 6,4 its siblings use.
   */
  modelPNrfi: decimal("modelPNrfi", { precision: 7, scale: 4 }),
  /** Model fair value odds for NRFI, e.g. "-143" */
  modelNrfiOdds: varchar("modelNrfiOdds", { length: 16 }),
  /** Model fair value odds for YRFI, e.g. "+121" */
  modelYrfiOdds: varchar("modelYrfiOdds", { length: 16 }),
  /** Actual result: 'NRFI' | 'YRFI' | 'PENDING' */
  nrfiActualResult: varchar("nrfiActualResult", { length: 16 }),
  /** NRFI backtest result: 'WIN' | 'LOSS' | 'PENDING' (from model perspective) */
  nrfiBacktestResult: varchar("nrfiBacktestResult", { length: 16 }),
  /** Model NRFI prediction correct: 1=yes 0=no null=pending */
  nrfiCorrect: tinyint("nrfiCorrect"),
  /** UTC ms when NRFI backtest was last run */
  nrfiBacktestRunAt: bigint("nrfiBacktestRunAt", { mode: "number" }),
  /**
   * Combined pitcher NRFI signal = (awayPitcherNrfiRate + homePitcherNrfiRate) / 2
   * Computed from 3-year empirical NRFI rates (n=5,109 games, seeded 2026-04-14).
   * Optimal filter threshold: >= 0.56 (grid search: 69.38% win rate, 32.46% ROI)
   * Null if either pitcher lacks 3yr NRFI data (< 3 starts).
   */
  nrfiCombinedSignal: double("nrfiCombinedSignal"),
  /**
   * Whether the game passes the 3yr NRFI filter (combinedSignal >= 0.56).
   * 1 = passes (strong NRFI edge), 0 = fails, null = no data.
   */
  nrfiFilterPass: tinyint("nrfiFilterPass"),

  // ─── HR Props (team-level from MLBAIModel.py) ────────────────────────────────
  /** Model P(away team hits ≥1 HR) (0-100) */
  modelAwayHrPct: decimal("modelAwayHrPct", { precision: 5, scale: 2 }),
  /** Model P(home team hits ≥1 HR) (0-100) */
  modelHomeHrPct: decimal("modelHomeHrPct", { precision: 5, scale: 2 }),
  /** Model P(both teams hit ≥1 HR) (0-100) */
  modelBothHrPct: decimal("modelBothHrPct", { precision: 5, scale: 2 }),
  /** Model expected HR count for away team */
  modelAwayExpHr: decimal("modelAwayExpHr", { precision: 4, scale: 2 }),
  /** Model expected HR count for home team */
  modelHomeExpHr: decimal("modelHomeExpHr", { precision: 4, scale: 2 }),

  // ─── Inning-by-Inning Projections (I1-I9, backtest-calibrated 2026-04-13) ────
  /**
   * JSON array [I1..I9]: expected home runs per inning from Monte Carlo simulation.
   * Backtest-calibrated weights: I1=0.1162, I2-I5=0.1085, I6-I9=0.1124 (normalized).
   * Format: number[9], e.g. [0.52, 0.49, 0.49, 0.49, 0.49, 0.50, 0.51, 0.51, 0.51]
   */
  modelInningHomeExp: text("modelInningHomeExp"),
  /**
   * JSON array [I1..I9]: expected away runs per inning from Monte Carlo simulation.
   * Format: number[9]
   */
  modelInningAwayExp: text("modelInningAwayExp"),
  /**
   * JSON array [I1..I9]: expected combined runs per inning (home + away).
   * Format: number[9]
   */
  modelInningTotalExp: text("modelInningTotalExp"),
  /**
   * JSON array [I1..I9]: P(home team scores >= 1 run) per inning.
   * Format: number[9] in [0,1]
   */
  modelInningPHomeScores: text("modelInningPHomeScores"),
  /**
   * JSON array [I1..I9]: P(away team scores >= 1 run) per inning.
   * Format: number[9] in [0,1]
   */
  modelInningPAwayScores: text("modelInningPAwayScores"),
  /**
   * JSON array [I1..I9]: P(neither team scores) per inning — NRFI probability per inning.
   * I1 value is the primary NRFI market probability (consistent with modelPNrfi).
   * Format: number[9] in [0,1]
   */
  modelInningPNeitherScores: text("modelInningPNeitherScores"),

  /**
   * Raw Monte Carlo projection total (proj_away_runs + proj_home_runs) BEFORE snapping to
   * a key number. This is the model's true expected total, distinct from modelTotal which
   * is anchored to the book O/U line for originated-line display.
   * e.g. 8.73 means the model projects 8.73 combined runs before line selection.
   * Precision 6,2 allows values like 8.73, 10.42, 6.08.
   */
  modelProjTotal: decimal("modelProjTotal", { precision: 6, scale: 2 }),

  /**
   * Weather run-factor adjustment applied by the Python engine for this game.
   * 1.0 = neutral (dome or no weather data). >1.0 = run-boosting conditions.
   * Stored for traceability and backtest analysis.
   * Precision 5,4 allows values like 1.0120, 0.9880.
   */
  modelWeatherAdj: decimal("modelWeatherAdj", { precision: 5, scale: 4 }),

  /**
   * Tracks the source of the current primary book columns (awayBookSpread, homeBookSpread,
   * bookTotal, awayML, homeML, awaySpreadOdds, homeSpreadOdds, overOdds, underOdds).
   *
   * 'open' — All 9 primary fields are sourced from the AN Opening line (DK not yet fully posted)
   * 'dk'   — All 3 DK NJ markets complete (spread+odds, total+odds, ML) — using DK for all 9 fields
   * Never null, never partial. Every game always has either DK or Open.
   */
  oddsSource: mysqlEnum("oddsSource", ["open", "dk"]),

  // ─── Evidence Provenance Lifecycle (Phase 1 observability) ────────────────
  /**
   * Provider-authored observation time for the current dynamic market record.
   * Null means no authoritative provider timestamp was persisted. Never
   * substitute retrieval time, request time, or modelRunAt.
   */
  providerObservedAt: timestamp("provider_observed_at", { fsp: 3 }),
  /**
   * Provider/source last-update time when it is distinct from the observation
   * time. Null means the source did not supply an authoritative update time.
   */
  sourceUpdatedAt: timestamp("source_updated_at", { fsp: 3 }),
  /** Time the ingestion boundary received the provider record. */
  ingestionReceivedAt: timestamp("ingestion_received_at", { fsp: 3 }),
  /** Time the record completed deterministic normalization. */
  ingestionNormalizedAt: timestamp("ingestion_normalized_at", { fsp: 3 }),
  /** Time the normalized record was durably persisted. */
  ingestionPersistedAt: timestamp("ingestion_persisted_at", { fsp: 3 }),
  /** Immutable revision of the ingestion pipeline that produced the row. */
  ingestionPipelineRevision: varchar("ingestion_pipeline_revision", {
    length: 160,
  }),
  /** Stable identifier for the ingestion run that produced the row. */
  ingestionRunId: varchar("ingestion_run_id", { length: 160 }),

  // ─── Outcome Ingestion + Brier Scores (populated by mlbOutcomeIngestor after game final) ──
  /**
   * Actual full-game total runs (awayFinalScore + homeFinalScore).
   * Populated by mlbOutcomeIngestor.ts after gameStatus = 'final'.
   * Used for Brier score computation and rolling f5_share drift detection.
   * Precision 5,1 matches actualAwayScore + actualHomeScore (both int, sum ≤ 99.0).
   */
  actualFgTotal: decimal("actualFgTotal", { precision: 5, scale: 1 }),
  /**
   * Actual F5 total runs (actualF5AwayScore + actualF5HomeScore).
   * Populated by mlbOutcomeIngestor.ts after game is final.
   * Used for rolling f5_share = actualF5Total / actualFgTotal drift detection.
   * Precision 5,1 matches F5 score fields.
   */
  actualF5Total: decimal("actualF5Total", { precision: 5, scale: 1 }),
  /**
   * Actual NRFI result: 1 = no run scored in inning 1, 0 = at least one run scored.
   * Populated by mlbOutcomeIngestor.ts from MLB Stats API linescore.innings[0].
   * Null = game not yet final or linescore unavailable.
   */
  actualNrfiBinary: tinyint("actualNrfiBinary"),
  /**
   * Brier score for FG Total prediction: (p_over - outcome_over)^2
   * p_over = modelFgOverRate / 100 (model probability of over)
   * outcome_over = 1 if actualFgTotal > bookTotal, 0 if under, null if push/no-line
   * Range [0, 1]. Lower = better calibration. Null if bookTotal or scores unavailable.
   */
  brierFgTotal: decimal("brierFgTotal", { precision: 7, scale: 6 }),
  /**
   * Brier score for F5 Total prediction: (p_f5_over - outcome_f5_over)^2
   * p_f5_over = modelF5OverRate  (ALREADY 0-1 — do NOT divide by 100)
   *   Corrected 2026-08-07 (audit M-203). This line used to read "/ 100" and
   *   the runtime obeyed it, scoring a genuine 0.52 as 0.0052. The producer is
   *   mlbModelRunner.ts:4259 `p_f5_over.toFixed(4)` — no *100 anywhere.
   *   KNOWN, NOT FIXED HERE: the column is decimal(5,2), so a 0-1 value is
   *   truncated to 2 dp (0.5234 -> 0.52). Widening it is a migration and must
   *   ride db-push.yml; tracked as F-3 in phase0/f5.md.
   * outcome_f5_over = 1 if actualF5Total > bookF5Total, 0 if under, null if push/no-line
   * Range [0, 1]. Lower = better calibration. Null if F5 book total or scores unavailable.
   */
  brierF5Total: decimal("brierF5Total", { precision: 7, scale: 6 }),
  /**
   * Brier score for NRFI prediction: (p_nrfi - outcome_nrfi)^2
   * p_nrfi = modelPNrfi  (ALREADY 0-1 — do NOT divide by 100)
   *   Corrected 2026-08-07 (audit M-203); producer mlbModelRunner.ts:4284
   *   `p_nrfi.toFixed(4)`. Same decimal(5,2) truncation caveat as above.
   * outcome_nrfi = actualNrfiBinary (1 = NRFI, 0 = YRFI)
   * Range [0, 1]. Lower = better calibration. Null if modelPNrfi or linescore unavailable.
   */
  brierNrfi: decimal("brierNrfi", { precision: 7, scale: 6 }),
  /**
   * Brier score for FG ML prediction: (p_home_win - outcome_home_win)^2
   * p_home_win = modelHomeWinPct / 100
   * outcome_home_win = 1 if actualHomeScore > actualAwayScore, 0 if home lost, null if tie
   * Range [0, 1]. Null if modelHomeWinPct or final scores unavailable.
   */
  brierFgMl: decimal("brierFgMl", { precision: 7, scale: 6 }),
  /**
   * Brier score for F5 ML prediction: (p_f5_home_win - outcome_f5_home_win)^2
   * p_f5_home_win = modelF5HomeWinPct / 100
   * outcome_f5_home_win = 1 if actualF5HomeScore > actualF5AwayScore, 0 if away led, null if tie
   * Range [0, 1]. Null if modelF5HomeWinPct or F5 scores unavailable.
   */
  brierF5Ml: decimal("brierF5Ml", { precision: 7, scale: 6 }),
  /**
   * UTC ms when mlbOutcomeIngestor last populated this game's outcome fields.
   * Null = not yet ingested. Used to skip re-ingestion of already-complete games.
   * Set on every successful ingestion run (even if scores were already present).
   */
  outcomeIngestedAt: bigint("outcomeIngestedAt", { mode: "number" }),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  /**
   * Prevent duplicate rows for the same matchup on the same date.
   * NOTE (doubleheader contract): gameNumber is part of this key, so two
   * same-day games coexist ONLY when their gameNumbers differ. Ingestion must
   * therefore always resolve gameNumber from provider identity (see
   * mlbEventIdentity.planMlbScheduleSync) — an insert that leaves the default
   * gameNumber=1 for a second same-matchup game collides here and is swallowed
   * by upsert paths (the 2026-07-17 TB@BOS incident class).
   */
  uniqMatchup: uniqueIndex("games_matchup_unique").on(t.gameDate, t.awayTeam, t.homeTeam, t.gameNumber),
  /**
   * Canonical provider identity: at most ONE row per MLB gamePk. Multiple
   * NULLs are permitted by MySQL/TiDB unique-index semantics (non-MLB sports
   * and pre-identity legacy rows). This is the database-level guarantee that
   * two distinct provider events can never merge and one event can never
   * occupy two rows.
   * PRE-DEPLOY CHECK (run before db-push; must return 0 rows):
   *   SELECT mlbGamePk, COUNT(*) c FROM games
   *    WHERE mlbGamePk IS NOT NULL GROUP BY mlbGamePk HAVING c > 1;
   */
  uniqMlbGamePk: uniqueIndex("games_mlb_gamepk_unique").on(t.mlbGamePk),
  /**
   * Composite index for the primary feed query pattern:
   *   WHERE sport = ? AND gameDate >= ? AND gameDate <= ? AND gameStatus != 'postponed'
   * Eliminates the IndexLookUp+TableRowIDScan double-read on the 7,730-row games table.
   * Without this index, every games.list call does a full index scan on games_matchup_unique
   * then a separate TableRowIDScan to filter by sport+gameStatus — ~100ms per query.
   * With this index, TiKV can satisfy the entire WHERE clause from one index range scan.
   */
  idxSportDate: index("idx_games_sport_date_status").on(t.sport, t.gameDate, t.gameStatus),
}));

export type Game = typeof games.$inferSelect;
export type InsertGame = typeof games.$inferInsert;

// ─── NBA Teams (seeded from NBA Mapping master sheet) ───────────────────────

export const nbaTeams = mysqlTable("nba_teams", {
  id: int("id").autoincrement().primaryKey(),
  /** DB storage key — vsinSlug with hyphens replaced by underscores, e.g. "boston_celtics" */
  dbSlug: varchar("dbSlug", { length: 128 }).notNull().unique(),
  /** NBA.com short slug, e.g. "celtics" */
  nbaSlug: varchar("nbaSlug", { length: 64 }).notNull().unique(),
  /** VSiN href slug, e.g. "boston-celtics" */
  vsinSlug: varchar("vsinSlug", { length: 128 }).notNull().unique(),
  /** Full team name, e.g. "Boston Celtics" */
  name: varchar("name", { length: 255 }).notNull(),
  /** Team nickname, e.g. "Celtics" */
  nickname: varchar("nickname", { length: 128 }).notNull(),
  /** City name, e.g. "Boston" */
  city: varchar("city", { length: 128 }).notNull(),
  /** Conference: "East" or "West" */
  conference: varchar("conference", { length: 16 }).notNull(),
  /** Division, e.g. "Atlantic" */
  division: varchar("division", { length: 64 }).notNull(),
  /** NBA.com CDN SVG logo URL */
  logoUrl: text("logoUrl").notNull(),
  /** Standard NBA abbreviation, e.g. "BOS", "LAL", "GSW" */
  abbrev: varchar("abbrev", { length: 8 }),
  /** Primary brand hex color, e.g. "#007A33" */
  primaryColor: varchar("primaryColor", { length: 16 }),
  /** Secondary brand hex color */
  secondaryColor: varchar("secondaryColor", { length: 16 }),
  /** Tertiary brand hex color */
  tertiaryColor: varchar("tertiaryColor", { length: 16 }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type NbaTeamRow = typeof nbaTeams.$inferSelect;
export type InsertNbaTeam = typeof nbaTeams.$inferInsert;

// ─── NCAAM Teams (seeded from NCAAM Mapping master sheet) ───────────────────

export const ncaamTeams = mysqlTable("ncaam_teams", {
  id: int("id").autoincrement().primaryKey(),
  /** DB storage key — vsinSlug with hyphens replaced by underscores, e.g. "arkansas" */
  dbSlug: varchar("dbSlug", { length: 128 }).notNull().unique(),
  /** NCAA.com seoname slug, e.g. "arkansas" */
  ncaaSlug: varchar("ncaaSlug", { length: 128 }).notNull().unique(),
  /** VSiN href slug, e.g. "arkansas" */
  vsinSlug: varchar("vsinSlug", { length: 128 }).notNull().unique(),
  /** Full school name, e.g. "Arkansas" */
  ncaaName: varchar("ncaaName", { length: 255 }).notNull(),
  /** Team nickname, e.g. "Razorbacks" */
  ncaaNickname: varchar("ncaaNickname", { length: 128 }).notNull(),
  /** VSiN display name */
  vsinName: varchar("vsinName", { length: 255 }).notNull(),
  /** Conference, e.g. "SEC" */
  conference: varchar("conference", { length: 128 }).notNull(),
  /** NCAA.com SVG logo URL */
  logoUrl: text("logoUrl").notNull(),
  /** KenPom.com team name for team.php?team= lookups, e.g. "Duke", "VCU", "Prairie View A&M" */
  kenpomSlug: varchar("kenpomSlug", { length: 255 }),
  /** Short abbreviation used by NCAA/VSiN, e.g. "DUKE", "UNC", "GONZ" */
  abbrev: varchar("abbrev", { length: 16 }),
  /** Primary brand hex color, e.g. "#9D2235" */
  primaryColor: varchar("primaryColor", { length: 16 }),
  /** Secondary brand hex color */
  secondaryColor: varchar("secondaryColor", { length: 16 }),
  /** Tertiary brand hex color */
  tertiaryColor: varchar("tertiaryColor", { length: 16 }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type NcaamTeamRow = typeof ncaamTeams.$inferSelect;
export type InsertNcaamTeam = typeof ncaamTeams.$inferInsert;

// ─── NHL Teams (seeded from NHL.com + VSiN mapping) ────────────────────────────

export const nhlTeams = mysqlTable("nhl_teams", {
  id: int("id").autoincrement().primaryKey(),
  /** DB storage key — vsinSlug with hyphens replaced by underscores, e.g. "buffalo_sabres" */
  dbSlug: varchar("dbSlug", { length: 128 }).notNull().unique(),
  /** NHL.com URL slug, e.g. "buffalo-sabres" */
  nhlSlug: varchar("nhlSlug", { length: 128 }).notNull().unique(),
  /** VSiN href slug, e.g. "buffalo-sabres" (special: "ny-islanders" for NYI) */
  vsinSlug: varchar("vsinSlug", { length: 128 }).notNull().unique(),
  /** Full team name, e.g. "Buffalo Sabres" */
  name: varchar("name", { length: 255 }).notNull(),
  /** Team nickname, e.g. "Sabres" */
  nickname: varchar("nickname", { length: 128 }).notNull(),
  /** City name, e.g. "Buffalo" */
  city: varchar("city", { length: 128 }).notNull(),
  /** Conference: "EASTERN" or "WESTERN" */
  conference: mysqlEnum("conference", ["EASTERN", "WESTERN"]).notNull(),
  /** Division: "ATLANTIC", "METROPOLITAN", "CENTRAL", or "PACIFIC" */
  division: mysqlEnum("division", ["ATLANTIC", "METROPOLITAN", "CENTRAL", "PACIFIC"]).notNull(),
  /** NHL.com CDN SVG logo URL, e.g. "https://assets.nhle.com/logos/nhl/svg/BUF_dark.svg" */
  logoUrl: text("logoUrl").notNull(),
  /** Standard NHL abbreviation, e.g. "BUF", "TBL", "VGK" */
  abbrev: varchar("abbrev", { length: 8 }).notNull(),
  /** Primary brand hex color, e.g. "#003087" */
  primaryColor: varchar("primaryColor", { length: 16 }).notNull(),
  /** Secondary brand hex color */
  secondaryColor: varchar("secondaryColor", { length: 16 }).notNull(),
  /** Tertiary brand hex color */
  tertiaryColor: varchar("tertiaryColor", { length: 16 }).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type NhlTeamRow = typeof nhlTeams.$inferSelect;
export type InsertNhlTeam = typeof nhlTeams.$inferInsert;

// ─── MLB Teams (seeded from MLB.com + VSiN + Action Network mapping) ─────────────
export const mlbTeams = mysqlTable("mlb_teams", {
  id: int("id").autoincrement().primaryKey(),
  /** DB storage key — vsinSlug (single-word), e.g. "yankees", "redsox", "bluejays" */
  dbSlug: varchar("dbSlug", { length: 128 }).notNull().unique(),
  /** MLB Stats API numeric team ID, e.g. 147 for Yankees */
  mlbId: int("mlbId").notNull().unique(),
  /** MLB.com internal 3-letter team code, e.g. "nya", "lan" */
  mlbCode: varchar("mlbCode", { length: 8 }).notNull().unique(),
  /** Standard MLB abbreviation, e.g. "NYY", "LAD", "CWS" */
  abbrev: varchar("abbrev", { length: 8 }).notNull().unique(),
  /** VSiN href slug (single-word), e.g. "yankees", "redsox", "dbacks" */
  vsinSlug: varchar("vsinSlug", { length: 128 }).notNull().unique(),
  /** Action Network URL slug, e.g. "new-york-yankees" */
  anSlug: varchar("anSlug", { length: 128 }).notNull().unique(),
  /** Action Network logo slug for sprtactn.co CDN, e.g. "nyyd", "ladd", "mia_n" */
  anLogoSlug: varchar("anLogoSlug", { length: 32 }).notNull(),
  /** Baseball Reference team abbreviation — may differ from standard abbrev (e.g. "KCR", "TBD", "FLA", "OAK") */
  brAbbrev: varchar("brAbbrev", { length: 8 }).notNull().unique(),
  /** Full team name, e.g. "New York Yankees" */
  name: varchar("name", { length: 255 }).notNull(),
  /** Team nickname, e.g. "Yankees", "Blue Jays", "D-backs" */
  nickname: varchar("nickname", { length: 128 }).notNull(),
  /** City/region name, e.g. "New York", "Tampa Bay", "Arizona" */
  city: varchar("city", { length: 128 }).notNull(),
  /** League: "AL" or "NL" */
  league: mysqlEnum("league", ["AL", "NL"]).notNull(),
  /** Division: "East", "Central", or "West" */
  division: mysqlEnum("division", ["East", "Central", "West"]).notNull(),
  /** Official MLB.com SVG logo URL, e.g. "https://www.mlbstatic.com/team-logos/147.svg" */
  logoUrl: text("logoUrl").notNull(),
  /** Primary brand hex color, e.g. "#003087" */
  primaryColor: varchar("primaryColor", { length: 16 }),
  /** Secondary brand hex color */
  secondaryColor: varchar("secondaryColor", { length: 16 }),
  /** Tertiary brand hex color */
  tertiaryColor: varchar("tertiaryColor", { length: 16 }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type MlbTeamRow = typeof mlbTeams.$inferSelect;
export type InsertMlbTeam = typeof mlbTeams.$inferInsert;

// ─── MLB Players (active roster mapped to current teams via Baseball Reference) ──────
export const mlbPlayers = mysqlTable("mlb_players", {
  id: int("id").autoincrement().primaryKey(),
  /**
   * Baseball Reference player ID, e.g. "judgeaa01", "harpebr03".
   * Format: first 5 chars of last name + first 2 chars of first name + 2-digit sequence.
   * URL: https://www.baseball-reference.com/players/{letter}/{brId}.shtml
   */
  brId: varchar("brId", { length: 32 }).notNull().unique(),
  /** MLB Advanced Media (MLBAM) numeric player ID — used for headshot URLs */
  mlbamId: int("mlbamId"),
  /** Full display name, e.g. "Aaron Judge" */
  name: varchar("name", { length: 255 }).notNull(),
  /** Primary position, e.g. "Pitcher", "Catcher", "Outfielder", "Shortstop" */
  position: varchar("position", { length: 64 }),
  /** Bats: "R", "L", or "S" (switch) */
  bats: varchar("bats", { length: 4 }),
  /** Throws: "R" or "L" */
  throws: varchar("throws", { length: 4 }),
  /**
   * Baseball Reference team abbreviation of current team.
   * FK reference to mlb_teams.brAbbrev.
   * e.g. "NYY", "ATL", "KCR", "TBD"
   */
  currentTeamBrAbbrev: varchar("currentTeamBrAbbrev", { length: 8 }),
  /** Whether this player is currently on an active MLB roster */
  isActive: boolean("isActive").notNull().default(true),
  // ── Statcast 2025 season metrics (Baseball Savant leaderboard, min 50 PA) ──
  /** Isolated power (SLG - AVG) — primary per-player HR power indicator */
  iso: double("iso"),
  /** Barrel rate (%) — % of batted balls classified as barrels (EV ≥ 98 mph, LA 26–30°) */
  barrelPct: double("barrelPct"),
  /** Hard-hit rate (%) — % of batted balls with exit velocity ≥ 95 mph */
  hardHitPct: double("hardHitPct"),
  /** Expected slugging percentage based on exit velocity + launch angle */
  xSlg: double("xSlg"),
  /** UTC timestamp (ms) when Statcast data was last fetched from Baseball Savant */
  statcastFetchedAt: bigint("statcastFetchedAt", { mode: "number" }),
  /** UTC timestamp (ms) when this record was last synced from Baseball Reference */
  lastSyncedAt: bigint("lastSyncedAt", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type MlbPlayerRow = typeof mlbPlayers.$inferSelect;
export type InsertMlbPlayer = typeof mlbPlayers.$inferInsert;

// ─── Odds History (per-game DK NJ line snapshots from AN API) ───────────────────

export const oddsHistory = mysqlTable("odds_history", {
  id: int("id").autoincrement().primaryKey(),
  /** FK → games.id */
  gameId: int("gameId").notNull(),
  /** Sport: NCAAM, NBA, NHL */
  sport: varchar("sport", { length: 16 }).notNull(),
  /**
   * UTC timestamp (ms) when this snapshot was captured.
   * Stored as bigint so it survives timezone conversions cleanly.
   * Display in EST: new Date(scrapedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })
   */
  scrapedAt: bigint("scrapedAt", { mode: "number" }).notNull(),
  /** Source: 'auto' (hourly cron) or 'manual' (Refresh Now button) */
  source: mysqlEnum("source", ["auto", "manual"]).notNull().default("auto"),
  /**
   * Odds line source for this snapshot.
   * 'open' — All lines in this snapshot are from the AN Opening line (DK not yet fully posted)
   * 'dk'   — All lines are from DK NJ current market (all 3 markets complete)
   * Never null, never partial.
   */
  lineSource: mysqlEnum("lineSource", ["open", "dk"]),
  // ── DK NJ Spread snapshot ──
  awaySpread: varchar("awaySpread", { length: 16 }),
  awaySpreadOdds: varchar("awaySpreadOdds", { length: 16 }),
  homeSpread: varchar("homeSpread", { length: 16 }),
  homeSpreadOdds: varchar("homeSpreadOdds", { length: 16 }),
  // ── DK NJ Total snapshot ──
  total: varchar("total", { length: 16 }),
  overOdds: varchar("overOdds", { length: 16 }),
  underOdds: varchar("underOdds", { length: 16 }),
  // ── DK NJ Moneyline snapshot ──
  awayML: varchar("awayML", { length: 16 }),
  homeML: varchar("homeML", { length: 16 }),
  // ── VSIN Betting Splits snapshot (all three sports) ──
  // Spread / Run Line / Puck Line splits
  spreadAwayBetsPct: tinyint("spreadAwayBetsPct"),
  spreadAwayMoneyPct: tinyint("spreadAwayMoneyPct"),
  // Total splits (over side)
  totalOverBetsPct: tinyint("totalOverBetsPct"),
  totalOverMoneyPct: tinyint("totalOverMoneyPct"),
  // Moneyline splits
  mlAwayBetsPct: tinyint("mlAwayBetsPct"),
  mlAwayMoneyPct: tinyint("mlAwayMoneyPct"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type OddsHistoryRow = typeof oddsHistory.$inferSelect;
export type InsertOddsHistory = typeof oddsHistory.$inferInsert;

// ─── MLB Lineups (Rotowire daily lineups + weather) ────────────────────────────

/**
 * One row per game per scrape cycle.
 * awayLineup / homeLineup are JSON arrays of LineupPlayer objects:
 *   [{ battingOrder: 1, position: "CF", name: "Aaron Judge", bats: "R", mlbamId: 592450 }, ...]
 * Pitcher fields store the confirmed/probable starter for each side.
 */
export const mlbLineups = mysqlTable("mlb_lineups", {
  id: int("id").autoincrement().primaryKey(),
  /** FK → games.id */
  gameId: int("gameId").notNull().unique(),
  /** UTC timestamp (ms) when Rotowire was last scraped for this game */
  scrapedAt: bigint("scrapedAt", { mode: "number" }).notNull(),
  // ── Away pitcher ──
  awayPitcherName: varchar("awayPitcherName", { length: 128 }),
  awayPitcherHand: varchar("awayPitcherHand", { length: 4 }),
  awayPitcherEra: varchar("awayPitcherEra", { length: 32 }),
  /** Rotowire internal player ID (from /baseball/player.php?id=NNNNN) */
  awayPitcherRotowireId: int("awayPitcherRotowireId"),
  /** MLB Stats API MLBAM person ID (for headshot URLs) */
  awayPitcherMlbamId: int("awayPitcherMlbamId"),
  awayPitcherConfirmed: boolean("awayPitcherConfirmed").default(false),
  // ── Home pitcher ──
  homePitcherName: varchar("homePitcherName", { length: 128 }),
  homePitcherHand: varchar("homePitcherHand", { length: 4 }),
  homePitcherEra: varchar("homePitcherEra", { length: 32 }),
  /** Rotowire internal player ID (from /baseball/player.php?id=NNNNN) */
  homePitcherRotowireId: int("homePitcherRotowireId"),
  /** MLB Stats API MLBAM person ID (for headshot URLs) */
  homePitcherMlbamId: int("homePitcherMlbamId"),
  homePitcherConfirmed: boolean("homePitcherConfirmed").default(false),
  // ── Batting lineups (JSON arrays) ──
  /** JSON: LineupPlayer[] for away team, batting order 1-9 */
  awayLineup: text("awayLineup"),
  /** JSON: LineupPlayer[] for home team, batting order 1-9 */
  homeLineup: text("homeLineup"),
  awayLineupConfirmed: boolean("awayLineupConfirmed").default(false),
  homeLineupConfirmed: boolean("homeLineupConfirmed").default(false),
  // ── Weather ──
  weatherIcon: varchar("weatherIcon", { length: 8 }),
  weatherTemp: varchar("weatherTemp", { length: 16 }),
  weatherWind: varchar("weatherWind", { length: 64 }),
  weatherPrecip: int("weatherPrecip"),
  weatherDome: boolean("weatherDome").default(false),
  // ── Umpire ──
  umpire: varchar("umpire", { length: 128 }),
  // ── Lineup change-detection & model-trigger tracking ──────────────────────
  /**
   * SHA-256 fingerprint of the current lineup state:
   *   SHA256(awayPitcherName|homePitcherName|awayLineup_JSON|homeLineup_JSON)
   * Changes whenever any pitcher or batting order slot changes.
   * Used by the LineupWatcher to detect changes without full row comparison.
   * Null = no lineup data yet (no pitchers, no batting orders).
   */
  lineupHash: varchar("lineupHash", { length: 64 }),
  /**
   * Monotonically increasing version counter.
   * Starts at 1 on first insert with lineup data, increments on every detected hash change.
   * Provides an audit trail of how many times the lineup changed before game time.
   */
  lineupVersion: int("lineupVersion").default(0).notNull(),
  /**
   * UTC timestamp (ms) when the model last ran for this lineup via the watcher.
   * Null = model has never been triggered by the watcher for this game.
   */
  lineupModeledAt: bigint("lineupModeledAt", { mode: "number" }),
  /**
   * The lineupVersion that was last passed to the model.
   * When lineupVersion > lineupModeledVersion: watcher triggers a re-model.
   * When lineupVersion === lineupModeledVersion: no re-model needed.
   * Starts at 0 (never modeled).
   */
  lineupModeledVersion: int("lineupModeledVersion").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type MlbLineupRow = typeof mlbLineups.$inferSelect;
export type InsertMlbLineup = typeof mlbLineups.$inferInsert;

/** Shape of each player entry stored in awayLineup / homeLineup JSON columns */
export interface LineupPlayer {
  battingOrder: number;
  position: string;
  name: string;
  bats: string; // 'R' | 'L' | 'S'
  /** Rotowire internal player ID (from /baseball/player.php?id=NNNNN) */
  rotowireId: number | null;
  /** MLB Stats API MLBAM person ID (for headshot URLs) — resolved separately */
  mlbamId: number | null;
}

// ─── User Favorite Games ─────────────────────────────────────────────────────
export const userFavoriteGames = mysqlTable(
  "user_favorite_games",
  {
    id: int("id").autoincrement().primaryKey(),
    /** The app_user who favorited the game */
    appUserId: int("appUserId").notNull(),
    /** The game id being favorited */
    gameId: int("gameId").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("user_game_uniq").on(t.appUserId, t.gameId),
  })
);
export type UserFavoriteGame = typeof userFavoriteGames.$inferSelect;
export type InsertUserFavoriteGame = typeof userFavoriteGames.$inferInsert;

// ─── MLB Strikeout Props ──────────────────────────────────────────────────────
/**
 * One row per pitcher per game.
 * Stores the StrikeoutModel.py output for each starting pitcher.
 * signalBreakdown and matchupRows are JSON blobs.
 * Completely isolated from the game model projections (games table).
 */
export const mlbStrikeoutProps = mysqlTable("mlb_strikeout_props", {
  id: int("id").autoincrement().primaryKey(),
  /** FK → games.id */
  gameId: int("gameId").notNull(),
  /** 'away' | 'home' */
  side: varchar("side", { length: 8 }).notNull(),
  /** Pitcher full name, e.g. "Max Fried" */
  pitcherName: varchar("pitcherName", { length: 128 }).notNull(),
  /** Pitcher hand: 'L' | 'R' */
  pitcherHand: varchar("pitcherHand", { length: 4 }),
  /** Retrosheet ID, e.g. "friem001" */
  retrosheetId: varchar("retrosheetId", { length: 32 }),
  /** MLBAM player ID for headshot */
  mlbamId: int("mlbamId"),
  /** Model projected strikeout total (float, e.g. "4.73") */
  kProj: varchar("kProj", { length: 16 }),
  /** Model recommended line (e.g. "4.5") */
  kLine: varchar("kLine", { length: 16 }),
  /** K per 9 innings */
  kPer9: varchar("kPer9", { length: 16 }),
  /** Median of distribution */
  kMedian: varchar("kMedian", { length: 16 }),
  /** 5th percentile */
  kP5: varchar("kP5", { length: 16 }),
  /** 95th percentile */
  kP95: varchar("kP95", { length: 16 }),
  /** Book line (e.g. "4.5") */
  bookLine: varchar("bookLine", { length: 16 }),
  /** Book over odds (e.g. "-152") */
  bookOverOdds: varchar("bookOverOdds", { length: 16 }),
  /** Book under odds (e.g. "+115") */
  bookUnderOdds: varchar("bookUnderOdds", { length: 16 }),
  /** P(over book line) as decimal string, e.g. "0.499" */
  pOver: varchar("pOver", { length: 16 }),
  /** P(under book line) as decimal string, e.g. "0.501" */
  pUnder: varchar("pUnder", { length: 16 }),
  /** American odds for over implied by model, e.g. "+100" */
  modelOverOdds: varchar("modelOverOdds", { length: 16 }),
  /** American odds for under implied by model, e.g. "-100" */
  modelUnderOdds: varchar("modelUnderOdds", { length: 16 }),
  /** Edge on over (decimal string), e.g. "-0.012" */
  edgeOver: varchar("edgeOver", { length: 16 }),
  /** Edge on under (decimal string), e.g. "+0.012" */
  edgeUnder: varchar("edgeUnder", { length: 16 }),
  /** Best side: 'OVER' | 'UNDER' | 'PASS' */
  verdict: varchar("verdict", { length: 32 }),
  /** Best edge value (decimal string) */
  bestEdge: varchar("bestEdge", { length: 16 }),
  /** Best side label: 'OVER' | 'UNDER' */
  bestSide: varchar("bestSide", { length: 16 }),
  /** Best side ML string, e.g. "+115" */
  bestMlStr: varchar("bestMlStr", { length: 16 }),
  /** JSON: { platoon, ha, tto, whiff, zone, arsenal } signal breakdown */
  signalBreakdown: text("signalBreakdown"),
  /** JSON: array of { spot, name, bats, kRate, adj, expK } for opposing lineup */
  matchupRows: text("matchupRows"),
  /** JSON: { bins: number[], probs: number[] } distribution */
  distribution: text("distribution"),
  /** JSON: { inn: number, expK: number }[] inning breakdown */
  inningBreakdown: text("inningBreakdown"),
  /** UTC timestamp (ms) when model was run */
  modelRunAt: bigint("modelRunAt", { mode: "number" }),
  /** AN no-vig probability for the over (decimal string, e.g. "0.432") */
  anNoVigOverPct: varchar("anNoVigOverPct", { length: 16 }),
  /** AN player ID for this pitcher */
  anPlayerId: int("anPlayerId"),
  /** Actual strikeouts thrown (populated after game completes) */
  actualKs: int("actualKs"),
  /** Backtest result: 'OVER' | 'UNDER' | 'PUSH' | 'PENDING' | 'NO_LINE' */
  backtestResult: varchar("backtestResult", { length: 16 }),
  /** Model error vs actual (actualKs - kProj, decimal string) */
  modelError: varchar("modelError", { length: 16 }),
  /** Whether model prediction matched result: 1=correct, 0=incorrect, null=pending */
  modelCorrect: tinyint("modelCorrect"),
  /** UTC timestamp (ms) when backtest was last run */
  backtestRunAt: bigint("backtestRunAt", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  /** One row per (game, side) — upsert on this key */
  uqGameSide: uniqueIndex("uq_game_side").on(t.gameId, t.side),
}));
export type MlbStrikeoutPropRow = typeof mlbStrikeoutProps.$inferSelect;
export type InsertMlbStrikeoutProp = typeof mlbStrikeoutProps.$inferInsert;

// ─── MLB Pitcher Season Stats ─────────────────────────────────────────────────
/**
 * One row per pitcher (upserted by mlbamId + teamAbbrev).
 * Populated from MLB Stats API 2025 season stats.
 * Used by mlbModelRunner.ts to feed real stats into the engine.
 */
export const mlbPitcherStats = mysqlTable("mlb_pitcher_stats", {
  id: int("id").autoincrement().primaryKey(),
  /** MLB Stats API player ID */
  mlbamId: int("mlbamId").notNull(),
  /** Full name exactly as returned by MLB Stats API, e.g. "Gerrit Cole" */
  fullName: varchar("fullName", { length: 128 }).notNull(),
  /** Team abbreviation matching mlbModelRunner TEAM_STATS_2025 keys, e.g. "NYY" */
  teamAbbrev: varchar("teamAbbrev", { length: 8 }).notNull(),
  /** ERA (float) */
  era: double("era"),
  /** Strikeouts per 9 innings */
  k9: double("k9"),
  /** Walks per 9 innings */
  bb9: double("bb9"),
  /** Home runs per 9 innings */
  hr9: double("hr9"),
  /** WHIP */
  whip: double("whip"),
  /** Innings pitched (float, e.g. 162.1) */
  ip: double("ip"),
  /** Games started */
  gamesStarted: int("gamesStarted"),
  /** Games played */
  gamesPlayed: int("gamesPlayed"),
  /** xERA proxy (if available, else null) */
  xera: double("xera"),
  /** FIP (Fielding Independent Pitching) from MLB sabermetrics endpoint */
  fip: double("fip"),
  /** xFIP (Expected FIP, normalizes HR/FB rate) from MLB sabermetrics endpoint */
  xfip: double("xfip"),
  /** FIP- (FIP relative to league average, 100=avg, lower=better) */
  fipMinus: double("fipMinus"),
  /** ERA- (ERA relative to league average, 100=avg, lower=better) */
  eraMinus: double("eraMinus"),
  /** Pitcher WAR from MLB sabermetrics endpoint */
  war: double("war"),
  /** Pitcher throwing hand: 'R' = right, 'L' = left, 'S' = switch */
  throwsHand: varchar("throwsHand", { length: 1 }),
  /** UTC timestamp (ms) when stats were last fetched */
  lastFetchedAt: bigint("lastFetchedAt", { mode: "number" }),

  // ─── 3-Year Rolling NRFI Calibration Fields (seeded from 3yr backtest) ──────
  /** Total starts in 3yr NRFI sample (2024+2025+2026) */
  nrfiStarts: int("nrfiStarts"),
  /** Number of starts where inning 1 was scoreless (NRFI) */
  nrfiCount: int("nrfiCount"),
  /** NRFI rate = nrfiCount / nrfiStarts (0.0–1.0, 4 decimal places) */
  nrfiRate: double("nrfiRate"),
  /** Mean F5 runs allowed per start over 3yr sample */
  f5RunsAllowedMean: double("f5RunsAllowedMean"),
  /** Mean full-game runs allowed per start over 3yr sample */
  fgRunsAllowedMean: double("fgRunsAllowedMean"),
  /** Mean innings pitched per start over 3yr sample */
  ipMean3yr: double("ipMean3yr"),
  /** Comma-separated list of seasons included in NRFI sample, e.g. '2024,2025,2026' */
  nrfiSampleSeasons: varchar("nrfiSampleSeasons", { length: 32 }),
  /** Calibration version tag, e.g. '2026-04-14-3yr-v1' */
  nrfiCalibVersion: varchar("nrfiCalibVersion", { length: 32 }),
  /** UTC ms when 3yr NRFI data was last seeded */
  nrfiSeededAt: bigint("nrfiSeededAt", { mode: "number" }),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  /** Upsert key: one row per pitcher per team */
  uqPitcherTeam: uniqueIndex("uq_pitcher_team").on(t.mlbamId, t.teamAbbrev),
  /** Name lookup index */
  idxFullName: index("idx_pitcher_full_name").on(t.fullName),
}));
export type MlbPitcherStatRow = typeof mlbPitcherStats.$inferSelect;
export type InsertMlbPitcherStat = typeof mlbPitcherStats.$inferInsert;

// ─── MLB Team Batting Splits (vs LHP / vs RHP) ───────────────────────────────
/**
 * One row per (teamAbbrev, hand) where hand ∈ {'L','R'}.
 * Populated from MLB Stats API statSplits endpoint (sitCodes=vl,vr).
 * Used by mlbModelRunner.ts to adjust expected run scoring based on
 * the opposing starter's throwing hand.
 *
 * Key stats:
 *   avg / obp / slg / ops — slash line vs that pitcher hand
 *   hr9  — home runs per 9 innings (derived: HR / AB * 27)
 *   bb9  — walks per 9 innings
 *   k9   — strikeouts per 9 innings
 *   woba — weighted on-base average (derived from component stats)
 */
export const mlbTeamBattingSplits = mysqlTable("mlb_team_batting_splits", {
  id: int("id").autoincrement().primaryKey(),
  /** Team abbreviation matching TEAM_STATS_2025 keys, e.g. "NYY" */
  teamAbbrev: varchar("teamAbbrev", { length: 8 }).notNull(),
  /** MLB Stats API team ID, e.g. 147 for NYY */
  mlbTeamId: int("mlbTeamId").notNull(),
  /** Pitcher hand faced: 'L' = vs LHP, 'R' = vs RHP */
  hand: varchar("hand", { length: 1 }).notNull(),
  /** Batting average vs this hand */
  avg: double("avg"),
  /** On-base percentage vs this hand */
  obp: double("obp"),
  /** Slugging percentage vs this hand */
  slg: double("slg"),
  /** OPS vs this hand */
  ops: double("ops"),
  /** Home runs hit vs this hand (raw count) */
  homeRuns: int("homeRuns"),
  /** At-bats vs this hand (raw count) */
  atBats: int("atBats"),
  /** Walks vs this hand (raw count) */
  baseOnBalls: int("baseOnBalls"),
  /** Strikeouts vs this hand (raw count) */
  strikeOuts: int("strikeOuts"),
  /** Hits vs this hand (raw count) */
  hits: int("hits"),
  /** Games played vs this hand */
  gamesPlayed: int("gamesPlayed"),
  /** Derived: HR per 9 innings = HR / AB * 27 */
  hr9: double("hr9"),
  /** Derived: BB per 9 innings = BB / AB * 27 */
  bb9: double("bb9"),
  /** Derived: K per 9 innings = K / AB * 27 */
  k9: double("k9"),
  /** Derived: wOBA approximation = (0.69*BB + 0.888*1B + 1.271*2B + 1.616*3B + 2.101*HR) / (AB+BB) */
  woba: double("woba"),
  /** Season runs per game for this team (hand-agnostic, same value for L and R rows).
   *  Computed from MLB Stats API team season stats: R / G.
   *  Replaces the frozen TEAM_STATS_2025.rpg constant. */
  rpg: double("rpg"),
  /** Average innings pitched per game by the starting rotation (hand-agnostic).
   *  Computed from MLB Stats API team pitching stats: IP / G.
   *  Replaces the frozen TEAM_STATS_2025.ip_per_game constant. */
  ipPerGame: double("ipPerGame"),
  /** UTC timestamp (ms) when stats were last fetched */
  lastFetchedAt: bigint("lastFetchedAt", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  /** Upsert key: one row per team per pitcher hand */
  uqTeamHand: uniqueIndex("uq_team_batting_hand").on(t.teamAbbrev, t.hand),
  /** Index for fast team lookup */
  idxTeamAbbrev: index("idx_batting_splits_team").on(t.teamAbbrev),
}));
export type MlbTeamBattingSplitRow = typeof mlbTeamBattingSplits.$inferSelect;
export type InsertMlbTeamBattingSplit = typeof mlbTeamBattingSplits.$inferInsert;

// ─── MLB Pitcher Rolling Last-5 Starts ───────────────────────────────────────
/**
 * One row per pitcher — rolling stats computed from their last 5 game starts.
 * Populated from MLB Stats API gameLog endpoint, filtered to GS=true.
 * Used by mlbModelRunner.ts to weight recent form (hot/cold starter signal).
 *
 * All per-9-inning rates are computed from the rolling 5-game window:
 *   era5   — earned run average over last 5 starts
 *   k9_5   — strikeouts per 9
 *   bb9_5  — walks per 9
 *   hr9_5  — home runs per 9
 *   whip5  — WHIP over last 5 starts
 *   ip5    — total innings pitched in last 5 starts
 *   fip5   — FIP computed from last 5 starts (3*BB + 13*HR - 2*K) / IP + constant
 */
export const mlbPitcherRolling5 = mysqlTable("mlb_pitcher_rolling5", {
  id: int("id").autoincrement().primaryKey(),
  /** MLB Stats API player ID */
  mlbamId: int("mlbamId").notNull(),
  /** Full name for debugging */
  fullName: varchar("fullName", { length: 128 }).notNull(),
  /** Team abbreviation */
  teamAbbrev: varchar("teamAbbrev", { length: 8 }).notNull(),
  /** Number of starts included in this rolling window (≤5, may be <5 early in season) */
  startsIncluded: int("startsIncluded").notNull(),
  /** Total innings pitched across the window */
  ip5: double("ip5"),
  /** Total earned runs across the window */
  er5: int("er5"),
  /** Total hits across the window */
  h5: int("h5"),
  /** Total walks across the window */
  bb5: int("bb5"),
  /** Total strikeouts across the window */
  k5: int("k5"),
  /** Total home runs across the window */
  hr5: int("hr5"),
  /** Derived: ERA over last 5 starts = ER5 / IP5 * 9 */
  era5: double("era5"),
  /** Derived: K/9 over last 5 starts */
  k9_5: double("k9_5"),
  /** Derived: BB/9 over last 5 starts */
  bb9_5: double("bb9_5"),
  /** Derived: HR/9 over last 5 starts */
  hr9_5: double("hr9_5"),
  /** Derived: WHIP over last 5 starts = (H5 + BB5) / IP5 */
  whip5: double("whip5"),
  /** Derived: FIP over last 5 starts = (13*HR + 3*BB - 2*K) / IP + 3.10 */
  fip5: double("fip5"),
  /** ISO date of the most recent start included, e.g. "2025-09-28" */
  lastStartDate: varchar("lastStartDate", { length: 10 }),
  /** ISO date of the oldest start included in the window */
  firstStartDate: varchar("firstStartDate", { length: 10 }),
  /** UTC timestamp (ms) when this row was last computed */
  lastFetchedAt: bigint("lastFetchedAt", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  /** Upsert key: one row per pitcher */
  uqPitcherRolling: uniqueIndex("uq_pitcher_rolling5").on(t.mlbamId),
  /** Name lookup */
  idxRollingName: index("idx_rolling5_name").on(t.fullName),
}));
export type MlbPitcherRolling5Row = typeof mlbPitcherRolling5.$inferSelect;
export type InsertMlbPitcherRolling5 = typeof mlbPitcherRolling5.$inferInsert;


// ─────────────────────────────────────────────────────────────────────────────
// MLB PARK FACTORS
// ─────────────────────────────────────────────────────────────────────────────
/**
 * mlbParkFactors — 3-year rolling park run factor per MLB venue (2024/2025/2026).
 *
 * Methodology:
 *   - Fetch all regular-season games per venue for 2024, 2025, 2026
 *     via schedule?hydrate=linescore endpoint
 *   - Sum total runs scored in all completed games at that venue per season
 *   - park_factor_yr = avg_rpg_venue / league_avg_rpg
 *   - 3yr_park_factor = weighted avg (2026*0.50 + 2025*0.30 + 2024*0.20)
 *     Weights normalized to available seasons at seed time.
 */
export const mlbParkFactors = mysqlTable("mlb_park_factors", {
  id: int("id").autoincrement().primaryKey(),
  venueId: int("venueId").notNull(),
  venueName: varchar("venueName", { length: 128 }).notNull(),
  teamAbbrev: varchar("teamAbbrev", { length: 8 }).notNull(),
  runs2024: int("runs2024"),
  games2024: int("games2024"),
  avgRpg2024: double("avgRpg2024"),
  pf2024: double("pf2024"),
  runs2025: int("runs2025"),
  games2025: int("games2025"),
  avgRpg2025: double("avgRpg2025"),
  pf2025: double("pf2025"),
  runs2026: int("runs2026"),
  games2026: int("games2026"),
  avgRpg2026: double("avgRpg2026"),
  pf2026: double("pf2026"),
  parkFactor3yr: double("parkFactor3yr").notNull(),
  /**
   * HR-specific park factor (separate from run-factor).
   * Derived from PARK_FACTORS[team]['hr'] / 100.0 in MLBAIModel.py.
   * e.g. COL=1.28, SF=0.88, CIN=1.15. Neutral=1.00.
   * Used exclusively by the HR Props model (mlbHrPropsModelService.ts).
   */
  hrFactor: double("hrFactor"),
  leagueAvgRpg: double("leagueAvgRpg"),
  lastFetchedAt: bigint("lastFetchedAt", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  uqVenue: uniqueIndex("uq_park_venue").on(t.venueId),
  idxTeam: index("idx_park_team").on(t.teamAbbrev),
}));
export type MlbParkFactorRow = typeof mlbParkFactors.$inferSelect;
export type InsertMlbParkFactor = typeof mlbParkFactors.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// MLB BULLPEN STATS
// ─────────────────────────────────────────────────────────────────────────────
/**
 * mlbBullpenStats — Aggregated relief pitcher stats per MLB team.
 *
 * Methodology:
 *   - Fetch all pitchers per team via stats?group=pitching&season=2025&teamId=X
 *   - Filter: gamesStarted = 0 AND inningsPitched >= 1
 *   - Aggregate ERA, K/9, BB/9, HR/9, WHIP, K/BB, FIP across all relievers
 */
export const mlbBullpenStats = mysqlTable("mlb_bullpen_stats", {
  id: int("id").autoincrement().primaryKey(),
  teamAbbrev: varchar("teamAbbrev", { length: 8 }).notNull(),
  mlbTeamId: int("mlbTeamId").notNull(),
  season: int("season").notNull(),
  relieverCount: int("relieverCount").notNull(),
  totalIp: double("totalIp").notNull(),
  totalEr: int("totalEr"),
  totalK: int("totalK"),
  totalBb: int("totalBb"),
  totalHr: int("totalHr"),
  totalH: int("totalH"),
  eraBullpen: double("eraBullpen"),
  k9Bullpen: double("k9Bullpen"),
  bb9Bullpen: double("bb9Bullpen"),
  hr9Bullpen: double("hr9Bullpen"),
  whipBullpen: double("whipBullpen"),
  kBbRatio: double("kBbRatio"),
  fipBullpen: double("fipBullpen"),
  lastFetchedAt: bigint("lastFetchedAt", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  uqTeamSeason: uniqueIndex("uq_bullpen_team_season").on(t.teamAbbrev, t.season),
  idxTeam: index("idx_bullpen_team").on(t.teamAbbrev),
}));
export type MlbBullpenStatsRow = typeof mlbBullpenStats.$inferSelect;
export type InsertMlbBullpenStats = typeof mlbBullpenStats.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// MLB UMPIRE MODIFIERS
// ─────────────────────────────────────────────────────────────────────────────
/**
 * mlbUmpireModifiers — Per-umpire K and BB rate modifiers from 2023/2024/2025.
 *
 * Methodology:
 *   - For each completed game, fetch boxscore: HP umpire ID + total K + total BB + total H
 *   - Accumulate per umpire across all games in 2023/2024/2025
 *   - k_rate = totalK / (totalK + totalBb + totalH)
 *   - k_modifier = umpire_k_rate / league_avg_k_rate
 *   - Applied in engine: effective_k_pct = pitcher_k_pct * k_modifier
 */
export const mlbUmpireModifiers = mysqlTable("mlb_umpire_modifiers", {
  id: int("id").autoincrement().primaryKey(),
  umpireId: int("umpireId").notNull(),
  umpireName: varchar("umpireName", { length: 128 }).notNull(),
  gamesHp: int("gamesHp").notNull(),
  totalK: int("totalK").notNull(),
  totalBb: int("totalBb").notNull(),
  totalH: int("totalH"),
  totalR: int("totalR"),
  kRate: double("kRate"),
  bbRate: double("bbRate"),
  kModifier: double("kModifier"),
  bbModifier: double("bbModifier"),
  seasonsIncluded: varchar("seasonsIncluded", { length: 32 }),
  lastFetchedAt: bigint("lastFetchedAt", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  uqUmpire: uniqueIndex("uq_umpire_id").on(t.umpireId),
  idxName: index("idx_umpire_name").on(t.umpireName),
}));
export type MlbUmpireModifierRow = typeof mlbUmpireModifiers.$inferSelect;
export type InsertMlbUmpireModifier = typeof mlbUmpireModifiers.$inferInsert;

// ─── MLB HR Props (per-batter, from Action Network) ─────────────────────────
/**
 * One row per (game, player) for HR props.
 * Populated from Action Network HR props page (FanDuel NJ as primary book).
 * Backtested after game FINAL.
 */
export const mlbHrProps = mysqlTable("mlb_hr_props", {
  id: int("id").autoincrement().primaryKey(),
  /** FK → games.id */
  gameId: int("gameId").notNull(),
  /** 'away' | 'home' */
  side: varchar("side", { length: 8 }).notNull(),
  /** Player full name, e.g. "Aaron Judge" */
  playerName: varchar("playerName", { length: 128 }).notNull(),
  /** MLBAM player ID */
  mlbamId: int("mlbamId"),
  /** Action Network player ID */
  anPlayerId: int("anPlayerId"),
  /** Team abbreviation, e.g. "NYY" */
  teamAbbrev: varchar("teamAbbrev", { length: 8 }),
  /** Book HR prop line (always 0.5 for To Hit A HR) */
  bookLine: decimal("bookLine", { precision: 4, scale: 1 }).default("0.5"),
  /** FanDuel NJ over (hit HR) odds, e.g. "+280" */
  fdOverOdds: varchar("fdOverOdds", { length: 16 }),
  /** FanDuel NJ under (no HR) odds, e.g. "-380" */
  fdUnderOdds: varchar("fdUnderOdds", { length: 16 }),
  /** Consensus over odds across books, e.g. "+270" */
  consensusOverOdds: varchar("consensusOverOdds", { length: 16 }),
  /** Consensus under odds across books, e.g. "-350" */
  consensusUnderOdds: varchar("consensusUnderOdds", { length: 16 }),
  /** Action Network no-vig over probability (decimal, e.g. "0.265") */
  anNoVigOverPct: varchar("anNoVigOverPct", { length: 16 }),
  /** Model P(player hits ≥1 HR) from MLBAIModel.py (decimal, e.g. "0.241") */
  modelPHr: varchar("modelPHr", { length: 16 }),
  /** Model fair value odds for over (hit HR), e.g. "+315" */
  modelOverOdds: varchar("modelOverOdds", { length: 16 }),
  /** Edge on over (model - book no-vig), decimal string, e.g. "+0.023" */
  edgeOver: varchar("edgeOver", { length: 16 }),
  /** EV on over at FD odds: edge * (1/book_p - 1) * 100 */
  evOver: varchar("evOver", { length: 16 }),
  /** Best verdict: 'OVER' | 'UNDER' | 'PASS' */
  verdict: varchar("verdict", { length: 16 }),
  /** Actual result: 1 = hit HR, 0 = no HR, null = pending */
  actualHr: tinyint("actualHr"),
  /** Backtest result: 'WIN' | 'LOSS' | 'PUSH' | 'PENDING' | 'NO_LINE' */
  backtestResult: varchar("backtestResult", { length: 16 }),
  /** Model prediction correct: 1=yes 0=no null=pending */
  modelCorrect: tinyint("modelCorrect"),
  /** UTC ms when model was run */
  modelRunAt: bigint("modelRunAt", { mode: "number" }),
  /** UTC ms when backtest was last run */
  backtestRunAt: bigint("backtestRunAt", { mode: "number" }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  /** One row per (game, player) */
  uqGamePlayer: uniqueIndex("uq_hr_game_player").on(t.gameId, t.playerName),
  idxGame: index("idx_hr_game").on(t.gameId),
  idxMlbam: index("idx_hr_mlbam").on(t.mlbamId),
}));
export type MlbHrPropRow = typeof mlbHrProps.$inferSelect;
export type InsertMlbHrProp = typeof mlbHrProps.$inferInsert;

// ─── MLB Game Backtest Log (per-game, per-market performance tracking) ───────
/**
 * One row per (game, market) — the authoritative backtest performance log.
 * Used by the automated learning layer for drift detection and recalibration.
 * Markets: 'FG_ML' | 'FG_RL' | 'FG_TOTAL' | 'F5_ML' | 'F5_RL' | 'F5_TOTAL' |
 *           'NRFI' | 'K_PROPS' | 'HR_PROPS'
 */
export const mlbGameBacktest = mysqlTable("mlb_game_backtest", {
  id: int("id").autoincrement().primaryKey(),
  /** FK → games.id */
  gameId: int("gameId").notNull(),
  /** Game date string YYYY-MM-DD */
  gameDate: varchar("gameDate", { length: 10 }).notNull(),
  /** Market identifier */
  market: varchar("market", { length: 16 }).notNull(),
  /** Model prediction side / market key e.g. 'fg_ml_home', 'nrfi' */
  modelSide: varchar("modelSide", { length: 32 }),
  /** Model probability for the predicted side (0-100) */
  modelProb: decimal("modelProb", { precision: 5, scale: 2 }),
  /** Book line used for evaluation, e.g. "1.5" or "8.5" */
  bookLine: varchar("bookLine", { length: 16 }),
  /** Book odds for the model side (American), e.g. "-138" */
  bookOdds: varchar("bookOdds", { length: 16 }),
  /** Book no-vig probability for model side (decimal, e.g. "0.572") */
  bookNoVigProb: decimal("bookNoVigProb", { precision: 5, scale: 4 }),
  /** Edge: model_prob - book_no_vig_prob (decimal, e.g. "0.043") */
  edge: decimal("edge", { precision: 5, scale: 4 }),
  /** Expected value: edge * (1/book_p - 1) * 100 */
  ev: decimal("ev", { precision: 6, scale: 2 }),
  /** Confidence gate passed: 1=yes 0=no */
  confidencePassed: tinyint("confidencePassed"),
  /** Actual outcome: 'WIN' | 'LOSS' | 'PUSH' | 'VOID' | 'QUARANTINED' | 'UNGRADED' | 'PENDING' */
  result: varchar("result", { length: 16 }),
  /** Model correct: 1=yes 0=no null=pending */
  correct: tinyint("correct"),
  /** Away team final score (for context) */
  actualAwayScore: int("actualAwayScore"),
  /** Home team final score (for context) */
  actualHomeScore: int("actualHomeScore"),
  /** Away pitcher (for context) */
  awayPitcher: varchar("awayPitcher", { length: 128 }),
  /** Home pitcher (for context) */
  homePitcher: varchar("homePitcher", { length: 128 }),
  /** Home team name (for segmentation) */
  homeTeam: varchar("homeTeam", { length: 128 }),
  /** Away team name (for segmentation) */
  awayTeam: varchar("awayTeam", { length: 128 }),
  /** Day or night game: 'D' | 'N' */
  dayNight: varchar("dayNight", { length: 2 }),
  /** Whether this is a doubleheader game */
  isDoubleheader: boolean("isDoubleheader").default(false),
  /** Doubleheader game number: 1 or 2 */
  gameNumber: tinyint("gameNumber").default(1),
  /** Leakage quarantine reason (null if not quarantined) */
  quarantineReason: text("quarantineReason"),
  /** Book odds for the opposite side (American) — for no-vig calculation */
  bookOddsOpposite: varchar("bookOddsOpposite", { length: 16 }),
  /** Closing odds for the model side (American) — for CLV */
  closingOdds: varchar("closingOdds", { length: 16 }),
  /** Closing odds for the opposite side (American) — for CLV */
  closingOddsOpposite: varchar("closingOddsOpposite", { length: 16 }),
  /** CLV: model probability minus closing no-vig probability */
  clv: decimal("clv", { precision: 6, scale: 4 }),
  /** Profit/loss for this bet (in units, positive = profit, negative = loss) */
  profitLoss: decimal("profitLoss", { precision: 8, scale: 4 }),
  /** Whether this row passed the leakage guard: 1=safe 0=violation */
  leakageSafe: tinyint("leakageSafe").default(1),
  /** UTC ms when model ran (for leakage guard) */
  modelRunAt: bigint("modelRunAt", { mode: "number" }),
  /** UTC ms when backtest was run */
  backtestRunAt: bigint("backtestRunAt", { mode: "number" }),
  /** Game start time string e.g. '7:05 PM ET' */
  gameTime: varchar("gameTime", { length: 32 }),
  /** UTC epoch ms of game start (derived from gameDate + startTimeEst) */
  gameStartUtcMs: bigint("gameStartUtcMs", { mode: "number" }),
  /** Reason this row was voided (postponed/suspended) */
  voidReason: text("voidReason"),
  /** Audit version string for traceability */
  auditVersion: varchar("auditVersion", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  /** One row per (game, market) */
  uqGameMarket: uniqueIndex("uq_backtest_game_market").on(t.gameId, t.market),
  idxDate: index("idx_backtest_date").on(t.gameDate),
  idxMarket: index("idx_backtest_market").on(t.market),
  idxResult: index("idx_backtest_result").on(t.result),
}));
export type MlbGameBacktestRow = typeof mlbGameBacktest.$inferSelect;
export type InsertMlbGameBacktest = typeof mlbGameBacktest.$inferInsert;

// ─── MLB Model Learning Log (automated recalibration history) ────────────────
/**
 * One row per recalibration event.
 * Tracks which parameters were adjusted, why, and what the rolling accuracy was.
 */
export const mlbModelLearningLog = mysqlTable("mlb_model_learning_log", {
  id: int("id").autoincrement().primaryKey(),
  /** Market that triggered recalibration */
  market: varchar("market", { length: 16 }).notNull(),
  /** Rolling window size used (e.g. 14 = last 14 days) */
  windowDays: int("windowDays").notNull(),
  /** Rolling accuracy before recalibration (0-1) */
  accuracyBefore: decimal("accuracyBefore", { precision: 5, scale: 4 }),
  /** Rolling accuracy after recalibration (0-1) */
  accuracyAfter: decimal("accuracyAfter", { precision: 5, scale: 4 }),
  /** Mean absolute error before recalibration */
  maeBefore: decimal("maeBefore", { precision: 6, scale: 4 }),
  /** Mean absolute error after recalibration */
  maeAfter: decimal("maeAfter", { precision: 6, scale: 4 }),
  /** JSON: { param: string, oldValue: number, newValue: number }[] */
  paramChanges: text("paramChanges"),
  /** Trigger reason: 'DRIFT_DETECTED' | 'SCHEDULED' | 'MANUAL' */
  triggerReason: varchar("triggerReason", { length: 32 }),
  /** Number of games in the rolling window */
  sampleSize: int("sampleSize"),
  /** UTC ms when recalibration ran */
  runAt: bigint("runAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  idxMarket: index("idx_learning_market").on(t.market),
  idxRunAt: index("idx_learning_run_at").on(t.runAt),
}));
export type MlbModelLearningLogRow = typeof mlbModelLearningLog.$inferSelect;
export type InsertMlbModelLearningLog = typeof mlbModelLearningLog.$inferInsert;

// ─── MLB Drift State (rolling metric state per market) ───────────────────────
/**
 * Persists the live drift detection state across scheduler runs.
 * One row per market — upserted on every drift check.
 * Markets: 'F5_SHARE' | 'FG_ML' | 'FG_TOTAL' | 'F5_ML' | 'F5_TOTAL' | 'NRFI' | 'K_PROPS' | 'HR_PROPS'
 */
export const mlbDriftState = mysqlTable("mlb_drift_state", {
  id: int("id").autoincrement().primaryKey(),
  /** Market identifier, e.g. 'F5_SHARE', 'FG_ML', 'NRFI' */
  market: varchar("market", { length: 32 }).notNull(),
  /** Rolling window size used (games) */
  windowSize: int("windowSize").notNull().default(50),
  /** Rolling metric value (f5_share, accuracy, etc.) */
  rollingValue: decimal("rollingValue", { precision: 8, scale: 6 }),
  /** Baseline value (calibrated constant) */
  baselineValue: decimal("baselineValue", { precision: 8, scale: 6 }),
  /** Absolute delta: |rolling - baseline| */
  delta: decimal("delta", { precision: 8, scale: 6 }),
  /** Direction of drift: 'HIGH' | 'LOW' | 'STABLE' */
  direction: varchar("direction", { length: 8 }),
  /** Whether drift was detected on last check: 1=yes 0=no */
  driftDetected: tinyint("driftDetected").default(0),
  /** Number of games in the rolling window */
  sampleSize: int("sampleSize"),
  /** UTC ms of last drift check */
  lastCheckedAt: bigint("lastCheckedAt", { mode: "number" }),
  /** UTC ms of last recalibration triggered by this market */
  lastRecalibrationAt: bigint("lastRecalibrationAt", { mode: "number" }),
  /** Number of consecutive drift detections (resets on recalibration) */
  consecutiveDriftCount: int("consecutiveDriftCount").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  uqMarket: uniqueIndex("uq_drift_market").on(t.market),
}));
export type MlbDriftStateRow = typeof mlbDriftState.$inferSelect;
export type InsertMlbDriftState = typeof mlbDriftState.$inferInsert;

// ─── MLB Calibration Constants (live model parameter store) ──────────────────
/**
 * Persists live calibration constants for each model component.
 * One row per parameter — upserted by the recalibration pipeline.
 * Examples: f5_share, nrfi_rate, k_calibration_factor, hr_base_rate
 */
export const mlbCalibrationConstants = mysqlTable("mlb_calibration_constants", {
  id: int("id").autoincrement().primaryKey(),
  /** Parameter name, e.g. 'f5_share', 'nrfi_rate', 'k_calibration_factor' */
  paramName: varchar("paramName", { length: 64 }).notNull(),
  /** Current live value (decimal string for precision) */
  currentValue: decimal("currentValue", { precision: 12, scale: 8 }).notNull(),
  /** Baseline value at last manual calibration */
  baselineValue: decimal("baselineValue", { precision: 12, scale: 8 }),
  /** Previous value before last recalibration */
  previousValue: decimal("previousValue", { precision: 12, scale: 8 }),
  /** Sample size used to compute current value */
  sampleSize: int("sampleSize"),
  /** Confidence interval lower bound (95%) */
  ciLower: decimal("ciLower", { precision: 12, scale: 8 }),
  /** Confidence interval upper bound (95%) */
  ciUpper: decimal("ciUpper", { precision: 12, scale: 8 }),
  /** Source of last update: 'AUTO_RECAL' | 'MANUAL' | 'INIT' */
  updateSource: varchar("updateSource", { length: 16 }).default("INIT"),
  /** UTC ms of last update */
  lastUpdatedAt: bigint("lastUpdatedAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  uqParam: uniqueIndex("uq_cal_param").on(t.paramName),
  idxUpdated: index("idx_cal_updated").on(t.lastUpdatedAt),
}));
export type MlbCalibrationConstantRow = typeof mlbCalibrationConstants.$inferSelect;
export type InsertMlbCalibrationConstant = typeof mlbCalibrationConstants.$inferInsert;

// ─── Security Events (CSRF blocks, auth anomalies) ───────────────────────────
/**
 * One row per security event detected by server-side middleware.
 *
 * Event types:
 *   CSRF_BLOCK   — Origin header mismatch on a tRPC mutation
 *   RATE_LIMIT   — Rate limiter triggered (too many requests from one IP)
 *   AUTH_FAIL    — Authentication failure (invalid token, expired session)
 *
 * Retention: rows older than 90 days can be pruned by a scheduled job.
 * Access: owner-only — no user-facing queries.
 */
export const securityEvents = mysqlTable("security_events", {
  id: int("id").autoincrement().primaryKey(),
  /** Event category: 'CSRF_BLOCK' | 'RATE_LIMIT' | 'AUTH_FAIL' */
  eventType: varchar("eventType", { length: 32 }).notNull(),
  /** Attacker/client IP address (IPv4 or IPv6) */
  ip: varchar("ip", { length: 64 }).notNull(),
  /** Blocked Origin header value (null for non-CSRF events) */
  blockedOrigin: varchar("blockedOrigin", { length: 512 }),
  /** tRPC procedure path that was blocked (e.g. 'appUsers.login') */
  trpcPath: varchar("trpcPath", { length: 256 }),
  /** HTTP method (POST, GET, etc.) */
  httpMethod: varchar("httpMethod", { length: 16 }),
  /** User agent string (truncated to 512 chars) */
  userAgent: varchar("userAgent", { length: 512 }),
  /** Additional context as JSON string (flexible per event type) */
  context: text("context"),
  /** UTC milliseconds timestamp of the event */
  occurredAt: bigint("occurredAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  idxEventType: index("idx_sec_event_type").on(t.eventType),
  idxIp: index("idx_sec_event_ip").on(t.ip),
  idxOccurredAt: index("idx_sec_event_occurred_at").on(t.occurredAt),
}));

export type SecurityEventRow = typeof securityEvents.$inferSelect;
export type InsertSecurityEvent = typeof securityEvents.$inferInsert;

// ─── User Sessions (DAU / MAU / WAU / avg session duration tracking) ─────────
/**
 * One row per user session. A session starts on login and ends when the user
 * logs out or when the heartbeat stops for > 30 min (SESSION_IDLE_THRESHOLD_MS).
 *
 * Fields:
 *   startedAt     — UTC ms when the session began (login event)
 *   endedAt       — UTC ms when the session ended; NULL = still active
 *   durationMs    — Computed on close: endedAt - startedAt; NULL while active
 *   lastHeartbeat — UTC ms of the most recent client ping (every 5 min)
 *
 * Indexes:
 *   idx_sess_user_id    — fast per-user queries
 *   idx_sess_started_at — fast time-window aggregations (DAU/MAU/WAU)
 *   idx_sess_ended_at   — fast active-session queries (WHERE endedAt IS NULL)
 */
export const userSessions = mysqlTable("user_sessions", {
  id:            int("id").autoincrement().primaryKey(),
  /** app_users.id of the user who owns this session */
  userId:        int("userId").notNull(),
  /** UTC ms when the session started */
  startedAt:     bigint("startedAt", { mode: "number" }).notNull(),
  /** UTC ms when the session ended; NULL = session still active */
  endedAt:       bigint("endedAt",   { mode: "number" }),
  /** Duration in ms (endedAt - startedAt); NULL while active */
  durationMs:    bigint("durationMs", { mode: "number" }),
  /** UTC ms of the most recent heartbeat ping from the client */
  lastHeartbeat: bigint("lastHeartbeat", { mode: "number" }),
  createdAt:     timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  idxUserId:    index("idx_sess_user_id").on(t.userId),
  idxStartedAt: index("idx_sess_started_at").on(t.startedAt),
  idxEndedAt:   index("idx_sess_ended_at").on(t.endedAt),
}));
export type UserSession = typeof userSessions.$inferSelect;
export type InsertUserSession = typeof userSessions.$inferInsert;

// ─── MLB Schedule History (Action Network DK NJ odds + results per game) ─────
/**
 * One row per MLB game, populated from the Action Network v2 API using
 * DraftKings NJ (book_id=68) as the sole odds source.
 *
 * Purpose:
 *   - Powers the "Last 5 Games" panel on each MLB matchup card
 *   - Powers the full Team Schedule page for every MLB team
 *   - Stores pre-game DK NJ run line / total / moneyline odds
 *   - Stores final scores and derived result columns (covered/won/O-U)
 *
 * Result derivation (computed when status='complete'):
 *   awayRunLineCovered  — true if away team covered the run line
 *   homeRunLineCovered  — true if home team covered the run line
 *   totalResult         — 'OVER' | 'UNDER' | 'PUSH' based on final score vs dkTotal
 *   awayWon             — true if away team won outright
 *
 * Deduplication key: anGameId (Action Network internal game ID)
 */
export const mlbScheduleHistory = mysqlTable("mlb_schedule_history", {
  id: int("id").autoincrement().primaryKey(),
  /** Action Network internal game ID — primary deduplication key */
  anGameId: int("anGameId").notNull().unique(),
  /** Game date in YYYY-MM-DD format (EST) */
  gameDate: varchar("gameDate", { length: 10 }).notNull(),
  /** Game start time as ISO 8601 UTC string from AN API */
  startTimeUtc: varchar("startTimeUtc", { length: 32 }).notNull(),
  /** Game status: 'scheduled' | 'inprogress' | 'complete' */
  gameStatus: varchar("gameStatus", { length: 16 }).notNull().default("scheduled"),
  /** MLB Stats API gamePk — canonical join key to the mlb_games table; null until backfilled */
  gamePk: int("gamePk"),
  // ─── Away Team ──────────────────────────────────────────────────────────────
  /** Away team Action Network URL slug, e.g. "arizona-diamondbacks" */
  awaySlug: varchar("awaySlug", { length: 128 }).notNull(),
  /** Away team abbreviation from AN, e.g. "ARI" */
  awayAbbr: varchar("awayAbbr", { length: 8 }).notNull(),
  /** Away team full name from AN, e.g. "Arizona Diamondbacks" */
  awayName: varchar("awayName", { length: 128 }).notNull(),
  /** Away team Action Network numeric ID */
  awayTeamId: int("awayTeamId").notNull(),
  /** Away team final score (null = game not yet final) */
  awayScore: int("awayScore"),
  // ─── Home Team ──────────────────────────────────────────────────────────────
  /** Home team Action Network URL slug, e.g. "philadelphia-phillies" */
  homeSlug: varchar("homeSlug", { length: 128 }).notNull(),
  /** Home team abbreviation from AN, e.g. "PHI" */
  homeAbbr: varchar("homeAbbr", { length: 8 }).notNull(),
  /** Home team full name from AN, e.g. "Philadelphia Phillies" */
  homeName: varchar("homeName", { length: 128 }).notNull(),
  /** Home team Action Network numeric ID */
  homeTeamId: int("homeTeamId").notNull(),
  /** Home team final score (null = game not yet final) */
  homeScore: int("homeScore"),
  // ─── DK NJ Pre-Game Odds (book_id=68, is_live=false) ────────────────────────
  /** DK NJ away run line spread, e.g. 1.5 (positive = underdog) */
  dkAwayRunLine: decimal("dkAwayRunLine", { precision: 4, scale: 1 }),
  /** DK NJ away run line juice in American format, e.g. "-144" */
  dkAwayRunLineOdds: varchar("dkAwayRunLineOdds", { length: 16 }),
  /** DK NJ home run line spread, e.g. -1.5 */
  dkHomeRunLine: decimal("dkHomeRunLine", { precision: 4, scale: 1 }),
  /** DK NJ home run line juice in American format, e.g. "+119" */
  dkHomeRunLineOdds: varchar("dkHomeRunLineOdds", { length: 16 }),
  /** DK NJ game total (over line), e.g. 8.5 */
  dkTotal: decimal("dkTotal", { precision: 5, scale: 1 }),
  /** DK NJ over juice in American format, e.g. "-112" */
  dkOverOdds: varchar("dkOverOdds", { length: 16 }),
  /** DK NJ under juice in American format, e.g. "-108" */
  dkUnderOdds: varchar("dkUnderOdds", { length: 16 }),
  /** DK NJ away team moneyline in American format, e.g. "+153" */
  dkAwayML: varchar("dkAwayML", { length: 16 }),
  /** DK NJ home team moneyline in American format, e.g. "-186" */
  dkHomeML: varchar("dkHomeML", { length: 16 }),
  // ─── DK NJ Closing Odds (captured at first pitch / game start) ─────────────────
  /** DK NJ closing away run line spread captured at game start, e.g. -1.5 */
  dkClosingAwayRunLine: decimal("dkClosingAwayRunLine", { precision: 4, scale: 1 }),
  /** DK NJ closing away run line juice in American format, e.g. "-144" */
  dkClosingAwayRunLineOdds: varchar("dkClosingAwayRunLineOdds", { length: 16 }),
  /** DK NJ closing home run line spread captured at game start, e.g. +1.5 */
  dkClosingHomeRunLine: decimal("dkClosingHomeRunLine", { precision: 4, scale: 1 }),
  /** DK NJ closing home run line juice in American format, e.g. "+119" */
  dkClosingHomeRunLineOdds: varchar("dkClosingHomeRunLineOdds", { length: 16 }),
  /** DK NJ closing game total captured at game start, e.g. 8.5 */
  dkClosingTotal: decimal("dkClosingTotal", { precision: 5, scale: 1 }),
  /** DK NJ closing over juice in American format, e.g. "-112" */
  dkClosingOverOdds: varchar("dkClosingOverOdds", { length: 16 }),
  /** DK NJ closing under juice in American format, e.g. "-108" */
  dkClosingUnderOdds: varchar("dkClosingUnderOdds", { length: 16 }),
  /** DK NJ closing away moneyline in American format, e.g. "+153" */
  dkClosingAwayML: varchar("dkClosingAwayML", { length: 16 }),
  /** DK NJ closing home moneyline in American format, e.g. "-186" */
  dkClosingHomeML: varchar("dkClosingHomeML", { length: 16 }),
  /** UTC ms timestamp when closing lines were locked (first pitch detected) */
  closingLineLockedAt: bigint("closingLineLockedAt", { mode: "number" }),
  // ─── Derived Result Columns (populated after game is complete) ───────────────
  /** true = away team covered the run line; false = did not cover; null = game not final or no line */
  awayRunLineCovered: boolean("awayRunLineCovered"),
  /** true = home team covered the run line; false = did not cover; null = game not final or no line */
  homeRunLineCovered: boolean("homeRunLineCovered"),
  /** 'OVER' | 'UNDER' | 'PUSH' — based on final combined score vs dkTotal; null = game not final or no total */
  totalResult: varchar("totalResult", { length: 8 }),
  /** true = away team won outright; false = home team won; null = game not final */
  awayWon: boolean("awayWon"),
  /** UTC ms timestamp of the last data refresh for this row */
  lastRefreshedAt: bigint("lastRefreshedAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  idxAnGameId:   index("idx_msh_an_game_id").on(t.anGameId),
  idxGameDate:   index("idx_msh_game_date").on(t.gameDate),
  idxAwaySlug:   index("idx_msh_away_slug").on(t.awaySlug),
  idxHomeSlug:   index("idx_msh_home_slug").on(t.homeSlug),
  idxGameStatus: index("idx_msh_game_status").on(t.gameStatus),
  idxGamePk:     index("idx_msh_game_pk").on(t.gamePk),
}));
export type MlbScheduleHistoryRow = typeof mlbScheduleHistory.$inferSelect;
export type InsertMlbScheduleHistory = typeof mlbScheduleHistory.$inferInsert;

// ═══════════════════════════════════════════════════════════════════════════════
// NBA SCHEDULE HISTORY
// Stores every NBA game with DK NJ pre-game odds (spread, total, moneyline)
// and derived result columns (covered, O/U, won) for Recent Schedule and
// Situational Results panels. Source: Action Network v2 API, book_id=68.
// ═══════════════════════════════════════════════════════════════════════════════
export const nbaScheduleHistory = mysqlTable("nba_schedule_history", {
  id: int("id").autoincrement().primaryKey(),
  /** Action Network internal game ID — primary deduplication key */
  anGameId: int("anGameId").notNull().unique(),
  /** Game date in YYYY-MM-DD format (EST) */
  gameDate: varchar("gameDate", { length: 10 }).notNull(),
  /** Game start time as ISO 8601 UTC string from AN API */
  startTimeUtc: varchar("startTimeUtc", { length: 32 }).notNull(),
  /** Game status: 'scheduled' | 'inprogress' | 'complete' */
  gameStatus: varchar("gameStatus", { length: 16 }).notNull().default("scheduled"),
  // ─── Away Team ──────────────────────────────────────────────────────────────
  /** Away team Action Network URL slug, e.g. "boston-celtics" */
  awaySlug: varchar("awaySlug", { length: 128 }).notNull(),
  /** Away team abbreviation from AN, e.g. "BOS" */
  awayAbbr: varchar("awayAbbr", { length: 8 }).notNull(),
  /** Away team full name from AN, e.g. "Boston Celtics" */
  awayName: varchar("awayName", { length: 128 }).notNull(),
  /** Away team Action Network numeric ID */
  awayTeamId: int("awayTeamId").notNull(),
  /** Away team final score (null = game not yet final) */
  awayScore: int("awayScore"),
  // ─── Home Team ──────────────────────────────────────────────────────────────
  /** Home team Action Network URL slug, e.g. "los-angeles-lakers" */
  homeSlug: varchar("homeSlug", { length: 128 }).notNull(),
  /** Home team abbreviation from AN, e.g. "LAL" */
  homeAbbr: varchar("homeAbbr", { length: 8 }).notNull(),
  /** Home team full name from AN, e.g. "Los Angeles Lakers" */
  homeName: varchar("homeName", { length: 128 }).notNull(),
  /** Home team Action Network numeric ID */
  homeTeamId: int("homeTeamId").notNull(),
  /** Home team final score (null = game not yet final) */
  homeScore: int("homeScore"),
  // ─── DK NJ Pre-Game Odds (book_id=68, is_live=false) ────────────────────────
  /** DK NJ away spread value, e.g. 11.5 (positive = underdog) */
  dkAwaySpread: decimal("dkAwaySpread", { precision: 5, scale: 1 }),
  /** DK NJ away spread juice in American format, e.g. "-108" */
  dkAwaySpreadOdds: varchar("dkAwaySpreadOdds", { length: 16 }),
  /** DK NJ home spread value, e.g. -11.5 */
  dkHomeSpread: decimal("dkHomeSpread", { precision: 5, scale: 1 }),
  /** DK NJ home spread juice in American format, e.g. "-112" */
  dkHomeSpreadOdds: varchar("dkHomeSpreadOdds", { length: 16 }),
  /** DK NJ game total (over line), e.g. 233.5 */
  dkTotal: decimal("dkTotal", { precision: 6, scale: 1 }),
  /** DK NJ over juice in American format, e.g. "-105" */
  dkOverOdds: varchar("dkOverOdds", { length: 16 }),
  /** DK NJ under juice in American format, e.g. "-115" */
  dkUnderOdds: varchar("dkUnderOdds", { length: 16 }),
  /** DK NJ away team moneyline in American format, e.g. "+360" */
  dkAwayML: varchar("dkAwayML", { length: 16 }),
  /** DK NJ home team moneyline in American format, e.g. "-470" */
  dkHomeML: varchar("dkHomeML", { length: 16 }),
  // ─── Derived Result Columns (populated after game is complete) ───────────────
  /** true = away team covered the spread; false = did not cover; null = not final or no line */
  awaySpreadCovered: boolean("awaySpreadCovered"),
  /** true = home team covered the spread; false = did not cover; null = not final or no line */
  homeSpreadCovered: boolean("homeSpreadCovered"),
  /** 'OVER' | 'UNDER' | 'PUSH' — based on final combined score vs dkTotal */
  totalResult: varchar("totalResult", { length: 8 }),
  /** true = away team won outright; false = home team won; null = not final */
  awayWon: boolean("awayWon"),
  /** UTC ms timestamp of the last data refresh for this row */
  lastRefreshedAt: bigint("lastRefreshedAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  idxAnGameId:   index("idx_nbash_an_game_id").on(t.anGameId),
  idxGameDate:   index("idx_nbash_game_date").on(t.gameDate),
  idxAwaySlug:   index("idx_nbash_away_slug").on(t.awaySlug),
  idxHomeSlug:   index("idx_nbash_home_slug").on(t.homeSlug),
  idxGameStatus: index("idx_nbash_game_status").on(t.gameStatus),
}));
export type NbaScheduleHistoryRow = typeof nbaScheduleHistory.$inferSelect;
export type InsertNbaScheduleHistory = typeof nbaScheduleHistory.$inferInsert;

// ═══════════════════════════════════════════════════════════════════════════════
// NHL SCHEDULE HISTORY
// Stores every NHL game with DK NJ pre-game odds (puck line, total, moneyline)
// and derived result columns for Recent Schedule and Situational Results panels.
// Source: Action Network v2 API, book_id=68.
// ═══════════════════════════════════════════════════════════════════════════════
export const nhlScheduleHistory = mysqlTable("nhl_schedule_history", {
  id: int("id").autoincrement().primaryKey(),
  /** Action Network internal game ID — primary deduplication key */
  anGameId: int("anGameId").notNull().unique(),
  /** Game date in YYYY-MM-DD format (EST) */
  gameDate: varchar("gameDate", { length: 10 }).notNull(),
  /** Game start time as ISO 8601 UTC string from AN API */
  startTimeUtc: varchar("startTimeUtc", { length: 32 }).notNull(),
  /** Game status: 'scheduled' | 'inprogress' | 'complete' */
  gameStatus: varchar("gameStatus", { length: 16 }).notNull().default("scheduled"),
  // ─── Away Team ──────────────────────────────────────────────────────────────
  /** Away team Action Network URL slug, e.g. "boston-bruins" */
  awaySlug: varchar("awaySlug", { length: 128 }).notNull(),
  /** Away team abbreviation from AN, e.g. "BOS" */
  awayAbbr: varchar("awayAbbr", { length: 8 }).notNull(),
  /** Away team full name from AN, e.g. "Boston Bruins" */
  awayName: varchar("awayName", { length: 128 }).notNull(),
  /** Away team Action Network numeric ID */
  awayTeamId: int("awayTeamId").notNull(),
  /** Away team final score (null = game not yet final) */
  awayScore: int("awayScore"),
  // ─── Home Team ──────────────────────────────────────────────────────────────
  /** Home team Action Network URL slug, e.g. "toronto-maple-leafs" */
  homeSlug: varchar("homeSlug", { length: 128 }).notNull(),
  /** Home team abbreviation from AN, e.g. "TOR" */
  homeAbbr: varchar("homeAbbr", { length: 8 }).notNull(),
  /** Home team full name from AN, e.g. "Toronto Maple Leafs" */
  homeName: varchar("homeName", { length: 128 }).notNull(),
  /** Home team Action Network numeric ID */
  homeTeamId: int("homeTeamId").notNull(),
  /** Home team final score (null = game not yet final) */
  homeScore: int("homeScore"),
  // ─── DK NJ Pre-Game Odds (book_id=68, is_live=false) ────────────────────────
  /** DK NJ away puck line value, e.g. 1.5 (positive = underdog) */
  dkAwayPuckLine: decimal("dkAwayPuckLine", { precision: 4, scale: 1 }),
  /** DK NJ away puck line juice in American format, e.g. "+150" */
  dkAwayPuckLineOdds: varchar("dkAwayPuckLineOdds", { length: 16 }),
  /** DK NJ home puck line value, e.g. -1.5 */
  dkHomePuckLine: decimal("dkHomePuckLine", { precision: 4, scale: 1 }),
  /** DK NJ home puck line juice in American format, e.g. "-180" */
  dkHomePuckLineOdds: varchar("dkHomePuckLineOdds", { length: 16 }),
  /** DK NJ game total (over line), e.g. 6.5 */
  dkTotal: decimal("dkTotal", { precision: 5, scale: 1 }),
  /** DK NJ over juice in American format, e.g. "-102" */
  dkOverOdds: varchar("dkOverOdds", { length: 16 }),
  /** DK NJ under juice in American format, e.g. "-118" */
  dkUnderOdds: varchar("dkUnderOdds", { length: 16 }),
  /** DK NJ away team moneyline in American format, e.g. "-135" */
  dkAwayML: varchar("dkAwayML", { length: 16 }),
  /** DK NJ home team moneyline in American format, e.g. "+115" */
  dkHomeML: varchar("dkHomeML", { length: 16 }),
  // ─── Derived Result Columns (populated after game is complete) ───────────────
  /** true = away team covered the puck line; false = did not cover; null = not final or no line */
  awayPuckLineCovered: boolean("awayPuckLineCovered"),
  /** true = home team covered the puck line; false = did not cover; null = not final or no line */
  homePuckLineCovered: boolean("homePuckLineCovered"),
  /** 'OVER' | 'UNDER' | 'PUSH' — based on final combined score vs dkTotal */
  totalResult: varchar("totalResult", { length: 8 }),
  /** true = away team won outright; false = home team won; null = not final */
  awayWon: boolean("awayWon"),
  /** UTC ms timestamp of the last data refresh for this row */
  lastRefreshedAt: bigint("lastRefreshedAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  idxAnGameId:   index("idx_nhlsh_an_game_id").on(t.anGameId),
  idxGameDate:   index("idx_nhlsh_game_date").on(t.gameDate),
  idxAwaySlug:   index("idx_nhlsh_away_slug").on(t.awaySlug),
  idxHomeSlug:   index("idx_nhlsh_home_slug").on(t.homeSlug),
  idxGameStatus: index("idx_nhlsh_game_status").on(t.gameStatus),
}));
export type NhlScheduleHistoryRow = typeof nhlScheduleHistory.$inferSelect;
export type InsertNhlScheduleHistory = typeof nhlScheduleHistory.$inferInsert;

// ─── Tracked Bets (Bet Tracker — OWNER/ADMIN/HANDICAPPER only) ───────────────

export const trackedBets = mysqlTable("tracked_bets", {
  id: int("id").autoincrement().primaryKey(),
  /** FK to app_users.id — the user who placed/tracked this bet */
  userId: int("userId").notNull(),
  /** FK to games.id — the game this bet is on (null for manual/future bets) */
  gameId: int("gameId"),
  /** Action Network game id — links to AN scoreboard for slate display */
  anGameId: int("anGameId"),
  /**
   * Doubleheader game number: 1 = G1, 2 = G2.
   * Null/1 for non-doubleheader games or legacy bets created before this field was added.
   * Used to resolve the correct linescore when two games share the same away+home+date.
   * G1/G2 is determined by chronological start time (NOT gamePk order).
   * NOTE: gamePk order does NOT reliably match chronological order
   * (e.g. SF@PHI 2026-04-30: gamePk=823471 starts 21:35Z but gamePk=823472 starts 16:35Z).
   */
  gameNumber: int("gameNumber").default(1),
  /**
   * Timeframe of the bet:
   *   FULL_GAME    = Full game (default)
   *   FIRST_5      = First 5 innings (MLB)
   *   FIRST_INNING = First inning (MLB)
   */
  timeframe: mysqlEnum("timeframe", [
    "FULL_GAME",
    "FIRST_5",
    "FIRST_INNING",
    "NRFI",
    "YRFI",
    "REGULATION",
    "FIRST_PERIOD",
    "FIRST_HALF",
    "FIRST_QUARTER",
  ])
    .notNull()
    .default("FULL_GAME"),
  /**
   * Market of the bet:
   *   ML    = Moneyline
   *   RL    = Run Line / Puck Line / Spread
   *   TOTAL = Total (Over/Under)
   */
  market: mysqlEnum("market", ["ML", "RL", "TOTAL"])
    .notNull()
    .default("ML"),
  /**
   * Pick side:
   *   AWAY = Away team
   *   HOME = Home team
   *   OVER = Over (totals)
   *   UNDER = Under (totals)
   */
  pickSide: mysqlEnum("pickSide", ["AWAY", "HOME", "OVER", "UNDER"]),
  /** Sport: MLB | NBA | NHL | NCAAM | NFL | CUSTOM */
  sport: varchar("sport", { length: 16 }).notNull().default("MLB"),
  /** Game date in YYYY-MM-DD format */
  gameDate: varchar("gameDate", { length: 20 }).notNull(),
  /** Away team abbreviation/name, e.g. "TEX" */
  awayTeam: varchar("awayTeam", { length: 128 }),
  /** Home team abbreviation/name, e.g. "ATH" */
  homeTeam: varchar("homeTeam", { length: 128 }),
  /**
   * Bet type:
   *   ML = Moneyline
   *   RL = Run Line (spread)
   *   OVER = Total Over
   *   UNDER = Total Under
   *   PROP = Player/Game Prop
   *   PARLAY = Parlay
   *   TEASER = Teaser
   *   FUTURE = Futures bet
   *   CUSTOM = Custom/manual entry
   */
  betType: mysqlEnum("betType", ["ML", "RL", "OVER", "UNDER", "PROP", "PARLAY", "TEASER", "FUTURE", "CUSTOM"])
    .notNull()
    .default("ML"),
  /** The pick description, e.g. "TEX -125", "OVER 8.5 -110", "NYY ML +145" */
  pick: varchar("pick", { length: 255 }).notNull(),
  /**
   * The numeric line value for RL/Total bets (e.g. 1.5 for run line, 8.5 for total).
   * NULL for ML bets (not needed for grading).
   */
  line: decimal("line", { precision: 6, scale: 1 }),
  /** American odds, e.g. -125, +145, -110 */
  odds: int("odds").notNull(),
  /**
   * For a parlay: the ticket price EXACTLY as the user entered it, before any
   * leg was dropped. NULL for straight bets.
   *
   * This exists to make settlement idempotent. Grading re-runs every 30
   * minutes; if repricing worked by mutating `odds` in place, each sweep would
   * divide the price again and a pushed leg would decay the ticket toward
   * nothing. Every reprice is instead computed fresh from this value and the
   * CURRENT set of dropped legs, so running it twice changes nothing and a leg
   * corrected from PUSH back to WIN restores the original price.
   *
   * It is also what preserves a correlated (SGP) or boosted price, which is
   * not the product of its legs and therefore cannot be rebuilt from them.
   */
  originalOdds: int("originalOdds"),
  /**
   * Number of legs on a parlay; 0 for a straight bet.
   *
   * Denormalized on purpose: every list and stats read would otherwise need a
   * join or a subquery against tracked_bet_legs just to tell the two kinds of
   * row apart, on a path that is already latency-bound.
   */
  legCount: int("legCount").notNull().default(0),
  /** Risk amount in dollars (decimal, 2 decimal places) */
  risk: decimal("risk", { precision: 10, scale: 2 }).notNull(),
  /** To-win amount in dollars (auto-calculated: risk * (100/|odds|) for fav, risk * (odds/100) for dog) */
  toWin: decimal("toWin", { precision: 10, scale: 2 }).notNull(),
  /**
   * Risk amount expressed in units (e.g. 3.0 for a 3U play).
   * Stored at creation time so analytics can bucket correctly regardless of the user's unit size setting.
   */
  /**
   * Risk in units. scale 4, not 2.
   *
   * At scale 2 a stake small relative to the unit size loses real money to
   * rounding: the first production parlay risked $25 at a $100 unit and paid
   * $68.50, whose unit value 0.685 stored as 0.69 — implying $69.00. Five live
   * bets sit under 0.10 units where that error is proportionally largest.
   * Dollars are already scale 2; units divide dollars, so they need more.
   */
  riskUnits: decimal("riskUnits", { precision: 12, scale: 4 }),
  /**
   * To-win amount expressed in units (e.g. 5.0 for a 5U to-win play).
   * Stored at creation time for accurate bySize analytics.
   */
  /** To-win in units. scale 4 for the same reason as riskUnits. */
  toWinUnits: decimal("toWinUnits", { precision: 12, scale: 4 }),
  /** Sportsbook name, e.g. "DK NJ", "FanDuel NJ", "Caesars NJ" */
  book: varchar("book", { length: 64 }),
  /** Optional free-text notes */
  notes: text("notes"),
  /**
   * Bet result:
   *   PENDING = not yet graded
   *   WIN = bet won
   *   LOSS = bet lost
   *   PUSH = push/tie
   *   VOID = voided/cancelled
   */
  result: mysqlEnum("result", ["PENDING", "WIN", "LOSS", "PUSH", "VOID"])
    .notNull()
    .default("PENDING"),
  /**
   * Final score for the graded timeframe — populated by the auto-grade engine.
   * Stored as varchar to handle decimal scores (e.g. NCAAM) and avoid int precision loss.
   */
  awayScore: varchar("awayScore", { length: 16 }),
  homeScore: varchar("homeScore", { length: 16 }),
  /**
   * Wager type: PREGAME (placed before game starts) or LIVE (in-game live bet).
   * Defaults to PREGAME.
   */
  wagerType: mysqlEnum("wagerType", ["PREGAME", "LIVE"]).notNull().default("PREGAME"),
  /**
   * Custom line value for RL/Total bets — overrides the default 1.5/7.5 hardcoded line.
   * e.g. 8.0 for an Over 8 total, -1.5 for a standard run line.
   * NULL means use the default line for the market.
   */
  customLine: decimal("customLine", { precision: 6, scale: 1 }),
  /** UTC timestamp (ms) when this bet was created */
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  /** UTC timestamp (ms) when this bet was last updated */
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  idxUserId:        index("idx_tb_user_id").on(t.userId),
  idxGameId:        index("idx_tb_game_id").on(t.gameId),
  idxGameDate:      index("idx_tb_game_date").on(t.gameDate),
  idxSport:         index("idx_tb_sport").on(t.sport),
  idxResult:        index("idx_tb_result").on(t.result),
  /** Composite covering index: userId + sport + gameDate
   *  Eliminates full-table scans for list() and getStats() when filtering by sport + date range.
   *  MySQL uses this for: WHERE userId=X AND sport=Y AND gameDate BETWEEN A AND B */
  idxUserSportDate: index("idx_tb_user_sport_date").on(t.userId, t.sport, t.gameDate),
  /** Composite for userId + gameDate range scans (ALL sports, date-filtered queries) */
  idxUserDate:      index("idx_tb_user_date").on(t.userId, t.gameDate),
  /** Composite for userId + result queries (filter by WIN/LOSS/PENDING etc.) */
  idxUserResult:    index("idx_tb_user_result").on(t.userId, t.result),
  /** Composite for userId + result + gameDate — optimal for pending-bet auto-grade queries */
  idxUserResultDate: index("idx_tb_user_result_date").on(t.userId, t.result, t.gameDate),
  /**
   * The grading engine's hottest query — `WHERE result='PENDING' AND gameDate=?`
   * across ALL users, run by every polling cycle and every cron firing. Every
   * other composite leads with userId, which this query does not filter on, so
   * TiDB fell back to idx_tb_result(result) and filtered the date in a
   * Selection: it read every PENDING row in the table, every cycle.
   */
  idxResultDate: index("idx_tb_result_date").on(t.result, t.gameDate),
  /**
   * The create-path idempotency guard, which matches on
   * (userId, anGameId, gameNumber, market, pickSide, odds) inside a 30s window.
   * It resolved through idx_tb_user_id(userId) alone and filtered the rest —
   * a full scan of that user's history on every insert.
   */
  idxUserGame: index("idx_tb_user_game").on(t.userId, t.anGameId, t.gameNumber),
  /**
   * Covering index for the stats-cache fingerprint
   * (COUNT(*), MAX(updatedAt), SUM(id) WHERE userId = ?).
   *
   * Validating #330 against production showed the fingerprint resolving through
   * idx_tb_user_id(userId) and then doing a TableRowIDScan — it read the same
   * rows as the scan it exists to avoid. Leading with userId and carrying
   * updatedAt and id makes it an index-only scan, which is what the cache
   * design assumed.
   */
  idxUserFingerprint: index("idx_tb_user_fingerprint").on(t.userId, t.updatedAt, t.id),
}));

export type TrackedBet = typeof trackedBets.$inferSelect;
export type InsertTrackedBet = typeof trackedBets.$inferInsert;

// ─── Parlay legs ──────────────────────────────────────────────────────────────
/**
 * The legs of a parlay ticket. One row per selection; the parent row in
 * `tracked_bets` carries the single stake and the ticket price.
 *
 * A leg is deliberately shaped like a bet minus the money: it has everything
 * `gradeTrackedBet` needs (sport, date, teams, market, pickSide, line,
 * timeframe, anGameId, gameNumber) and nothing about stake, because the
 * contract puts one stake on the ticket and none on the legs.
 *
 * Straight bets have no rows here at all — `tracked_bets.legCount` is 0 and
 * every existing row keeps behaving exactly as before.
 */
export const trackedBetLegs = mysqlTable("tracked_bet_legs", {
  id: int("id").autoincrement().primaryKey(),
  /** FK to tracked_bets.id — the parlay ticket this leg belongs to. */
  betId: int("betId").notNull(),
  /** Display order within the ticket, 0-based. Pricing itself is order-free. */
  legIndex: int("legIndex").notNull(),
  /** Sport: MLB | NBA | NHL | NCAAM | NFL */
  sport: varchar("sport", { length: 16 }).notNull().default("MLB"),
  /** Game date in YYYY-MM-DD format */
  gameDate: varchar("gameDate", { length: 20 }).notNull(),
  awayTeam: varchar("awayTeam", { length: 128 }),
  homeTeam: varchar("homeTeam", { length: 128 }),
  /** Action Network game id, for the same game resolution straight bets use. */
  anGameId: int("anGameId"),
  /** Doubleheader discriminator, 1 or 2. */
  gameNumber: int("gameNumber").default(1),
  /** Market: ML | RL | TOTAL — the same vocabulary straight bets use. */
  market: mysqlEnum("market", ["ML", "RL", "TOTAL"]).notNull().default("ML"),
  pickSide: mysqlEnum("pickSide", ["AWAY", "HOME", "OVER", "UNDER"]),
  /** Timeframe, which is also where NRFI/YRFI live. */
  timeframe: mysqlEnum("timeframe", [
    "FULL_GAME", "FIRST_5", "FIRST_INNING", "NRFI", "YRFI",
    "REGULATION", "FIRST_PERIOD", "FIRST_HALF", "FIRST_QUARTER",
  ]).notNull().default("FULL_GAME"),
  /** Line for RL/TOTAL legs. NULL for ML, required for the other two. */
  line: decimal("line", { precision: 6, scale: 1 }),
  /**
   * The leg's own American price.
   *
   * Not decoration: repricing a ticket after a push divides this leg's decimal
   * price out of the ticket price, so a wrong value here mis-pays the ticket.
   */
  odds: int("odds").notNull(),
  /** Human-readable label, e.g. "NYY ML" or "OVER 8.5". */
  pick: varchar("pick", { length: 255 }).notNull(),
  /**
   * The leg's own outcome. PUSH/VOID mean the leg is dropped and the ticket
   * reprices; they do not settle the ticket by themselves.
   */
  result: mysqlEnum("result", ["PENDING", "WIN", "LOSS", "PUSH", "VOID"])
    .notNull()
    .default("PENDING"),
  /** Final scores for the graded timeframe, for audit. */
  awayScore: varchar("awayScore", { length: 16 }),
  homeScore: varchar("homeScore", { length: 16 }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
}, (t) => ({
  /** Load every leg of a ticket — the join behind reads and settlement. */
  idxLegBet: index("idx_tbl_bet").on(t.betId, t.legIndex),
  /**
   * The grading sweep's query: open legs for a given sport/date across all
   * tickets. Mirrors idx_tb_result_date on the parent for the same reason —
   * without it the sweep reads every open leg in the table each cycle.
   */
  idxLegResultDate: index("idx_tbl_result_date").on(t.result, t.gameDate),
}));

export type TrackedBetLeg = typeof trackedBetLegs.$inferSelect;
export type InsertTrackedBetLeg = typeof trackedBetLegs.$inferInsert;

// ─── Bet Edit Requests (porter/hank immutable bets — request changes via this table) ──
/**
 * When a handicapper (porter/hank) wants to edit or delete a tracked bet,
 * they submit a request here instead of modifying the bet directly.
 * Owner/Admin reviews and approves/denies the request.
 */
export const betEditRequests = mysqlTable("bet_edit_requests", {
  id: int("id").autoincrement().primaryKey(),
  /** FK to tracked_bets.id — the bet being requested to change */
  betId: int("betId").notNull(),
  /** FK to app_users.id — the handicapper making the request */
  requestedBy: int("requestedBy").notNull(),
  /**
   * Request type:
   *   EDIT   = modify fields on the bet
   *   DELETE = remove the bet from the tracker
   */
  requestType: mysqlEnum("requestType", ["EDIT", "DELETE"]).notNull(),
  /** JSON blob of the proposed changes (for EDIT requests) */
  proposedChanges: text("proposedChanges"),
  /** Free-text reason for the request */
  reason: text("reason"),
  /**
   * Status of the request:
   *   PENDING  = awaiting owner/admin review
   *   APPROVED = approved and applied
   *   DENIED   = denied by owner/admin
   */
  status: mysqlEnum("status", ["PENDING", "APPROVED", "DENIED"]).notNull().default("PENDING"),
  /** FK to app_users.id — the owner/admin who reviewed the request */
  reviewedBy: int("reviewedBy"),
  /** UTC timestamp (ms) when the request was reviewed */
  reviewedAt: timestamp("reviewedAt"),
  /** Optional note from the reviewer */
  reviewNote: text("reviewNote"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  idxBetId:       index("idx_ber_bet_id").on(t.betId),
  idxRequestedBy: index("idx_ber_requested_by").on(t.requestedBy),
  idxStatus:      index("idx_ber_status").on(t.status),
}));
export type BetEditRequest = typeof betEditRequests.$inferSelect;
export type InsertBetEditRequest = typeof betEditRequests.$inferInsert;

// ─── Discord Login CSRF state store (for Discord-as-primary-login) ───────────
//
// WHY SEPARATE FROM discordOAuthStates:
//   discordOAuthStates requires an existing userId (account linking only).
//   discordLoginStates is used when Discord IS the login method — no existing
//   user is required. The callback creates or finds the user by discordId.
//
// returnPath: the page to redirect to after successful login (e.g. "/betting-splits/MLB")
export const discordLoginStates = mysqlTable("discord_login_states", {
  /** Random CSRF state token generated in /login/connect */
  state:      varchar("state",      { length: 64 }).primaryKey(),
  /** The path to redirect to after successful login (e.g. "/betting-splits/MLB") */
  returnPath: varchar("returnPath", { length: 512 }).notNull().default("/"),
  /** UTC timestamp (ms) when this state expires (10 min from creation) */
  expiresAt:  bigint("expiresAt",   { mode: "number" }).notNull(),
  /** UTC timestamp (ms) when this row was created */
  createdAt:  bigint("createdAt",   { mode: "number" }).notNull(),
});
export type DiscordLoginState = typeof discordLoginStates.$inferSelect;
export type InsertDiscordLoginState = typeof discordLoginStates.$inferInsert;

// ─── Discord Invite Tokens (admin-generated, user-specific) ─────────────────
//
// Flow:
//   1. Admin clicks "Generate Unique Invite Link" for a user with no discordId.
//   2. Server creates a row here with a cryptographically random token (32 bytes → 64 hex chars).
//   3. Admin copies the link: /api/auth/discord-invite/connect?token=<hex>
//   4. User opens the link → server validates token → redirects to Discord OAuth
//      with scope=identify and a signed JWT state embedding the token + userId.
//   5. After Discord Authorize, callback validates state JWT, exchanges code,
//      fetches Discord profile, writes discordId/discordUsername/discordAvatar
//      to the target app_users row, marks token as used.
//   6. User is issued an app_session cookie and redirected to /feed.
//
// Security invariants:
//   - Token is single-use (usedAt set on first successful callback).
//   - Token expires after 7 days (expiresAt).
//   - Token is bound to a specific userId (targetUserId).
//   - Only one active token per user (old tokens revoked on new generation).
//   - Token is 32 random bytes (256-bit entropy) — brute force infeasible.
export const discordInviteTokens = mysqlTable("discord_invite_tokens", {
  /** 64-char hex string (32 random bytes) — the invite token */
  token:        varchar("token",        { length: 64  }).primaryKey(),
  /** The app_users.id this invite is for */
  targetUserId: int("targetUserId").notNull(),
  /** UTC timestamp (ms) when this token expires (7 days from creation) */
  expiresAt:    bigint("expiresAt",     { mode: "number" }).notNull(),
  /** UTC timestamp (ms) when this token was created */
  createdAt:    bigint("createdAt",     { mode: "number" }).notNull(),
  /** UTC timestamp (ms) when this token was successfully used; NULL = unused */
  usedAt:       bigint("usedAt",        { mode: "number" }),
  /** The Discord user ID that was linked when this token was used */
  linkedDiscordId: varchar("linkedDiscordId", { length: 32 }),
  /** Admin user ID who generated this token */
  createdBy:    int("createdBy").notNull(),
}, (t) => ({
  idxTargetUser: index("idx_dit_target_user").on(t.targetUserId),
  idxExpiresAt:  index("idx_dit_expires_at").on(t.expiresAt),
}));
export type DiscordInviteToken = typeof discordInviteTokens.$inferSelect;
export type InsertDiscordInviteToken = typeof discordInviteTokens.$inferInsert;

// ═══════════════════════════════════════════════════════════════════════════════
// WAITLIST
// Stores email sign-ups from the public landing page waitlist capture form.
// Status lifecycle: pending → approved | denied
// All timestamps are UTC milliseconds (bigint mode: "number").
// ═══════════════════════════════════════════════════════════════════════════════
export const waitlist = mysqlTable("waitlist", {
  id:          int("id").autoincrement().primaryKey(),

  /** Submitter's email address — unique, lowercase-normalised before insert */
  email:       varchar("email", { length: 320 }).notNull().unique(),

  /** Full name supplied in step 1 of the form */
  fullName:       varchar("full_name", { length: 256 }),

  /** Optional: why the user wants access (step 2) */
  whyText:        text("why_text"),

  /** Optional: unit size range lower bound in USD (step 2) */
  unitSizeMin:    int("unit_size_min"),

  /** Optional: unit size range upper bound in USD (step 2) */
  unitSizeMax:    int("unit_size_max"),

  /** Whether the user completed step 2 of the form */
  step2Completed: boolean("step2_completed").default(false),

  /**
   * Review status.
   *   pending  — newly submitted, not yet reviewed
   *   approved — owner approved; user will be notified / granted access
   *   denied   — owner denied; user will not receive access
   */
  status: mysqlEnum("status", ["pending", "approved", "denied"])
    .default("pending")
    .notNull(),

  /**
   * Optional free-text note left by the owner during review.
   * Visible only in the admin Waitlist page.
   */
  adminNote:   varchar("adminNote", { length: 1024 }),

  /**
   * IP address of the submitting client, stored for abuse detection.
   */
  ipAddress:   varchar("ipAddress", { length: 64 }),

  /**
   * User-Agent string of the submitting client, stored for abuse detection.
   */
  userAgent:   varchar("userAgent", { length: 512 }),

  /**
   * UTM source tag captured from the landing page URL at submission time.
   */
  utmSource:   varchar("utmSource", { length: 128 }),

  /**
   * UTM medium tag captured at submission time.
   */
  utmMedium:   varchar("utmMedium", { length: 128 }),

  /**
   * UTM campaign tag captured at submission time.
   */
  utmCampaign: varchar("utmCampaign", { length: 128 }),

  /** UTC ms timestamp when the owner last changed the status */
  reviewedAt:  bigint("reviewedAt", { mode: "number" }),

  /** app_users.id of the owner who last reviewed this entry (nullable) */
  reviewedBy:  int("reviewedBy"),

  /** UTC ms timestamp when the row was created (submission time) */
  createdAt:   bigint("createdAt", { mode: "number" }).notNull(),

  /** UTC ms timestamp of the last row update */
  updatedAt:   bigint("updatedAt", { mode: "number" }).notNull(),
}, (t) => ({
  idxEmail:     index("idx_waitlist_email").on(t.email),
  idxStatus:    index("idx_waitlist_status").on(t.status),
  idxCreatedAt: index("idx_waitlist_created_at").on(t.createdAt),
}));

export type WaitlistRow    = typeof waitlist.$inferSelect;
export type InsertWaitlist = typeof waitlist.$inferInsert;

// ═══════════════════════════════════════════════════════════════════════════════
// WC2026 — ESPN WORLD CUP 2026 MATCH DATA
// ═══════════════════════════════════════════════════════════════════════════════
//
// TERMINOLOGY RULE: All WC matches use "matches" terminology — never "games".
//
// TABLE MAP (8 tables — ALL ESPN-sourced, ALL prefixed wc2026_espn_):
//   wc2026_espn_matches         — master match record (game strip + competition info)
//   wc2026_espn_team_stats      — 8-row tmStatsGrph summary per match per team
//   wc2026_espn_match_stats     — 40-row full deferred stats (shots/passes/attack/defense/duels/fouls/xG/GK)
//   wc2026_espn_expected_goals  — xG / xGOT / xA team totals + per-player breakdown
//   wc2026_espn_shot_map        — every shot with field coords + goal position + attributes
//   wc2026_espn_player_stats    — per-player boxscore stats (outfield + GK) for both teams
//   wc2026_espn_lineups         — ESPN formation + starter/sub/unused per team per match
//   wc2026_espn_glossary        — ESPN stat abbreviation → display name (shared reference)
//
// INDEXING STRATEGY:
//   - All tables indexed on matchId (FK → wc2026_espn_matches.matchId)
//   - Team columns indexed for cross-match trend queries
//   - Player columns indexed for player-level trend queries
//   - Timestamps stored as UTC bigint (ms since epoch)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 1. wc2026_espn_matches ──────────────────────────────────────────────────
// Master match record. One row per ESPN match (gameId).
// Source: gameStrip from player-stats page __espnfitt__

export const wc2026EspnMatches = mysqlTable("wc2026_espn_matches", {
  id:             int("id").autoincrement().primaryKey(),

  // ESPN identifiers
  espnMatchId:    varchar("espn_match_id", { length: 32 }).notNull().unique(), // ESPN match ID (e.g. "760487")
  uid:            varchar("uid", { length: 64 }),                        // ESPN uid (e.g. "s:600~l:2014~e:760487")

  // Competition
  competition:    varchar("competition", { length: 128 }),               // "FIFA World Cup, Round of 32"
  round:          varchar("round", { length: 64 }),                      // "Round of 32" | "Group Stage" | etc.
  season:         varchar("season", { length: 16 }).default("2026"),

  // Timing
  matchDateUtc:   bigint("matchDateUtc", { mode: "number" }).notNull(),  // UTC ms kickoff time
  matchGameDate:  varchar("matchGameDate", { length: 10 }),              // PT kickoff date YYYY-MM-DD (midnight rule: 9PM PT Jun20 → "2026-06-20")
  matchKickoffEt: varchar("matchKickoffEt", { length: 8 }),              // ET kickoff time HH:MM 24h (midnight rule: 12:00 AM ET → "00:00")
  statusState:    varchar("statusState", { length: 32 }),                // "post" | "pre" | "in"
  statusDetail:   varchar("statusDetail", { length: 64 }),               // "Final" | "HT" | "90'"
  statusDisplay:  varchar("statusDisplay", { length: 32 }),              // "FT" | "LIVE" | etc.

  // Venue
  venue:          varchar("venue", { length: 128 }),                     // "NRG Stadium"
  city:           varchar("city", { length: 128 }),                      // "Houston, TX"
  attendance:     int("attendance"),
  referee:        varchar("referee", { length: 128 }),

  // Broadcast
  broadcasts:     text("broadcasts"),                                    // JSON array of strings

  // Home team
  homeTeamId:     varchar("homeTeamId", { length: 16 }).notNull(),
  homeTeamAbbrev: varchar("homeTeamAbbrev", { length: 8 }).notNull(),
  homeTeamName:   varchar("homeTeamName", { length: 64 }).notNull(),
  homeTeamLogo:   text("homeTeamLogo"),
  homeScore:      int("homeScore"),
  homeLinescores: text("homeLinescores"),                                // JSON array ["1","1"]
  homeGoalScorers:text("homeGoalScorers"),                               // JSON array [{id,name,clock}]
  homeRedCards:   text("homeRedCards"),                                  // JSON array of player names

  // Away team
  awayTeamId:     varchar("awayTeamId", { length: 16 }).notNull(),
  awayTeamAbbrev: varchar("awayTeamAbbrev", { length: 8 }).notNull(),
  awayTeamName:   varchar("awayTeamName", { length: 64 }).notNull(),
  awayTeamLogo:   text("awayTeamLogo"),
  awayScore:      int("awayScore"),
  awayLinescores: text("awayLinescores"),
  awayGoalScorers:text("awayGoalScorers"),
  awayRedCards:   text("awayRedCards"),

  // Formations
  homeFormation:  varchar("homeFormation", { length: 16 }),              // "4-3-3"
  awayFormation:  varchar("awayFormation", { length: 16 }),              // "3-4-2-1"

  // Scrape metadata
  scrapedAt:      bigint("scrapedAt", { mode: "number" }).notNull(),
  scrapeDurationMs: int("scrapeDurationMs"),
  scrapeVersion:  varchar("scrapeVersion", { length: 16 }).default("500x"),
  matchRound:     varchar("matchRound", { length: 32 }),                  // ESPN native slug: "group-stage"|"round-of-32"|etc.

  createdAt:      bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt:      bigint("updatedAt", { mode: "number" }).notNull(),
}, (t) => ({
  idxMatchId:     uniqueIndex("idx_wc2026_espn_matches_espnMatchId").on(t.espnMatchId),
  idxHomeTeam:    index("idx_wc2026_espn_matches_homeTeam").on(t.homeTeamAbbrev),
  idxAwayTeam:    index("idx_wc2026_espn_matches_awayTeam").on(t.awayTeamAbbrev),
  idxMatchDate:   index("idx_wc2026_espn_matches_date").on(t.matchDateUtc),
  idxRound:       index("idx_wc2026_espn_matches_round").on(t.round),
  idxMatchRound:  index("idx_wc2026_espn_matches_matchRound").on(t.matchRound),
}));
export type Wc2026EspnMatch       = typeof wc2026EspnMatches.$inferSelect;
export type InsertWc2026EspnMatch = typeof wc2026EspnMatches.$inferInsert;

// ─── 2. wc2026_espn_match_odds ── REMOVED (table deprecated & dropped 2026-07-03) ──

// ─── 3. wc2026_espn_team_stats ───────────────────────────────────────────────
// 8-row tmStatsGrph summary (Possession, SoG, Shot Attempts, Fouls, YC, RC, Corners, Saves).
// One row per stat per match (2 values per row: home + away).
// Source: tmStatsGrph from matchstats page __espnfitt__

export const wc2026EspnTeamStats = mysqlTable("wc2026_espn_team_stats", {
  id:             int("id").autoincrement().primaryKey(),
  espnMatchId:    varchar("espn_match_id", { length: 32 }).notNull(),

  homeTeamAbbrev: varchar("homeTeamAbbrev", { length: 8 }).notNull(),
  awayTeamAbbrev: varchar("awayTeamAbbrev", { length: 8 }).notNull(),

  // 8 summary stats (stored as individual columns for direct querying)
  possession:     varchar("possession", { length: 8 }),                  // "68.6%"
  shotsOnGoal:    int("shotsOnGoal"),                                    // home value (int)
  shotsOnGoalAway:int("shotsOnGoalAway"),
  shotAttempts:   int("shotAttempts"),
  shotAttemptsAway:int("shotAttemptsAway"),
  fouls:          int("fouls"),
  foulsAway:      int("foulsAway"),
  yellowCards:    int("yellowCards"),
  yellowCardsAway:int("yellowCardsAway"),
  redCards:       int("redCards"),
  redCardsAway:   int("redCardsAway"),
  cornerKicks:    int("cornerKicks"),
  cornerKicksAway:int("cornerKicksAway"),
  saves:          int("saves"),
  savesAway:      int("savesAway"),
  possessionAway: varchar("possessionAway", { length: 8 }),

  matchRound:     varchar("matchRound", { length: 32 }),                  // ESPN native slug: "group-stage"|"round-of-32"|etc.
  createdAt:      bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt:      bigint("updatedAt", { mode: "number" }).notNull(),
}, (t) => ({
  idxMatchId:     uniqueIndex("idx_wc2026_espn_team_stats_espnMatchId").on(t.espnMatchId),
  idxHomeTeam:    index("idx_wc2026_espn_team_stats_homeTeam").on(t.homeTeamAbbrev),
  idxAwayTeam:    index("idx_wc2026_espn_team_stats_awayTeam").on(t.awayTeamAbbrev),
  idxMatchRound:  index("idx_wc2026_espn_team_stats_matchRound").on(t.matchRound),
}));
export type Wc2026EspnTeamStats       = typeof wc2026EspnTeamStats.$inferSelect;
export type InsertWc2026EspnTeamStats = typeof wc2026EspnTeamStats.$inferInsert;

// ─── 4. wc2026_espn_match_stats ──────────────────────────────────────────────
// All 40 deferred stat rows (shots + passes + attack + xG + GK + defense + duels + fouls).
// Stored as individual columns for direct SQL trend querying — no JSON blobs.
// Source: shtsTbls + pssTbls + attkTbls + tmStatsTbls from team-stats page __espnfitt__
// NOTE: Prefixed wc2026_espn_ to avoid conflict with wc2026_match_stats in wc2026.schema.ts

export const wc2026EspnMatchStats = mysqlTable("wc2026_espn_match_stats", {
  id:                       int("id").autoincrement().primaryKey(),
  espnMatchId:              varchar("espn_match_id", { length: 32 }).notNull(),
  homeTeamAbbrev:           varchar("homeTeamAbbrev", { length: 8 }).notNull(),
  awayTeamAbbrev:           varchar("awayTeamAbbrev", { length: 8 }).notNull(),

  // ── SHOTS (shtsTbls — 6 rows) ──────────────────────────────────────────────
  homeShotsOnGoal:          int("homeShotsOnGoal"),
  awayShotsOnGoal:          int("awayShotsOnGoal"),
  homeShots:                int("homeShots"),
  awayShots:                int("awayShots"),
  homeShotsBlocked:         int("homeShotsBlocked"),
  awayShotsBlocked:         int("awayShotsBlocked"),
  homeHitWoodwork:          int("homeHitWoodwork"),
  awayHitWoodwork:          int("awayHitWoodwork"),
  homeAttemptsInsideBox:    int("homeAttemptsInsideBox"),
  awayAttemptsInsideBox:    int("awayAttemptsInsideBox"),
  homeAttemptsOutsideBox:   int("homeAttemptsOutsideBox"),
  awayAttemptsOutsideBox:   int("awayAttemptsOutsideBox"),

  // ── PASSES (pssTbls — 8 rows) ──────────────────────────────────────────────
  homeAccuratePasses:       int("homeAccuratePasses"),
  awayAccuratePasses:       int("awayAccuratePasses"),
  homePassAccuracyPct:      varchar("homePassAccuracyPct", { length: 8 }),   // "92%"
  awayPassAccuracyPct:      varchar("awayPassAccuracyPct", { length: 8 }),
  homePasses:               int("homePasses"),
  awayPasses:               int("awayPasses"),
  homeTotalBackZonePass:    int("homeTotalBackZonePass"),
  awayTotalBackZonePass:    int("awayTotalBackZonePass"),
  homeTotalForwardZonePass: int("homeTotalForwardZonePass"),
  awayTotalForwardZonePass: int("awayTotalForwardZonePass"),
  homeAccurateLongBalls:    int("homeAccurateLongBalls"),
  awayAccurateLongBalls:    int("awayAccurateLongBalls"),
  homeAccurateCrosses:      int("homeAccurateCrosses"),
  awayAccurateCrosses:      int("awayAccurateCrosses"),
  homeTotalThrows:          int("homeTotalThrows"),
  awayTotalThrows:          int("awayTotalThrows"),
  homePassTouchesInOppBox:  int("homePassTouchesInOppBox"),
  awayPassTouchesInOppBox:  int("awayPassTouchesInOppBox"),

  // ── ATTACK (attkTbls — 6 rows) ─────────────────────────────────────────────
  homeBigChancesCreated:    int("homeBigChancesCreated"),
  awayBigChancesCreated:    int("awayBigChancesCreated"),
  homeBigChancesMissed:     int("homeBigChancesMissed"),
  awayBigChancesMissed:     int("awayBigChancesMissed"),
  homeThroughBalls:         int("homeThroughBalls"),
  awayThroughBalls:         int("awayThroughBalls"),
  homeAttkTouchesInOppBox:  int("homeAttkTouchesInOppBox"),
  awayAttkTouchesInOppBox:  int("awayAttkTouchesInOppBox"),
  homeFouledInFinalThird:   int("homeFouledInFinalThird"),
  awayFouledInFinalThird:   int("awayFouledInFinalThird"),
  homeCornersWon:           int("homeCornersWon"),
  awayCornersWon:           int("awayCornersWon"),

  // ── EXPECTED GOALS (tmStatsTbls[expected-goals] — 4 rows) ──────────────────
  homeXG:                   decimal("homeXG", { precision: 6, scale: 3 }),
  awayXG:                   decimal("awayXG", { precision: 6, scale: 3 }),
  homeXGOpenPlay:           decimal("homeXGOpenPlay", { precision: 6, scale: 3 }),
  awayXGOpenPlay:           decimal("awayXGOpenPlay", { precision: 6, scale: 3 }),
  homeXGSetPlay:            decimal("homeXGSetPlay", { precision: 6, scale: 3 }),
  awayXGSetPlay:            decimal("awayXGSetPlay", { precision: 6, scale: 3 }),
  homeXGOT:                 decimal("homeXGOT", { precision: 6, scale: 3 }),
  awayXGOT:                 decimal("awayXGOT", { precision: 6, scale: 3 }),

  // ── GOALKEEPING (tmStatsTbls[goalkeeping] — 5 rows) ────────────────────────
  homeGkSaves:              int("homeGkSaves"),
  awayGkSaves:              int("awayGkSaves"),
  homeGoalKicks:            int("homeGoalKicks"),
  awayGoalKicks:            int("awayGoalKicks"),
  homeShotsFaced:           int("homeShotsFaced"),
  awayShotsFaced:           int("awayShotsFaced"),
  homeTotalHighClaims:      int("homeTotalHighClaims"),
  awayTotalHighClaims:      int("awayTotalHighClaims"),
  homePenaltyKicksSaved:    int("homePenaltyKicksSaved"),
  awayPenaltyKicksSaved:    int("awayPenaltyKicksSaved"),

  // ── DEFENSE (tmStatsTbls[defense] — 4 rows) ────────────────────────────────
  homeTackles:              int("homeTackles"),
  awayTackles:              int("awayTackles"),
  homeInterceptions:        int("homeInterceptions"),
  awayInterceptions:        int("awayInterceptions"),
  homeClearances:           int("homeClearances"),
  awayClearances:           int("awayClearances"),
  homeRecoveries:           int("homeRecoveries"),
  awayRecoveries:           int("awayRecoveries"),

  // ── DUELS (tmStatsTbls[duels] — 3 rows) ────────────────────────────────────
  homeDuelsWon:             int("homeDuelsWon"),
  awayDuelsWon:             int("awayDuelsWon"),
  homeDuels:                int("homeDuels"),
  awayDuels:                int("awayDuels"),
  homeAerialsWon:           int("homeAerialsWon"),
  awayAerialsWon:           int("awayAerialsWon"),

  // ── FOULS & DISCIPLINE (tmStatsTbls[fouls] — 4 rows) ───────────────────────
  homeFoulsCommitted:       int("homeFoulsCommitted"),
  awayFoulsCommitted:       int("awayFoulsCommitted"),
  homeOffsides:             int("homeOffsides"),
  awayOffsides:             int("awayOffsides"),
  homeFoulYellowCards:      int("homeFoulYellowCards"),
  awayFoulYellowCards:      int("awayFoulYellowCards"),
  homeFoulRedCards:         int("homeFoulRedCards"),
  awayFoulRedCards:         int("awayFoulRedCards"),

  matchRound:               varchar("matchRound", { length: 32 }),        // ESPN native slug: "group-stage"|"round-of-32"|etc.
  createdAt:                bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt:                bigint("updatedAt", { mode: "number" }).notNull(),
}, (t) => ({
  idxMatchId:               uniqueIndex("idx_wc2026_match_stats_espnMatchId").on(t.espnMatchId),
  idxHomeTeam:              index("idx_wc2026_match_stats_homeTeam").on(t.homeTeamAbbrev),
  idxAwayTeam:              index("idx_wc2026_match_stats_awayTeam").on(t.awayTeamAbbrev),
  idxMatchRound:            index("idx_wc2026_match_stats_matchRound").on(t.matchRound),
}));
export type Wc2026EspnMatchStats       = typeof wc2026EspnMatchStats.$inferSelect;
export type InsertWc2026EspnMatchStats = typeof wc2026EspnMatchStats.$inferInsert;

// ─── 5. wc2026_espn_expected_goals ───────────────────────────────────────────
// Team-level xG totals + per-player xG/xA breakdown.
// Source: mtchStatsGrph + boxscore from matchstats/player-stats pages

export const wc2026EspnExpectedGoals = mysqlTable("wc2026_espn_expected_goals", {
  id:                  int("id").autoincrement().primaryKey(),
  espnMatchId:         varchar("espn_match_id", { length: 32 }).notNull(),

  // Team totals
  homeTeamAbbrev:      varchar("homeTeamAbbrev", { length: 8 }).notNull(),
  awayTeamAbbrev:      varchar("awayTeamAbbrev", { length: 8 }).notNull(),
  homeXG:              decimal("homeXG", { precision: 6, scale: 3 }),
  awayXG:              decimal("awayXG", { precision: 6, scale: 3 }),
  homeXGOpenPlay:      decimal("homeXGOpenPlay", { precision: 6, scale: 3 }),
  awayXGOpenPlay:      decimal("awayXGOpenPlay", { precision: 6, scale: 3 }),
  homeXGSetPlay:       decimal("homeXGSetPlay", { precision: 6, scale: 3 }),
  awayXGSetPlay:       decimal("awayXGSetPlay", { precision: 6, scale: 3 }),
  homeXGOT:            decimal("homeXGOT", { precision: 6, scale: 3 }),
  awayXGOT:            decimal("awayXGOT", { precision: 6, scale: 3 }),
  homeXA:              decimal("homeXA", { precision: 6, scale: 3 }),
  awayXA:              decimal("awayXA", { precision: 6, scale: 3 }),

  // Per-player xG/xA stored as JSON array [{name, team, xG, xA}]
  perPlayerJson:       text("perPlayerJson"),

  matchRound:          varchar("matchRound", { length: 32 }),              // ESPN native slug: "group-stage"|"round-of-32"|etc.
  createdAt:           bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt:           bigint("updatedAt", { mode: "number" }).notNull(),
}, (t) => ({
  idxMatchId:          uniqueIndex("idx_wc2026_espn_xg_espnMatchId").on(t.espnMatchId),
  idxHomeTeam:         index("idx_wc2026_espn_xg_homeTeam").on(t.homeTeamAbbrev),
  idxAwayTeam:         index("idx_wc2026_espn_xg_awayTeam").on(t.awayTeamAbbrev),
  idxMatchRound:       index("idx_wc2026_espn_xg_matchRound").on(t.matchRound),
}));
export type Wc2026EspnExpectedGoals       = typeof wc2026EspnExpectedGoals.$inferSelect;
export type InsertWc2026EspnExpectedGoals = typeof wc2026EspnExpectedGoals.$inferInsert;

// ─── 6. wc2026_espn_shot_map ─────────────────────────────────────────────────
// Every shot with field coordinates, goal position, player, and xG attributes.
// One row per shot. Source: shtMp from matchstats page __espnfitt__

export const wc2026EspnShotMap = mysqlTable("wc2026_espn_shot_map", {
  id:              int("id").autoincrement().primaryKey(),
  espnMatchId:     varchar("espn_match_id", { length: 32 }).notNull(),

  // Shot identity
  shotId:          varchar("shotId", { length: 32 }),
  sequence:        int("sequence"),

  // Player
  playerId:        varchar("playerId", { length: 32 }),
  playerName:      varchar("playerName", { length: 128 }),
  playerShortName: varchar("playerShortName", { length: 64 }),
  playerJersey:    varchar("playerJersey", { length: 4 }),
  teamAbbrev:      varchar("teamAbbrev", { length: 8 }),
  isAway:          tinyint("isAway"),                                    // 0=home, 1=away

  // Timing
  period:          int("period"),                                        // 1 or 2 (or 3/4 for ET)
  clock:           varchar("clock", { length: 8 }),                     // "14'"

  // Shot result
  iconType:        varchar("iconType", { length: 16 }),                  // "goal"|"save"|"offTarget"|"blocked"
  isOwnGoal:       tinyint("isOwnGoal"),

  // Field coordinates (0–100 scale, origin = attacking goal)
  fieldStartX:     decimal("fieldStartX", { precision: 6, scale: 2 }),
  fieldStartY:     decimal("fieldStartY", { precision: 6, scale: 2 }),
  fieldEndX:       decimal("fieldEndX", { precision: 6, scale: 2 }),
  fieldEndY:       decimal("fieldEndY", { precision: 6, scale: 2 }),

  // Goal frame position (0–100 scale)
  goalPositionY:   decimal("goalPositionY", { precision: 6, scale: 2 }),
  goalPositionZ:   decimal("goalPositionZ", { precision: 6, scale: 2 }),

  // xG attributes
  xG:              decimal("xG", { precision: 6, scale: 4 }),
  xGOT:            decimal("xGOT", { precision: 6, scale: 4 }),
  distance:        varchar("distance", { length: 16 }),                  // "25 yds"
  shotType:        varchar("shotType", { length: 32 }),                  // "Left Foot"
  situation:       varchar("situation", { length: 32 }),                 // "Regular Play"
  goalZone:        varchar("goalZone", { length: 32 }),                  // "Low Left"

  // Description
  description:     text("description"),
  shortDescription:varchar("shortDescription", { length: 255 }),

  matchRound:      varchar("matchRound", { length: 32 }),                  // ESPN native slug: "group-stage"|"round-of-32"|etc.
  createdAt:       bigint("createdAt", { mode: "number" }).notNull(),
}, (t) => ({
  idxMatchId:      index("idx_wc2026_espn_shots_espnMatchId").on(t.espnMatchId),
  idxPlayer:       index("idx_wc2026_espn_shots_player").on(t.playerId),
  idxTeam:         index("idx_wc2026_espn_shots_team").on(t.teamAbbrev),
  idxIconType:     index("idx_wc2026_espn_shots_iconType").on(t.iconType),
  idxMatchRound:   index("idx_wc2026_espn_shots_matchRound").on(t.matchRound),
}));
export type Wc2026EspnShotMap       = typeof wc2026EspnShotMap.$inferSelect;
export type InsertWc2026EspnShotMap = typeof wc2026EspnShotMap.$inferInsert;

// ─── 7. wc2026_espn_player_stats ─────────────────────────────────────────────
// Per-player boxscore stats for both outfield players and goalkeepers.
// One row per player per match. Source: bxscr from player-stats page __espnfitt__
//
// OUTFIELD COLUMNS (ESPN abbreviations — see wc2026_glossary):
//   TCH (Touches) | G (Goals) | A (Assists) | xG | xA | SOG (SoG) | SHOT (Shots)
//   BCC (Big Chances Created) | DINT (Defensive Interventions) | DUELW (Duels Won)
//
// GK COLUMNS:
//   GA (Goals Conceded) | SV (Saves) | SOGA (Shots On Goal Against)
//   xGC (xG Conceded) | xGOTC (xGOT Conceded) | GP (Goals Prevented)
//   BCS (Big Chance Saves) | CLR (Clearances) | CC (Crosses Claimed) | KS (Keeper Sweepers)

export const wc2026EspnPlayerStats = mysqlTable("wc2026_espn_player_stats", {
  id:              int("id").autoincrement().primaryKey(),
  espnMatchId:     varchar("espn_match_id", { length: 32 }).notNull(),

  // Player identity
  athleteId:       varchar("athleteId", { length: 32 }).notNull(),
  name:            varchar("name", { length: 128 }).notNull(),
  nameShort:       varchar("nameShort", { length: 64 }),
  jersey:          varchar("jersey", { length: 4 }),
  teamAbbrev:      varchar("teamAbbrev", { length: 8 }).notNull(),
  teamName:        varchar("teamName", { length: 64 }),
  isHome:          tinyint("isHome").notNull(),                          // 1=home team, 0=away
  positionGroup:   varchar("positionGroup", { length: 32 }),             // "Forwards"|"Midfielders"|"Defenders"|"Goalkeepers"
  isGoalkeeper:    tinyint("isGoalkeeper").default(0).notNull(),

  // ── OUTFIELD STATS (ESPN abbreviations) ────────────────────────────────────
  tch:             int("tch"),                                           // TCH: Touches
  g:               int("g"),                                             // G: Total Goals
  a:               int("a"),                                             // A: Assists
  xG:              decimal("xG", { precision: 6, scale: 4 }),            // xG: Expected Goals
  xA:              decimal("xA", { precision: 6, scale: 4 }),            // xA: Expected Assists
  sog:             int("sog"),                                           // SOG: Shots on Goal
  shot:            int("shot"),                                          // SHOT: Shots
  bcc:             int("bcc"),                                           // BCC: Big Chances Created
  dint:            int("dint"),                                          // DINT: Defensive Interventions
  duelw:           int("duelw"),                                         // DUELW: Duels Won

  // ── GOALKEEPER STATS (ESPN abbreviations) ──────────────────────────────────
  ga:              int("ga"),                                            // GA: Goals Conceded
  sv:              int("sv"),                                            // SV: Saves
  soga:            int("soga"),                                          // SOGA: Shots On Goal Against
  xGC:             decimal("xGC", { precision: 6, scale: 4 }),           // xGC: Expected Goals Conceded
  xGOTC:           decimal("xGOTC", { precision: 6, scale: 4 }),         // xGOTC: Expected Goals On Target Conceded
  gp:              decimal("gp", { precision: 6, scale: 4 }),            // GP: Goals Prevented (can be negative)
  bcs:             int("bcs"),                                           // BCS: Big Chance Saves
  clr:             int("clr"),                                           // CLR: Clearances
  cc:              int("cc"),                                            // CC: Crosses Claimed
  ks:              int("ks"),                                            // KS: Keeper Sweepers

  // ── LINEUP STATS (from lineUps section) ────────────────────────────────────
  appearances:     int("appearances"),
  foulsCommitted:  int("foulsCommitted"),
  foulsSuffered:   int("foulsSuffered"),
  ownGoals:        int("ownGoals"),
  redCards:        int("redCards"),
  subIns:          int("subIns"),
  yellowCards:     int("yellowCards"),
  offsides:        int("offsides"),
  shotsFaced:      int("shotsFaced"),                                    // GK only

  matchRound:      varchar("matchRound", { length: 32 }),                  // ESPN native slug: "group-stage"|"round-of-32"|etc.
  createdAt:       bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt:       bigint("updatedAt", { mode: "number" }).notNull(),
}, (t) => ({
  idxMatchPlayer:  uniqueIndex("idx_wc2026_espn_player_stats_match_player").on(t.espnMatchId, t.athleteId),
  idxMatchId:      index("idx_wc2026_espn_player_stats_espnMatchId").on(t.espnMatchId),
  idxAthleteId:    index("idx_wc2026_espn_player_stats_athleteId").on(t.athleteId),
  idxTeam:         index("idx_wc2026_espn_player_stats_team").on(t.teamAbbrev),
  idxPosition:     index("idx_wc2026_espn_player_stats_position").on(t.positionGroup),
  idxMatchRound:   index("idx_wc2026_espn_player_stats_matchRound").on(t.matchRound),
}));
export type Wc2026EspnPlayerStats       = typeof wc2026EspnPlayerStats.$inferSelect;
export type InsertWc2026EspnPlayerStats = typeof wc2026EspnPlayerStats.$inferInsert;

// ─── 8. wc2026_espn_lineups ──────────────────────────────────────────────────
// ESPN confirmed formation + starter/substitute/unused lists per team per match.
// One row per player per match. Source: lineUps from player-stats page __espnfitt__
// NOTE: Prefixed wc2026_espn_ to avoid conflict with wc2026_lineups in wc2026.schema.ts

export const wc2026EspnLineups = mysqlTable("wc2026_espn_lineups", {
  id:              int("id").autoincrement().primaryKey(),
  espnMatchId:     varchar("espn_match_id", { length: 32 }).notNull(),

  // Team
  teamId:          varchar("teamId", { length: 16 }),
  teamAbbrev:      varchar("teamAbbrev", { length: 8 }).notNull(),
  teamName:        varchar("teamName", { length: 64 }),
  teamLogo:        text("teamLogo"),
  teamColor:       varchar("teamColor", { length: 8 }),
  formation:       varchar("formation", { length: 16 }),                 // "4-3-3"
  isHome:          tinyint("isHome").notNull(),

  // Player
  athleteId:       varchar("athleteId", { length: 32 }).notNull(),
  name:            varchar("name", { length: 128 }).notNull(),
  nameShort:       varchar("nameShort", { length: 64 }),
  jersey:          varchar("jersey", { length: 4 }),
  formationPlace:  varchar("formationPlace", { length: 4 }),             // "1"–"11" for starters
  role:            mysqlEnum("role", ["starter", "substitute", "unused"]).notNull(),

  matchRound:      varchar("matchRound", { length: 32 }),                  // ESPN native slug: "group-stage"|"round-of-32"|etc.
  createdAt:       bigint("createdAt", { mode: "number" }).notNull(),
}, (t) => ({
  idxMatchPlayer:  uniqueIndex("idx_wc2026_espn_lineups_match_player").on(t.espnMatchId, t.athleteId),
  idxMatchId:      index("idx_wc2026_espn_lineups_espnMatchId").on(t.espnMatchId),
  idxAthleteId:    index("idx_wc2026_espn_lineups_athleteId").on(t.athleteId),
  idxTeam:         index("idx_wc2026_espn_lineups_team").on(t.teamAbbrev),
  idxRole:         index("idx_wc2026_espn_lineups_role").on(t.role),
  idxMatchRound:   index("idx_wc2026_espn_lineups_matchRound").on(t.matchRound),
}));
export type Wc2026EspnLineup       = typeof wc2026EspnLineups.$inferSelect;
export type InsertWc2026EspnLineup = typeof wc2026EspnLineups.$inferInsert;

// ─── 9. wc2026_espn_glossary ─────────────────────────────────────────────────
// ESPN stat abbreviation → full display name. Shared reference table.
// Populated once from the ESPN boxscore glossary HTML.
// 20 confirmed abbreviations from forensic audit of gameId 760487.
//
// CONFIRMED ENTRIES (from pasted_content_49.txt + live scraper):
//   A     → Assists
//   BCC   → Big Chances Created
//   BCS   → Big Chance Saves
//   CC    → Crosses Claimed
//   CLR   → Clearances
//   DINT  → Defensive Interventions
//   DUELW → Duels Won
//   G     → Total Goals
//   GA    → Goals Conceded
//   GP    → Goals Prevented
//   KS    → Keeper Sweepers
//   SHOT  → Shots
//   SOG   → Shots on Goal
//   SOGA  → Shots On Goal Against
//   SV    → Saves
//   TCH   → Touches
//   xA    → Expected Assists
//   xG    → Expected Goals
//   xGC   → Expected Goals Conceded
//   xGOTC → Expected Goals On Target Conceded

export const wc2026EspnGlossary = mysqlTable("wc2026_espn_glossary", {
  id:           int("id").autoincrement().primaryKey(),
  abbreviation: varchar("abbreviation", { length: 16 }).notNull().unique(),
  displayName:  varchar("displayName", { length: 128 }).notNull(),
  category:     mysqlEnum("category", ["outfield", "goalkeeper", "both"]).default("both").notNull(),
  description:  text("description"),                                     // optional extended definition
  matchRound:   varchar("matchRound", { length: 32 }),                    // ESPN native slug: "group-stage"|"round-of-32"|etc.
  createdAt:    bigint("createdAt", { mode: "number" }).notNull(),
  updatedAt:    bigint("updatedAt", { mode: "number" }).notNull(),
}, (t) => ({
  idxAbbrev:    uniqueIndex("idx_wc2026_espn_glossary_abbrev").on(t.abbreviation),
  idxCategory:  index("idx_wc2026_espn_glossary_category").on(t.category),
}));
export type Wc2026EspnGlossaryEntry       = typeof wc2026EspnGlossary.$inferSelect;
export type InsertWc2026EspnGlossaryEntry = typeof wc2026EspnGlossary.$inferInsert;


// ─── wc2026MatchOdds ─────────────────────────────────────────────────────────
// MOVED to drizzle/wc2026.schema.ts (canonical definition).
// DB-008 fix: removed duplicate to unblock drizzle-kit generate.
// Re-export TYPES ONLY (table export removed — drizzle-kit treats re-exported
// tables from files already in its schema array as duplicates).
// Importers of the TABLE must use: import { wc2026MatchOdds } from "../../drizzle/wc2026.schema";
export type { SelectWc2026MatchOdds as Wc2026MatchOddsRow, InsertWc2026MatchOdds } from "./wc2026.schema";
// END wc2026MatchOdds re-export

// ─────────────────────────────────────────────────────────────────────────────
// Dime Chat history (2026-07-12) — persistent AI Model chat conversations.
// Threads belong to one app_user; deletion is SOFT (deletedAt set): the row is
// hidden from every user-facing query but retained in the database per product
// direction. Messages are append-only, ordered by seq within a thread.
// ─────────────────────────────────────────────────────────────────────────────

export const dimeChatThreads = mysqlTable(
  "dime_chat_threads",
  {
    id: int("id").autoincrement().primaryKey(),
    /** FK to app_users.id — the owner of this conversation */
    userId: int("userId").notNull(),
    /** Title derived from the first user message (max 80 chars) */
    title: varchar("title", { length: 80 }).notNull(),
    starred: boolean("starred").default(false).notNull(),
    archived: boolean("archived").default(false).notNull(),
    /** Soft delete: set = hidden from all user-facing queries, retained in DB */
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  t => ({
    idxUserUpdated: index("idx_dime_chat_threads_user_updated").on(
      t.userId,
      t.updatedAt
    ),
  })
);

export const dimeChatMessages = mysqlTable(
  "dime_chat_messages",
  {
    id: int("id").autoincrement().primaryKey(),
    /** FK to dime_chat_threads.id */
    threadId: int("threadId").notNull(),
    /** Trace v1 session UUID. NULL only for messages created before Trace v1. */
    sessionId: varchar("sessionId", { length: 36 }),
    /** Trace v1 logical turn UUID. NULL only for pre-Trace-v1 messages. */
    turnId: varchar("turnId", { length: 36 }),
    /** Browser-generated UUID used only for idempotent message correlation. */
    clientMessageId: varchar("clientMessageId", { length: 36 }),
    /** Generation UUID for assistant output; user rows link to the first attempt. */
    generationId: varchar("generationId", { length: 36 }),
    /** 1-based position within the thread */
    seq: int("seq").notNull(),
    role: mysqlEnum("role", ["user", "assistant"]).notNull(),
    content: text("content").notNull(),
    /** SHA-256 of the exact persisted user-visible content. */
    contentSha256: varchar("contentSha256", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({
    idxThreadSeq: uniqueIndex("uq_dime_chat_messages_thread_seq").on(
      t.threadId,
      t.seq
    ),
    idxThreadClientMessage: uniqueIndex(
      "idx_dime_chat_messages_thread_client_message"
    ).on(t.threadId, t.clientMessageId),
    idxTurn: index("idx_dime_chat_messages_turn").on(t.turnId),
    idxGeneration: index("idx_dime_chat_messages_generation").on(
      t.generationId
    ),
  })
);

/**
 * Trace v1 — one authenticated browser chat session.
 *
 * `clientSessionId` is an opaque UUID generated by the browser. It never
 * carries identity; the server binds it to the authenticated app user.
 */
export const dimeChatSessions = mysqlTable(
  "dime_chat_sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull(),
    clientSessionId: varchar("clientSessionId", { length: 36 }).notNull(),
    surface: varchar("surface", { length: 32 })
      .default("dime-chat-web")
      .notNull(),
    policyVersion: varchar("policyVersion", { length: 32 }).notNull(),
    retentionClass: mysqlEnum("retentionClass", [
      "product_history",
      "restricted_quality",
    ])
      .default("product_history")
      .notNull(),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
  },
  t => ({
    idxUserClientSession: uniqueIndex(
      "idx_dime_chat_sessions_user_client_session"
    ).on(t.userId, t.clientSessionId),
    idxUserLastSeen: index("idx_dime_chat_sessions_user_last_seen").on(
      t.userId,
      t.lastSeenAt
    ),
  })
);

/**
 * Trace v1 — one logical user turn.
 *
 * A retry is another generation attempt under the same turn. The user prompt
 * is therefore stored exactly once while every model attempt remains
 * independently auditable.
 */
export const dimeChatTurns = mysqlTable(
  "dime_chat_turns",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull(),
    sessionId: varchar("sessionId", { length: 36 }).notNull(),
    threadId: int("threadId").notNull(),
    clientTurnId: varchar("clientTurnId", { length: 36 }).notNull(),
    userMessageId: int("userMessageId").notNull(),
    assistantMessageId: int("assistantMessageId"),
    lastGenerationId: varchar("lastGenerationId", { length: 36 }).notNull(),
    inputSha256: varchar("inputSha256", { length: 64 }).notNull(),
    requestClass: varchar("requestClass", { length: 32 }).notNull(),
    responseBudget: int("responseBudget").notNull(),
    status: mysqlEnum("status", [
      "generating",
      "completed",
      "blocked",
      "failed",
      "aborted",
    ])
      .default("generating")
      .notNull(),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  t => ({
    idxSessionClientTurn: uniqueIndex(
      "idx_dime_chat_turns_session_client_turn"
    ).on(t.sessionId, t.clientTurnId),
    idxThreadStarted: index("idx_dime_chat_turns_thread_started").on(
      t.threadId,
      t.startedAt
    ),
    idxUserStarted: index("idx_dime_chat_turns_user_started").on(
      t.userId,
      t.startedAt
    ),
    idxLastGeneration: index("idx_dime_chat_turns_last_generation").on(
      t.lastGenerationId
    ),
  })
);

/**
 * Trace v1 — one provider attempt, including exact inputs/outputs needed for
 * quality review. Raw output and context are restricted QA data and receive a
 * 90-day purge timestamp; user-visible history remains in dime_chat_messages.
 */
export const dimeChatGenerations = mysqlTable(
  "dime_chat_generations",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    turnId: varchar("turnId", { length: 36 }).notNull(),
    userId: int("userId").notNull(),
    requestId: varchar("requestId", { length: 36 }).notNull(),
    idempotencyKey: varchar("idempotencyKey", { length: 36 }).notNull(),
    /** Preserves null-vs-existing-thread semantics for idempotent replay. */
    requestedThreadId: int("requestedThreadId"),
    clientAssistantMessageId: varchar("clientAssistantMessageId", {
      length: 36,
    }).notNull(),
    attempt: int("attempt").notNull(),
    inputSha256: varchar("inputSha256", { length: 64 }).notNull(),
    requestFingerprintSha256: varchar("requestFingerprintSha256", {
      length: 64,
    }).notNull(),
    /** Exact sanitized browser transcript accepted for this attempt. */
    historySha256: varchar("historySha256", { length: 64 }).notNull(),
    historySnapshot: mediumtext("historySnapshot"),
    provider: varchar("provider", { length: 64 }).notNull(),
    deploymentTier: varchar("deploymentTier", { length: 32 }).notNull(),
    endpointSource: varchar("endpointSource", { length: 32 }),
    requestedModel: varchar("requestedModel", { length: 160 }).notNull(),
    actualModel: varchar("actualModel", { length: 160 }),
    baseRevision: varchar("baseRevision", { length: 64 }),
    adapterRevision: varchar("adapterRevision", { length: 64 }),
    sourceCommit: varchar("sourceCommit", { length: 64 }),
    productProfile: varchar("productProfile", { length: 64 }).notNull(),
    profileVersion: varchar("profileVersion", { length: 32 }).notNull(),
    promptSource: varchar("promptSource", { length: 64 }).notNull(),
    systemPromptSha256: varchar("systemPromptSha256", { length: 64 }),
    blueprintHash: varchar("blueprintHash", { length: 64 }),
    maxTokens: int("maxTokens").notNull(),
    temperature: varchar("temperature", { length: 16 }),
    contextFreshness: mysqlEnum("contextFreshness", ["live", "delayed", "none"])
      .default("none")
      .notNull(),
    contextSha256: varchar("contextSha256", { length: 64 }),
    contextRowCount: int("contextRowCount").default(0).notNull(),
    contextSnapshot: text("contextSnapshot"),
    status: mysqlEnum("status", [
      "generating",
      "completed",
      "blocked",
      "failed",
      "aborted",
    ])
      .default("generating")
      .notNull(),
    rawOutput: text("rawOutput"),
    servedOutput: text("servedOutput"),
    validationErrors: text("validationErrors"),
    certaintyViolation: boolean("certaintyViolation").default(false).notNull(),
    finishReason: varchar("finishReason", { length: 64 }),
    promptTokens: int("promptTokens"),
    completionTokens: int("completionTokens"),
    totalTokens: int("totalTokens"),
    latencyMs: int("latencyMs"),
    errorClass: varchar("errorClass", { length: 96 }),
    errorCode: varchar("errorCode", { length: 64 }),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    /** A crashed worker may be recovered after this deadline. */
    leaseExpiresAt: timestamp("leaseExpiresAt").notNull(),
    completedAt: timestamp("completedAt"),
    /** Restricted context/raw-output deletion deadline. */
    purgeAfter: timestamp("purgeAfter").notNull(),
  },
  t => ({
    idxRequestId: uniqueIndex("idx_dime_chat_generations_request_id").on(
      t.requestId
    ),
    idxUserIdempotency: uniqueIndex(
      "idx_dime_chat_generations_user_idempotency"
    ).on(t.userId, t.idempotencyKey),
    idxTurnAttempt: uniqueIndex("idx_dime_chat_generations_turn_attempt").on(
      t.turnId,
      t.attempt
    ),
    idxStatusStarted: index("idx_dime_chat_generations_status_started").on(
      t.status,
      t.startedAt
    ),
    idxPurgeAfter: index("idx_dime_chat_generations_purge_after").on(
      t.purgeAfter
    ),
  })
);

/** Append-only lifecycle events for context, gates, retries, and failures. */
export const dimeChatTraceEvents = mysqlTable(
  "dime_chat_trace_events",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    turnId: varchar("turnId", { length: 36 }).notNull(),
    generationId: varchar("generationId", { length: 36 }),
    eventType: varchar("eventType", { length: 64 }).notNull(),
    /** Sanitized JSON only; never credentials, cookies, or raw prompt text. */
    metadata: text("metadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  t => ({
    idxTurnEvent: index("idx_dime_chat_trace_events_turn_event").on(
      t.turnId,
      t.id
    ),
    idxGenerationEvent: index("idx_dime_chat_trace_events_generation_event").on(
      t.generationId,
      t.id
    ),
  })
);

export type SelectDimeChatThread = typeof dimeChatThreads.$inferSelect;
export type SelectDimeChatMessage = typeof dimeChatMessages.$inferSelect;
export type SelectDimeChatSession = typeof dimeChatSessions.$inferSelect;
export type SelectDimeChatTurn = typeof dimeChatTurns.$inferSelect;
export type SelectDimeChatGeneration = typeof dimeChatGenerations.$inferSelect;
export type SelectDimeChatTraceEvent = typeof dimeChatTraceEvents.$inferSelect;
