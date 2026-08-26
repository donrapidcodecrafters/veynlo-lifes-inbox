# Branding: Life Inbox → Veynlo

The master specification refers to the product as "Life Inbox" throughout.
The current brand is **Veynlo**. To keep the architecture flexible for a
future rename, the brand name is kept out of code logic and confined to a
small number of places:

- **User-facing copy**: page titles, the app shell logo, marketing copy,
  email templates. All of it says "Veynlo".
- **Package namespace**: all workspace packages are scoped `@veynlo/*`
  (`@veynlo/core`, `@veynlo/db`, etc.) — this is an internal convention, not
  user-visible, and would be a mechanical rename if it ever needed to change.
- **Database/API values that are genuinely internal identifiers** (e.g. the
  `provider` value `"gmail"`, table names) are left as neutral, technical
  names — they were never brand-coupled in the first place.

## What to change on a future rebrand

1. **Copy**: search for the literal string `Veynlo` across `apps/*` and
   `docs/*` — it's every user-visible occurrence, and only that.
2. **Design tokens**: `packages/design-tokens` holds the color/type/spacing
   system independently of the name — no changes needed for a rebrand
   unless the new brand also wants a new visual identity.
3. **Domain/email/legal strings**: anything under `services/api/src/config`
   referencing `WEB_APP_URL`/`API_PUBLIC_URL` is already environment-driven,
   not hardcoded.
4. **Package scope** (`@veynlo/*`): optional — only worth doing if the
   internal name itself needs to change too. A `pnpm` + `git mv` + find/replace
   pass across `package.json` `name` fields and import specifiers handles it
   in one pass.

The spec file itself (`spec/Life_Inbox_Master_Spec.txt`) is left unmodified
as the historical source document — it is never read by the running
application, only by engineers/agents doing planning work.
