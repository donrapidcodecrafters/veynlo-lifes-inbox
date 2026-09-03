import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

/** §39.3 "Personal knowledge graph" — hard ceiling on `traverseFrom`'s `maxHops`, independent of whatever
 * a caller passes in. A recursive CTE over `relationships` is cheap per hop but the reachable set can grow
 * combinatorially with hop count on a densely-connected graph; this bounds the query's own worst case
 * rather than trusting every call site to pass a sane number. */
const MAX_GRAPH_HOPS = 3;

/** Below this length a token is almost always a stopword/connective ("the", "for", "with", "trip") rather
 * than a real identifying signal — excluded from `resolveEntityForQuery`'s matching so a short common word
 * shared between an entity's label and the question never counts as evidence of a match on its own. */
const MIN_SIGNIFICANT_TOKEN_LENGTH = 4;

/** Splits a label into its lowercased "significant" words for `resolveEntityForQuery` — see that method's
 * own doc comment for why ALL of them must appear in the question, not just one. */
function significantTokens(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_SIGNIFICANT_TOKEN_LENGTH);
}

export interface GraphTraversalEntity {
  id: string;
  type: string;
  displayLabel: string;
  lifecycleState: string;
  /** Hops from the root entity that started this traversal (root itself is 0). */
  hop: number;
}

export interface GraphTraversalRelationship {
  id: string;
  type: string;
  fromEntityId: string;
  toEntityId: string;
}

export interface GraphTraversalFact {
  id: string;
  subjectEntityId: string;
  predicate: string;
  valueJson: unknown;
  confidenceBand: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  evidence: Array<{ id: string; locator: string; excerpt: string | null }>;
}

export interface GraphTraversalResult {
  root: GraphTraversalEntity;
  maxHops: number;
  entities: GraphTraversalEntity[];
  relationships: GraphTraversalRelationship[];
  facts: GraphTraversalFact[];
}

/**
 * MVP §52.1 "AI: ...conservative entity linking" — found while auditing this session's own work: the
 * ingestion pipeline has written real `canonicalEntities`/`relationships`/`facts` rows since before this
 * session (an "asset" entity per purchase line item, a "warranty" entity with a `covers` relationship to
 * the asset it applies to — see `IngestionService`'s extractReceipt/extractWarranty), but there was no
 * service/controller for any of it at all — a knowledge graph with data flowing in and no way to ever
 * read it back out. Deliberately owner-only (no household-delegation scope exists for this yet, unlike
 * documents/commerce/schedule's `"documents:read"`/`"commerce:read"`/`"schedule:read"` — a real product
 * decision for later, not assumed here).
 *
 * §39.3 "Personal knowledge graph" update — `entityDetail` above only ever answered "what's directly
 * attached to this one entity" (a single hop). The spec's own examples ("what else is connected to this
 * merchant," "show me everything related to this trip across purchases/documents/people") are inherently
 * multi-hop — warranty → asset → (eventually) merchant/trip, not a single edge — and `SearchService.ask()`
 * never queried `canonicalEntities`/`relationships`/`facts` at all, so a knowledge graph with real rows in
 * it could never actually ground an answer. `traverseFrom` (below) walks `relationships` recursively via a
 * bounded Postgres `WITH RECURSIVE` CTE — Drizzle's query builder has no first-class recursive-CTE support,
 * so this is raw SQL via `db.execute`, the same escape hatch `TimelineService` already uses for a query
 * shape the builder can't express — and `resolveEntityForQuery` lets `ask()` opportunistically pull that
 * traversal in as supplementary grounding context when a question names a specific known entity.
 */
