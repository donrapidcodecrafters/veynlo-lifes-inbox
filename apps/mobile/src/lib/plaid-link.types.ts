/** Shared between plaid-link.native.ts and plaid-link.web.ts — see the latter for why this is a separate file. */
export type PlaidLinkResult =
  | { status: "success"; publicToken: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };
