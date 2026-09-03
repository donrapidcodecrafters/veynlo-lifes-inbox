import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { SafeUrlFetcher } from "../ingestion/safe-url-fetcher";

const NHTSA_TIMEOUT_BYTES = 2_000_000; // recall lists for a single make/model/year are small; generous cap against a malformed/huge response
const CPSC_TIMEOUT_BYTES = 2_000_000;

interface NhtsaRecallResult {
  NHTSACampaignNumber: string;
  Component: string;
  Summary: string;
  Remedy: string;
  ReportReceivedDate: string; // "DD/MM/YYYY" — NHTSA's own format, verified live against the real API
  Make: string;
  Model: string;
  ModelYear: string;
}

interface NhtsaRecallResponse {
  Count: number;
  results: NhtsaRecallResult[];
}

interface CpscRecallProduct {
  Model?: string;
  Name?: string;
}

interface CpscRecallResult {
  RecallID: number;
  RecallNumber: string;
  RecallDate: string; // ISO-ish "YYYY-MM-DDT00:00:00"
  Description: string;
  URL: string;
  Title: string;
  Products?: CpscRecallProduct[];
}

/** NHTSA's own "DD/MM/YYYY" report-date format — not ISO, and not the "MM/DD/YYYY" a US-built parser would
 * naively assume. Verified live against the real API (`recallsByVehicle?make=Honda&model=Civic&modelYear=2015`
 * returned `"ReportReceivedDate":"15/09/2015"` for a report NHTSA's own site dates September 15, 2015). */
function parseNhtsaDate(raw: string | null | undefined): TemporalValue | null {
  if (!raw) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  const iso = `${yyyy}-${mm}-${dd}`;
  return { precision: "date", instantUtc: null, date: iso, timezone: null, sourceText: raw };
}

function parseCpscDate(raw: string | null | undefined): TemporalValue | null {
  if (!raw) return null;
  const iso = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return { precision: "date", instantUtc: null, date: iso, timezone: null, sourceText: raw };
}

// A tiny stopword list — just enough to keep generic filler words ("kitchen", "basement", "the") out of
// the CPSC keyword-matching fallback in fetchCpscCandidates, not a general NLP stopword list. Words under
// 4 characters are dropped outright rather than listed here (short words are almost never a useful,
// specific category signal — "the", "for", "and" would all need listing individually otherwise).
const LABEL_STOPWORDS = new Set(["kitchen", "basement", "garage", "bedroom", "bathroom", "living", "room", "upstairs", "downstairs", "main", "master", "guest", "unit", "units"]);

function significantWords(label: string): string[] {
  return [...new Set(label.toLowerCase().match(/[a-z]+/g) ?? [])].filter((w) => w.length >= 4 && !LABEL_STOPWORDS.has(w));
}

interface RecallCandidate {
  source: "nhtsa" | "cpsc";
  campaignNumber: string;
  component: string | null;
  summary: string;
  remedy: string | null;
  url: string | null;
  matchedMake: string | null;
  matchedModel: string | null;
  matchedYear: number | null;
  reportedDate: TemporalValue | null;
}

/**
 * VEH-006 "Match VIN/model/year to authoritative recall data where jurisdiction data service is available"
 * / HOMEOS-008 "Recall matching uses model/serial scope when available; never alert solely on loose brand
 * similarity." Both free, public, no-API-key US government sources:
 *  - NHTSA (`api.nhtsa.gov/recalls/recallsByVehicle`) for vehicles, matched on make+model+modelYear exactly
 *    as NHTSA itself returns them.
 *  - CPSC (`saferproducts.gov/RestWebServices/Recall`) for home assets/appliances, matched on
 *    manufacturer (and, when the asset has a model recorded, filtered further by it) — CPSC's schema has no
 *    VIN-equivalent identifier at all, so "model/serial scope when available" here means "narrow by model
 *    string when the asset has one, not just brand."
 *
 * Neither source confirms a specific unit is actually affected — NHTSA's by-vehicle endpoint matches an
 * entire model-year range, not a VIN, and CPSC has no per-serial lookup at all — so every match this
 * service writes starts (and stays, unless a user explicitly acts on it — see AssetsService.confirmRecall/
 * markRecallHandled) at `status: "potential_match_verify_vin"`, never `"open"`. `"open"` is reserved for a
 * user's own confirmation that a match genuinely applies to their specific vehicle/asset — this service
 * itself never asserts that on its own, honoring the spec's "never alert solely on loose brand similarity"
 * bar one level stricter than even an exact make/model/year match.
 */
