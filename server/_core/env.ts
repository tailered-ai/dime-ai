export const ENV = {
  cookieSecret: (() => {
    const v = process.env.APP_SESSION_SECRET;
    if (!v) throw new Error("[BOOT] APP_SESSION_SECRET is not set");
    return v;
  })(),
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  vsinEmail: process.env.VSIN_EMAIL ?? "",
  vsinPassword: process.env.VSIN_PASSWORD ?? "",
  // ── Canonical public origin for OAuth redirect URIs ────────────────────────
  // CRITICAL: Never derive this from x-forwarded-host or req.host.
  // Behind the edge proxy, x-forwarded-host resolves to the internal
  // Cloud Run hostname (*.a.run.app), NOT the public domain. Discord (and any
  // other OAuth provider) will reject the redirect_uri if it doesn't exactly
  // match a registered URI. Set PUBLIC_ORIGIN to https://aisportsbettingmodels.com
  // in production secrets, or leave empty to fall back to request-derived origin
  // (safe for local dev where there is no proxy).
  publicOrigin: process.env.PUBLIC_ORIGIN ?? "",
  // Discord integration
  discordBotToken: process.env.DISCORD_BOT_TOKEN ?? "",
  discordClientId: process.env.DISCORD_CLIENT_ID ?? "",
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET ?? "",
  discordPublicKey: process.env.DISCORD_PUBLIC_KEY ?? "",
  discordGuildId: process.env.DISCORD_GUILD_ID ?? "",
  discordRoleAiModelSub: process.env.DISCORD_ROLE_AI_MODEL_SUB ?? "",
  // ─── Stripe ──────────────────────────────────────────────────────────────────
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  // Stripe Price IDs — must be created in Stripe Dashboard and set as env vars
  // STRIPE_PRICE_MONTHLY: $49/month recurring price ID (price_xxx)
  // STRIPE_PRICE_ANNUAL:  $399/year recurring price ID (price_xxx)
  stripePriceMonthly: process.env.STRIPE_PRICE_MONTHLY ?? "",
  stripePriceAnnual: process.env.STRIPE_PRICE_ANNUAL ?? "",
  // NOTE: TAILERED_SYNC_URL / TAILERED_SYNC_SECRET are deliberately NOT
  // mirrored here — server/cron/customerSync.ts reads them from process.env at
  // CALL time (the CRON_SECRET pattern in cronAuth.ts) so a Railway variable
  // change applies on the next run without a rebuild. See .env.example.
};