@Injectable()
export class GraphService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Shared by `entityDetail` and `traverseFrom` — every fact for the given subject entities, each carrying
   * its real `evidenceRefs` rows (never a bare unsourced claim, per §28.15/ASK-001's grounding discipline).
   * Returns `[]` without a query when `entityIds` is empty (an entity with a relationship but no facts of
   * its own, or a traversal that found no entities at all, are both routine, not error cases). */
  private async factsWithEvidence(entityIds: string[]): Promise<GraphTraversalFact[]> {
    if (entityIds.length === 0) return [];
    const rawFacts = await this.db
      .select({
        id: schema.facts.id,
        subjectEntityId: schema.facts.subjectEntityId,
        predicate: schema.facts.predicate,
        valueJson: schema.facts.valueJson,
        confidenceBand: schema.facts.confidenceBand,
        effectiveFrom: schema.facts.effectiveFrom,
        effectiveTo: schema.facts.effectiveTo,
        evidenceIds: schema.facts.evidenceIds,
      })
      .from(schema.facts)
      .where(inArray(schema.facts.subjectEntityId, entityIds));

    const allEvidenceIds = [...new Set(rawFacts.flatMap((f) => f.evidenceIds))];
    const evidenceRows =
      allEvidenceIds.length > 0
        ? await this.db
            .select({ id: schema.evidenceRefs.id, locator: schema.evidenceRefs.locator, excerpt: schema.evidenceRefs.excerpt })
            .from(schema.evidenceRefs)
            .where(inArray(schema.evidenceRefs.id, allEvidenceIds))
        : [];
    const evidenceById = new Map(evidenceRows.map((e) => [e.id, e]));
    return rawFacts.map(({ evidenceIds, ...fact }) => ({
      ...fact,
      evidence: evidenceIds.map((id) => evidenceById.get(id)).filter((e): e is NonNullable<typeof e> => e != null),
    }));
  }

  async listEntities(userId: string) {
    return this.db
      .select({
        id: schema.canonicalEntities.id,
        type: schema.canonicalEntities.type,
        displayLabel: schema.canonicalEntities.displayLabel,
        lifecycleState: schema.canonicalEntities.lifecycleState,
        createdAt: schema.canonicalEntities.createdAt,
      })
      .from(schema.canonicalEntities)
      .where(and(eq(schema.canonicalEntities.ownerUserId, userId), isNull(schema.canonicalEntities.mergedIntoEntityId)))
      .orderBy(desc(schema.canonicalEntities.createdAt));
  }

  async entityDetail(entityId: string, userId: string) {
    const [entity] = await this.db.select().from(schema.canonicalEntities).where(eq(schema.canonicalEntities.id, entityId)).limit(1);
    if (!entity) throw new NotFoundException({ code: "ENTITY_NOT_FOUND", message: "Not found." });
    if (entity.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your entity." });

    // §39.3 knowledge-graph write path, third slice — facts now actually carry `evidenceIds` (see
    // IngestionService's extractReceipt/extractWarranty), so the "why does Veynlo think this" citation
    // this page exists to answer can finally be resolved, not just displayed as an empty array.
    const facts = await this.factsWithEvidence([entityId]);

    // Both directions — a "covers" relationship (warranty → asset) should show up whichever side of it
    // this entity is on, each joined to the OTHER entity's own displayLabel so the UI never needs a
    // second round trip just to render "covers <asset name>" / "<warranty name> covers this".
    const outgoing = await this.db
      .select({ id: schema.relationships.id, type: schema.relationships.type, otherEntityId: schema.relationships.toEntityId, otherEntityLabel: schema.canonicalEntities.displayLabel })
      .from(schema.relationships)
      .innerJoin(schema.canonicalEntities, eq(schema.canonicalEntities.id, schema.relationships.toEntityId))
      .where(eq(schema.relationships.fromEntityId, entityId));
    const incoming = await this.db
      .select({ id: schema.relationships.id, type: schema.relationships.type, otherEntityId: schema.relationships.fromEntityId, otherEntityLabel: schema.canonicalEntities.displayLabel })
      .from(schema.relationships)
      .innerJoin(schema.canonicalEntities, eq(schema.canonicalEntities.id, schema.relationships.fromEntityId))
      .where(eq(schema.relationships.toEntityId, entityId));

    return {
      entity: { id: entity.id, type: entity.type, displayLabel: entity.displayLabel, lifecycleState: entity.lifecycleState, aliases: entity.aliases, createdAt: entity.createdAt },
      facts,
      relationships: {
        outgoing: outgoing.map((r) => ({ id: r.id, type: r.type, direction: "outgoing" as const, otherEntityId: r.otherEntityId, otherEntityLabel: r.otherEntityLabel })),
        incoming: incoming.map((r) => ({ id: r.id, type: r.type, direction: "incoming" as const, otherEntityId: r.otherEntityId, otherEntityLabel: r.otherEntityLabel })),
      },
    };
  }

  /**
   * §39.3 "Personal knowledge graph" — real multi-hop traversal, e.g. "what else is connected to this
   * merchant/person" or "show me everything related to this trip across purchases/documents/people": walks
   * `relationships` outward from `entityId` up to `maxHops` edges (clamped to `MAX_GRAPH_HOPS` regardless of
   * what's passed in — a recursive CTE is cheap per hop but the reachable set can grow combinatorially on a
   * densely-connected graph, so the bound lives in the service, not in caller discipline), in EITHER
   * direction per hop (an asset doesn't just get traversed via its own outgoing edges — a warranty's
   * `covers` edge points AT the asset, not from it).
   *
   * Ownership is enforced the same way `entityDetail` enforces it (404 for a nonexistent root, 403 for one
   * this user doesn't own) AND at every single hop of the walk itself — the recursive CTE's own join
   * requires `owner_user_id = userId` on every candidate next-entity before it's allowed onto the path, so
   * a `relationships` row that (through a bug, or data predating some future household-sharing feature)
   * happens to link two different owners' entities can never leak the other owner's node into this result,
   * even though nothing in the schema's foreign keys forbids such a row from existing — the same
   * "authorization re-checked at fetch time, never trust the graph edges alone" posture `search_documents`
   * already documents for its own index.
   *
   * Drizzle's query builder has no first-class way to express `WITH RECURSIVE`, so the walk itself is raw
   * SQL via `db.execute` (the same escape hatch `TimelineService` uses for its own union-of-tables query) —
   * but only for the ID/hop-distance walk. Once the reachable entity IDs are known, every column that's
   * actually rendered (`displayLabel`, fact `valueJson`, etc.) is still read back through Drizzle's normal
   * typed query builder so `encryptedText`/`encryptedJsonb`'s `fromDriver` transparently decrypts it — the
   * raw SQL never touches an encrypted column directly.
   */
  async traverseFrom(entityId: string, userId: string, maxHops: number): Promise<GraphTraversalResult> {
    const [root] = await this.db.select().from(schema.canonicalEntities).where(eq(schema.canonicalEntities.id, entityId)).limit(1);
    if (!root) throw new NotFoundException({ code: "ENTITY_NOT_FOUND", message: "Not found." });
    if (root.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your entity." });

    // Never trust a caller-supplied hop count — a large or negative value must never reach the query.
    const hops = Math.min(Math.max(1, Math.trunc(maxHops) || 1), MAX_GRAPH_HOPS);

    const walk = await this.db.execute<{ entity_id: string; hop: number }>(sql`
      WITH RECURSIVE graph_walk AS (
        SELECT
          ce.id AS entity_id,
          0 AS hop,
          ARRAY[ce.id]::text[] AS visited
        FROM canonical_entities ce
        WHERE ce.id = ${entityId}
          AND ce.owner_user_id = ${userId}
          AND ce.merged_into_entity_id IS NULL

        UNION ALL

        SELECT
          step.next_id,
          gw.hop + 1,
          gw.visited || step.next_id
        FROM graph_walk gw
        JOIN LATERAL (
          SELECT CASE WHEN r.from_entity_id = gw.entity_id THEN r.to_entity_id ELSE r.from_entity_id END AS next_id
          FROM relationships r
          WHERE r.from_entity_id = gw.entity_id OR r.to_entity_id = gw.entity_id
        ) step ON true
        JOIN canonical_entities next_ce
          ON next_ce.id = step.next_id
         AND next_ce.owner_user_id = ${userId}
         AND next_ce.merged_into_entity_id IS NULL
        WHERE gw.hop < ${hops}
          AND NOT (step.next_id = ANY(gw.visited))
      )
      SELECT DISTINCT ON (entity_id) entity_id, hop
      FROM graph_walk
      WHERE hop > 0
      ORDER BY entity_id, hop ASC
    `);

    const hopByEntityId = new Map<string, number>([[root.id, 0]]);
    for (const row of walk.rows) hopByEntityId.set(row.entity_id, Number(row.hop));
    const entityIds = [...hopByEntityId.keys()];

    // Full, decrypted rows for every reached entity (including the root) — the raw CTE above only ever
    // dealt in plaintext id/owner/lifecycle columns, never `displayLabel`.
    const entityRows = await this.db
      .select({ id: schema.canonicalEntities.id, type: schema.canonicalEntities.type, displayLabel: schema.canonicalEntities.displayLabel, lifecycleState: schema.canonicalEntities.lifecycleState })
      .from(schema.canonicalEntities)
      .where(inArray(schema.canonicalEntities.id, entityIds));
    const entities: GraphTraversalEntity[] = entityRows.map((e) => ({ ...e, hop: hopByEntityId.get(e.id) ?? 0 }));
    const entityById = new Map(entities.map((e) => [e.id, e]));

    // Every edge with BOTH endpoints inside the reached set — not just the tree of edges the walk actually
    // traversed, so two reached entities connected by more than one relationship (or connected by an edge
    // that happens to close a cycle) still show their full real connectivity, matching `entityDetail`'s own
    // "both directions" completeness for a single entity.
    const relationshipRows =
      entityIds.length > 0
        ? await this.db
            .select({ id: schema.relationships.id, type: schema.relationships.type, fromEntityId: schema.relationships.fromEntityId, toEntityId: schema.relationships.toEntityId })
            .from(schema.relationships)
            .where(and(inArray(schema.relationships.fromEntityId, entityIds), inArray(schema.relationships.toEntityId, entityIds)))
        : [];

    const facts = await this.factsWithEvidence(entityIds);

    const rootEntity = entityById.get(root.id) ?? { id: root.id, type: root.type, displayLabel: root.displayLabel, lifecycleState: root.lifecycleState, hop: 0 };
    return { root: rootEntity, maxHops: hops, entities, relationships: relationshipRows, facts };
  }

  /**
   * §39.3 knowledge-graph reasoning — lets `SearchService.ask()` opportunistically resolve a question to a
   * specific `canonicalEntities` row (e.g. the question names a merchant/product/trip that's a real graph
   * entity) so it can layer in `traverseFrom`'s connected context as supplementary grounding. Precision-first
   * by design, matching §40.1/§40.2's entity-resolution stance elsewhere in this spec ("never merge by name
   * alone," "false non-merge is preferable to incorrectly combining") applied to matching instead of
   * merging: EVERY significant (4+ character) word of a candidate entity's label must appear in the
   * question before it counts as a match, not just one shared word — a label with zero significant words
   * (nothing but short/common tokens) can never match at all. Most Ask questions won't name a specific known
   * entity and will legitimately resolve to nothing here, which is expected, not a bug: `ask()` must keep
   * answering everything else exactly as it did before this existed.
   *
   * Necessarily an in-app scan (bounded to this owner's own entities, capped like `ask()`'s own bounded
   * per-domain fetches) rather than a SQL `ILIKE`/full-text predicate — `displayLabel` is `encryptedText`
   * (application-level ciphertext at the source), so it can only ever be compared in plaintext after
   * Drizzle's own decryption, the identical constraint `search_documents` exists specifically to route
   * around for every OTHER domain (see search.service.ts's own doc comment) — `canonical_entities` has no
   * such unencrypted mirror (yet), so this accepts the same bounded-fetch-then-compare tradeoff the rest of
   * this codebase already accepted before that table existed.
   */
  async resolveEntityForQuery(userId: string, query: string): Promise<{ id: string; type: string; displayLabel: string } | null> {
    const q = query.toLowerCase();
    const rows = await this.db
      .select({ id: schema.canonicalEntities.id, type: schema.canonicalEntities.type, displayLabel: schema.canonicalEntities.displayLabel })
      .from(schema.canonicalEntities)
      .where(and(eq(schema.canonicalEntities.ownerUserId, userId), isNull(schema.canonicalEntities.mergedIntoEntityId)))
      .limit(500);

    let best: { row: (typeof rows)[number]; specificity: number } | null = null;
    for (const row of rows) {
      const label = row.displayLabel.toLowerCase().trim();
      if (!label) continue;
      const tokens = significantTokens(label);
      if (tokens.length === 0) continue; // nothing but stopwords/short tokens — never a safe match signal
      if (!tokens.every((token) => q.includes(token))) continue;
      // Among multiple matches, prefer the most specific (longest) label — e.g. a query naming "Dyson V15
      // vacuum warranty" should resolve to that exact entity over a coarser "Dyson V15 vacuum" one.
      const specificity = label.length;
      if (!best || specificity > best.specificity) best = { row, specificity };
    }
    return best ? { id: best.row.id, type: best.row.type, displayLabel: best.row.displayLabel } : null;
  }
}