@Injectable()
export class RecallMonitorService {
  private readonly logger = new Logger(RecallMonitorService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SafeUrlFetcher) private readonly safeUrlFetcher: SafeUrlFetcher,
  ) {}

  private async fetchNhtsaCandidates(make: string, model: string, modelYear: number): Promise<RecallCandidate[]> {
    const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${modelYear}`;
    const { body } = await this.safeUrlFetcher.fetchTrustedBytes(url, { maxBytes: NHTSA_TIMEOUT_BYTES });
    let parsed: NhtsaRecallResponse;
    try {
      parsed = JSON.parse(body) as NhtsaRecallResponse;
    } catch (err) {
      this.logger.warn(`NHTSA response for ${make}/${model}/${modelYear} wasn't valid JSON: ${String((err as Error)?.message ?? err)}`);
      return [];
    }
    return (parsed.results ?? []).map((r) => ({
      source: "nhtsa" as const,
      campaignNumber: r.NHTSACampaignNumber,
      component: r.Component ?? null,
      summary: r.Summary ?? "",
      remedy: r.Remedy ?? null,
      url: null, // NHTSA's by-vehicle response carries no direct recall URL — Notes mentions safercar.gov generically, nothing per-campaign to link to
      matchedMake: r.Make ?? make,
      matchedModel: r.Model ?? model,
      matchedYear: Number(r.ModelYear) || modelYear,
      reportedDate: parseNhtsaDate(r.ReportReceivedDate),
    }));
  }

  private async fetchCpscCandidates(manufacturer: string, model: string | null, assetLabel: string): Promise<RecallCandidate[]> {
    const params = new URLSearchParams({ Manufacturer: manufacturer, format: "json" });
    const url = `https://www.saferproducts.gov/RestWebServices/Recall?${params.toString()}`;
    const { body } = await this.safeUrlFetcher.fetchTrustedBytes(url, { maxBytes: CPSC_TIMEOUT_BYTES });
    let parsed: CpscRecallResult[];
    try {
      parsed = JSON.parse(body) as CpscRecallResult[];
    } catch (err) {
      this.logger.warn(`CPSC response for manufacturer "${manufacturer}" wasn't valid JSON: ${String((err as Error)?.message ?? err)}`);
      return [];
    }
    const normalizedModel = model?.trim().toLowerCase();
    // HOMEOS-008 "never alert solely on loose brand similarity" — found live against the real CPSC API:
    // querying by manufacturer alone (e.g. "Whirlpool") returns that brand's ENTIRE multi-decade recall
    // history across every product line it has ever sold (vacuums, dishwashers, freezers, microwaves,
    // cooktops...), not just the kind of thing this asset actually is. A model on file already narrows
    // this correctly (below); with no model, this falls back to keyword-matching the asset's own label
    // against each recall's product text ("Laundry Dryer" only keeps recalls that actually mention
    // "dryer") — a coarser signal than a model number, but still a real category match, not brand alone.
    const labelKeywords = significantWords(assetLabel);
    return parsed
      .filter((r) => {
        if (normalizedModel) {
          const products = r.Products ?? [];
          if (products.length === 0) return true; // CPSC didn't structure a model list for this recall — fall back to the manufacturer-level match rather than dropping it entirely
          return products.some((p) => (p.Model ?? "").toLowerCase().includes(normalizedModel) || (p.Name ?? "").toLowerCase().includes(normalizedModel));
        }
        if (labelKeywords.length === 0) return false; // nothing to narrow by — fail closed rather than returning every recall this manufacturer has ever issued
        const haystack = [r.Title, r.Description, ...(r.Products ?? []).flatMap((p) => [p.Name, p.Model])].filter(Boolean).join(" ").toLowerCase();
        return labelKeywords.some((word) => haystack.includes(word));
      })
      .map((r) => ({
        source: "cpsc" as const,
        campaignNumber: r.RecallNumber,
        component: r.Products?.[0]?.Name ?? null,
        summary: r.Description || r.Title || "",
        remedy: null, // CPSC's Recall resource carries remedy info embedded in Description/Title, not a separate field
        url: r.URL ?? null,
        matchedMake: manufacturer,
        matchedModel: r.Products?.[0]?.Model ?? model,
        matchedYear: null,
        reportedDate: parseCpscDate(r.RecallDate),
      }));
  }

  /** Inserts a new recall_matches row, or refreshes an existing one's summary/checkedAt — but only while its
   * status is still the automated default. A row the user already promoted to "open" or resolved to
   * "closed_or_repaired" is left untouched: a re-scan finding the same campaign again should never silently
   * revert a user's own confirmation/resolution back to "potential match, go verify this again." */
  private async upsertMatch(ownerUserId: string, subject: { vehicleProfileId: string | null; homeAssetId: string | null }, candidate: RecallCandidate): Promise<boolean> {
    const subjectCondition = subject.vehicleProfileId
      ? eq(schema.recallMatches.vehicleProfileId, subject.vehicleProfileId)
      : eq(schema.recallMatches.homeAssetId, subject.homeAssetId!);
    const [existing] = await this.db
      .select({ id: schema.recallMatches.id, status: schema.recallMatches.status })
      .from(schema.recallMatches)
      .where(and(eq(schema.recallMatches.source, candidate.source), eq(schema.recallMatches.campaignNumber, candidate.campaignNumber), subjectCondition))
      .limit(1);

    if (existing) {
      if (existing.status !== "potential_match_verify_vin") return false; // user already acted on this one — don't touch it
      await this.db
        .update(schema.recallMatches)
        .set({
          component: candidate.component,
          summary: candidate.summary,
          remedy: candidate.remedy,
          url: candidate.url,
          matchedMake: candidate.matchedMake,
          matchedModel: candidate.matchedModel,
          matchedYear: candidate.matchedYear,
          reportedDate: candidate.reportedDate,
          checkedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.recallMatches.id, existing.id));
      return false;
    }

    await this.db.insert(schema.recallMatches).values({
      id: generateId("recallMatch"),
      ownerUserId,
      vehicleProfileId: subject.vehicleProfileId,
      homeAssetId: subject.homeAssetId,
      source: candidate.source,
      campaignNumber: candidate.campaignNumber,
      component: candidate.component,
      summary: candidate.summary,
      remedy: candidate.remedy,
      url: candidate.url,
      matchedMake: candidate.matchedMake,
      matchedModel: candidate.matchedModel,
      matchedYear: candidate.matchedYear,
      status: "potential_match_verify_vin",
      reportedDate: candidate.reportedDate,
    });
    return true;
  }

  /**
   * Removes stale matches a fresh scan no longer finds — a matching-rule change (e.g. the CPSC
   * keyword-narrowing fix this method itself was added for, found live: a home asset's first scan wrote
   * rows for every recall a manufacturer had EVER issued, across unrelated product categories) or an
   * upstream source correction can leave rows in `recall_matches` that no query would produce today.
   * Deliberately narrow: only ever deletes a row still at the automated default status
   * ("potential_match_verify_vin") — a match the user already promoted to "open" or resolved to
   * "closed_or_repaired" is never silently removed just because a re-scan didn't happen to return it again
   * (NHTSA/CPSC's own result ordering/pagination isn't guaranteed stable), matching upsertMatch's identical
   * "never touch what the user already acted on" stance.
   */
  private async pruneStaleMatches(subject: { vehicleProfileId: string | null; homeAssetId: string | null }, source: "nhtsa" | "cpsc", freshCampaignNumbers: string[]): Promise<void> {
    const subjectCondition = subject.vehicleProfileId
      ? eq(schema.recallMatches.vehicleProfileId, subject.vehicleProfileId)
      : eq(schema.recallMatches.homeAssetId, subject.homeAssetId!);
    const staleCondition =
      freshCampaignNumbers.length > 0
        ? notInArray(schema.recallMatches.campaignNumber, freshCampaignNumbers)
        : undefined; // no fresh matches at all — every existing default-status row for this subject is stale
    await this.db
      .delete(schema.recallMatches)
      .where(and(subjectCondition, eq(schema.recallMatches.source, source), eq(schema.recallMatches.status, "potential_match_verify_vin"), staleCondition));
  }

  /** Checks one vehicle against NHTSA and upserts recall_matches for it. No-ops (returns 0) if the vehicle
   * is missing make/model/year — VEH-006's "match VIN/model/year... never alert solely on loose brand
   * similarity" means a vehicle with only a make on file simply isn't checkable yet, not a candidate for a
   * make-only guess. */
  async checkVehicle(vehicleProfileId: string): Promise<{ checked: boolean; newMatches: number }> {
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleProfileId)).limit(1);
    if (!vehicle || vehicle.deletedAt || !vehicle.make || !vehicle.model || !vehicle.year) {
      return { checked: false, newMatches: 0 };
    }
    let candidates: RecallCandidate[];
    try {
      candidates = await this.fetchNhtsaCandidates(vehicle.make, vehicle.model, vehicle.year);
    } catch (err) {
      this.logger.warn(`NHTSA recall check failed for vehicle ${vehicleProfileId}: ${String((err as Error)?.message ?? err)}`);
      return { checked: false, newMatches: 0 };
    }
    let newMatches = 0;
    for (const candidate of candidates) {
      const inserted = await this.upsertMatch(vehicle.ownerUserId, { vehicleProfileId, homeAssetId: null }, candidate);
      if (inserted) newMatches++;
    }
    await this.pruneStaleMatches({ vehicleProfileId, homeAssetId: null }, "nhtsa", candidates.map((c) => c.campaignNumber));
    return { checked: true, newMatches };
  }

  /** Checks one home asset against CPSC and upserts recall_matches for it. No-ops if the asset has no
   * make/manufacturer on file — same "never alert solely on loose brand similarity" reasoning as
   * checkVehicle; unlike a vehicle, a home asset's model is optional even when checkable (CPSC's own API
   * takes manufacturer as the primary key). When a model IS on file it narrows results directly; otherwise
   * fetchCpscCandidates falls back to matching the asset's own label against each candidate recall's
   * product text — see that method's own doc comment for why a manufacturer-only CPSC query needs that
   * fallback at all. */
  async checkHomeAsset(homeAssetId: string): Promise<{ checked: boolean; newMatches: number }> {
    const [asset] = await this.db.select().from(schema.homeAssets).where(eq(schema.homeAssets.id, homeAssetId)).limit(1);
    if (!asset || asset.deletedAt || !asset.make) {
      return { checked: false, newMatches: 0 };
    }
    let candidates: RecallCandidate[];
    try {
      candidates = await this.fetchCpscCandidates(asset.make, asset.model ?? null, asset.label);
    } catch (err) {
      this.logger.warn(`CPSC recall check failed for home asset ${homeAssetId}: ${String((err as Error)?.message ?? err)}`);
      return { checked: false, newMatches: 0 };
    }
    let newMatches = 0;
    for (const candidate of candidates) {
      const inserted = await this.upsertMatch(asset.ownerUserId, { vehicleProfileId: null, homeAssetId }, candidate);
      if (inserted) newMatches++;
    }
    await this.pruneStaleMatches({ vehicleProfileId: null, homeAssetId }, "cpsc", candidates.map((c) => c.campaignNumber));
    return { checked: true, newMatches };
  }

  /**
   * The recurring tick's actual work (see QueueProducerService.scheduleRecurringRecallScan /
   * worker-main.ts's recallScanWorker) — every non-deleted vehicle/home-asset with enough identity to check
   * gets re-checked. Best-effort per-subject: one vehicle's NHTSA call failing (rate limit, transient
   * network error) doesn't abort the rest of the scan, matching checkVehicle/checkHomeAsset's own
   * catch-and-log behavior.
   */
  async scanAll(): Promise<{ vehiclesChecked: number; homeAssetsChecked: number }> {
    const vehicles = await this.db
      .select({ id: schema.vehicleProfiles.id })
      .from(schema.vehicleProfiles)
      .where(isNull(schema.vehicleProfiles.deletedAt));
    let vehiclesChecked = 0;
    for (const v of vehicles) {
      const result = await this.checkVehicle(v.id);
      if (result.checked) vehiclesChecked++;
    }

    const homeAssetRows = await this.db.select({ id: schema.homeAssets.id }).from(schema.homeAssets).where(isNull(schema.homeAssets.deletedAt));
    let homeAssetsChecked = 0;
    for (const a of homeAssetRows) {
      const result = await this.checkHomeAsset(a.id);
      if (result.checked) homeAssetsChecked++;
    }

    return { vehiclesChecked, homeAssetsChecked };
  }
}
