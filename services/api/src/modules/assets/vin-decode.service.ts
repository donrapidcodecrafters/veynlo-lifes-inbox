import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { SafeUrlFetcher } from "../ingestion/safe-url-fetcher";
import { schema } from "@veynlo/db";

type VinDecodedAttributes = schema.VinDecodedAttributes;

const VPIC_MAX_BYTES = 2_000_000; // a single-VIN DecodeVinValues response is a small flat object — generous cap against a malformed/huge response, same reasoning as RecallMonitorService's own byte caps

/** NHTSA vPIC's `DecodeVinValues` response shape — a single flattened Results[0] object (unlike the older
 * `DecodeVin` endpoint's Variable/Value row-pair list), verified live against the real API. Every field is
 * always present as a string, blank when NHTSA has no data for it — never absent. */
interface VpicDecodeVinValuesResult {
  Make?: string;
  Model?: string;
  ModelYear?: string;
  Trim?: string;
  Series?: string;
  BodyClass?: string;
  VehicleType?: string;
  Manufacturer?: string;
  EngineCylinders?: string;
  EngineHP?: string;
  FuelTypePrimary?: string;
  DriveType?: string;
  Doors?: string;
  PlantCountry?: string;
  ErrorCode?: string; // comma-separated list, e.g. "0" (clean) or "6,8,11" (multiple issues) — verified live
  ErrorText?: string;
}

interface VpicDecodeVinValuesResponse {
  Count: number;
  Results: VpicDecodeVinValuesResult[];
}

function toIntOrNull(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function toTextOrNull(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

export interface VinDecodeSuggestion {
  vin: string;
  /** True only when NHTSA's own error-code list includes "0" (its "decoded clean" code) AND a make came
   * back — VEH-001's "VIN decode may prefill... user confirms" only makes sense to offer when the decode
   * itself is trustworthy; a garbled/incomplete VIN still returns a 200 with mostly-blank fields and a
   * non-"0" error code (verified live: a 5-digit input returns `ErrorCode: "6,8,11"`), which this surfaces
   * as `success: false` plus `errorText` rather than silently offering junk suggestions. */
  success: boolean;
  errorText: string | null;
  make: string | null;
  model: string | null;
  modelYear: number | null;
  attributes: VinDecodedAttributes;
}

/**
 * VEH-001 "VIN decode may prefill public vehicle attributes; user confirms." NHTSA's vPIC
 * (`vpic.nhtsa.dot.gov`) — free, public, no API key required, same government-data-source family as
 * RecallMonitorService's `api.nhtsa.gov` recall lookups elsewhere in this module. Uses `DecodeVinValues`
 * (a single flat result object) rather than the plainer `DecodeVin` endpoint (a long Variable/Value row
 * list) — functionally equivalent data, but far simpler to parse for the handful of fields this app cares
 * about.
 *
 * This service only ever DECODES and returns a suggestion — it never writes to the database itself. Every
 * caller (see AssetsService.applyVinDecode) is responsible for the "user correction always outranks a
 * guess" rule: a decode result may only fill in a field the user has left empty, never overwrite one
 * they've already set, mirroring this codebase's identical discipline for seeded merchant/jurisdiction
 * reference data.
 */
@Injectable()
export class VinDecodeService {
  private readonly logger = new Logger(VinDecodeService.name);

  constructor(@Inject(SafeUrlFetcher) private readonly safeUrlFetcher: SafeUrlFetcher) {}

  async decodeVin(rawVin: string): Promise<VinDecodeSuggestion> {
    const vin = rawVin.trim().toUpperCase();
    if (!vin) throw new BadRequestException({ code: "VIN_REQUIRED", message: "Enter a VIN to decode." });

    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;
    const { body } = await this.safeUrlFetcher.fetchTrustedBytes(url, { maxBytes: VPIC_MAX_BYTES });
    let parsed: VpicDecodeVinValuesResponse;
    try {
      parsed = JSON.parse(body) as VpicDecodeVinValuesResponse;
    } catch (err) {
      this.logger.warn(`NHTSA vPIC response for VIN decode wasn't valid JSON: ${String((err as Error)?.message ?? err)}`);
      return {
        vin,
        success: false,
        errorText: "NHTSA's decode service returned an unreadable response — try again shortly.",
        make: null,
        model: null,
        modelYear: null,
        attributes: emptyAttributes(vin),
      };
    }

    const result = parsed.Results?.[0];
    if (!result) {
      return { vin, success: false, errorText: "No decode result was returned for that VIN.", make: null, model: null, modelYear: null, attributes: emptyAttributes(vin) };
    }

    const errorCodes = (result.ErrorCode ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const make = toTextOrNull(result.Make);
    // "0" is vPIC's own "VIN decoded clean" code — a non-empty ErrorCode list that doesn't include it means
    // at least one real decode problem (invalid check digit, incomplete VIN, unrecognized model year, etc.),
    // verified live against the real API's actual behavior for a garbled input.
    const success = errorCodes.includes("0") && !!make;

    return {
      vin,
      success,
      errorText: success ? null : toTextOrNull(result.ErrorText),
      make,
      model: toTextOrNull(result.Model),
      modelYear: toIntOrNull(result.ModelYear),
      attributes: {
        decodedFromVin: vin,
        trim: toTextOrNull(result.Trim),
        series: toTextOrNull(result.Series),
        bodyClass: toTextOrNull(result.BodyClass),
        vehicleType: toTextOrNull(result.VehicleType),
        manufacturer: toTextOrNull(result.Manufacturer),
        engineCylinders: toIntOrNull(result.EngineCylinders),
        engineHP: toIntOrNull(result.EngineHP),
        fuelTypePrimary: toTextOrNull(result.FuelTypePrimary),
        driveType: toTextOrNull(result.DriveType),
        doors: toIntOrNull(result.Doors),
        plantCountry: toTextOrNull(result.PlantCountry),
      },
    };
  }
}

function emptyAttributes(vin: string): VinDecodedAttributes {
  return {
    decodedFromVin: vin,
    trim: null,
    series: null,
    bodyClass: null,
    vehicleType: null,
    manufacturer: null,
    engineCylinders: null,
    engineHP: null,
    fuelTypePrimary: null,
    driveType: null,
    doors: null,
    plantCountry: null,
  };
}
