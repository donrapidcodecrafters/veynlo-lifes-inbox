export * from "./util/ids";
export * from "./util/money";
export * from "./util/time";
export * from "./util/locale";
// util/token is deliberately NOT re-exported here (unlike every sibling util/* module) — it does a bare
// `import ... from "node:crypto"`, a real server-only Node built-in with no browser equivalent, and this
// barrel is imported by client-side app code (e.g. apps/web's Next.js client components) alongside every
// other util here. Found live: webpack's client bundler refuses to build ANY module that transitively
// imports this file at all — `UnhandledSchemeError: Reading from "node:crypto" is not handled by
// plugins` — even from a page that never actually calls generateOpaqueToken/hashOpaqueToken, since a
// `node:`-scheme import breaks the build at bundle-construction time, before any tree-shaking could ever
// discard the unused export. Every real caller (IdentityService, HouseholdService's invite-accept flow,
// AdminService) is server-only API code, so they import straight from "@veynlo/core/util/token" instead
// (see packages/core/package.json's "./util/token" export) — never through this main barrel.
export * from "./util/recurrence";
export * from "./util/geo";
export * from "./util/place-extraction";

export * from "./permissions/sensitivity";

export * from "./entities/provenance";
export * from "./entities/household";
export * from "./entities/graph";
export * from "./entities/commerce";
export * from "./entities/schedule";
export * from "./entities/documents";
export * from "./entities/attention";
export * from "./entities/attention-reasons";
export * from "./entities/automation";
export * from "./entities/pipeline";

export * from "./connectors/types";
export * from "./entitlements/plans";
export * from "./entitlements/category-preferences";
export * from "./events/taxonomy";
export * from "./events/payloads";
