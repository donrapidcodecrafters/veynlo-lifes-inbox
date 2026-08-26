/**
 * Bootstraps an admin_users row. There is no self-serve admin sign-up by
 * design — operator accounts are provisioned out-of-band (this script, or
 * a future proper admin-management UI gated behind `superadmin`).
 *
 * Usage: pnpm --filter @veynlo/api run create-admin -- --email you@veynlo.app --name "Your Name" --role superadmin
 */
import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import { generateId } from "@veynlo/core";
import { createDbClient, schema } from "@veynlo/db";
import { eq } from "drizzle-orm";
import { loadEnv } from "../config/env";

function parseArgs(): { email: string; name: string; role: "support" | "superadmin" } {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const email = get("--email");
  if (!email) {
    console.error("Usage: create-admin --email you@veynlo.app [--name \"Your Name\"] [--role support|superadmin]");
    process.exit(1);
  }
  const role = get("--role") === "superadmin" ? "superadmin" : "support";
  return { email, name: get("--name") ?? email.split("@")[0] ?? "Admin", role };
}

async function main() {
  const { email, name, role } = parseArgs();
  const db = createDbClient(loadEnv().DATABASE_URL);

  const [existing] = await db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, email)).limit(1);
  if (existing) {
    console.error(`An admin account already exists for ${email}.`);
    process.exit(1);
  }

  const temporaryPassword = randomBytes(12).toString("base64url");
  const passwordHash = await argon2.hash(temporaryPassword);

  await db.insert(schema.adminUsers).values({
    id: generateId("adminUser"),
    email,
    displayName: name,
    passwordHash,
    role,
  });

  console.log(`Created ${role} admin account for ${email}.`);
  console.log(`Temporary password (shown once — store it in a password manager): ${temporaryPassword}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to create admin account:", err);
  process.exit(1);
});
