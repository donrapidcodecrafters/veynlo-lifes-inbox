import { z } from "zod";

/**
 * Real bug found via live audit: sign-up stored whatever case the caller sent (`users.email` has a
 * case-SENSITIVE unique constraint), and every subsequent lookup (sign-in, forgot-password, household
 * invite acceptance, document share-grant-by-email) compared raw, unnormalized strings. Concretely:
 * signing up as "Foo@Example.com" then signing in as "foo@example.com" failed with "Incorrect email or
 * password" even with the right password, and the same address could be registered twice with different
 * casing as two unrelated accounts. Every DTO that identifies an account by email should use this instead
 * of a bare `z.string().email()`, so normalization happens once at the API boundary rather than being
 * re-implemented (or forgotten) at each call site.
 */
export const NormalizedEmailSchema = z.string().trim().toLowerCase().email();
