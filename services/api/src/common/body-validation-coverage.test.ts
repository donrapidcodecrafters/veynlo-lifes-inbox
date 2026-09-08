import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { ZodValidationPipe } from "./zod-validation.pipe";
import { SnoozeInboxItemDtoSchema, DismissAttentionItemDtoSchema } from "../modules/attention/dto";
import { SetAppointmentVisibilityDtoSchema } from "../modules/health-logistics/dto";
import { SetAccountIncludedDtoSchema } from "../modules/finance/dto";
import { SetWriteBackDtoSchema, SetAiProcessingDtoSchema } from "../modules/connectors/dto";
import { SetEmergencyBinderItemDtoSchema } from "../modules/documents/dto";
import { AddHistoryNoteDtoSchema } from "../modules/history/dto";

const BODY_META = { type: "body" as const, metatype: undefined, data: undefined };

/**
 * Validation here is per-method — `@UsePipes(new ZodValidationPipe(Schema))` above a handler taking
 * `@Body()`. There is no global pipe, so a handler without the decorator accepts whatever it is sent; the
 * DTO type on the parameter is compile-time only.
 *
 * 20 of 216 body-taking handlers had no pipe, and the reason was structural rather than careless: pulling
 * one field with `@Body("field")` hands the pipe the EXTRACTED value, which an object schema cannot match,
 * so those handlers could not use the mechanism the other 196 do.
 *
 * Two halves here. The first asserts the schemas actually reject what used to get through. The second is
 * a standing guard that the gap does not reopen, since the shape that caused it is easy to write again.
 */
describe("request bodies that used to bypass validation", () => {
  const pipe = (schema: Parameters<typeof ZodValidationPipe.prototype.transform> extends never ? never : ConstructorParameters<typeof ZodValidationPipe>[0]) =>
    new ZodValidationPipe(schema);

  it("rejects an unparseable snooze date instead of throwing inside the UPDATE", () => {
    // Proven against the real database before this fix: `new Date("not-a-date")` is an Invalid Date, and
    // the UPDATE threw RangeError: Invalid time value. GlobalExceptionFilter turned that into
    // 500 INTERNAL_ERROR with retryable:true — wrong twice, since the input is the problem and the mobile
    // offline queue replays 5xx up to its retry cap.
    expect(() => pipe(SnoozeInboxItemDtoSchema).transform({ until: "not-a-date" }, BODY_META)).toThrow(BadRequestException);
    expect(() => pipe(SnoozeInboxItemDtoSchema).transform({ until: "" }, BODY_META)).toThrow(BadRequestException);
    expect(() => pipe(SnoozeInboxItemDtoSchema).transform({}, BODY_META)).toThrow(BadRequestException);
    // And still accepts what the client actually sends.
    expect(pipe(SnoozeInboxItemDtoSchema).transform({ until: "2026-12-01T09:00:00.000Z" }, BODY_META)).toEqual({
      until: "2026-12-01T09:00:00.000Z",
    });
  });

  it("rejects a visibility outside the two this endpoint means", () => {
    // The enum has four values and the read path grants delegate access with a NEGATIVE check —
    // ne(visibility, "private") in health-logistics.service.ts. So an out-of-contract value was not inert:
    // it read as shared while failing every `visibility === "household"` comparison elsewhere.
    for (const bad of ["shared_link", "selected_people", "public", ""]) {
      expect(() => pipe(SetAppointmentVisibilityDtoSchema).transform({ visibility: bad }, BODY_META), bad).toThrow(BadRequestException);
    }
    expect(pipe(SetAppointmentVisibilityDtoSchema).transform({ visibility: "household" }, BODY_META)).toEqual({ visibility: "household" });
    expect(pipe(SetAppointmentVisibilityDtoSchema).transform({ visibility: "private" }, BODY_META)).toEqual({ visibility: "private" });
  });

  it('rejects the string "false" rather than reinterpreting it as true', () => {
    // These call sites used Boolean(...) as their only defence, and Boolean("false") is true — so
    // {"isIncluded":"false"} switched the account ON, and {"enabled":"false"} turned write-back ON.
    for (const schema of [SetAccountIncludedDtoSchema, SetWriteBackDtoSchema, SetEmergencyBinderItemDtoSchema]) {
      const key = Object.keys(schema.shape)[0]!;
      expect(() => pipe(schema).transform({ [key]: "false" }, BODY_META)).toThrow(BadRequestException);
      expect(() => pipe(schema).transform({ [key]: 0 }, BODY_META)).toThrow(BadRequestException);
      expect(pipe(schema).transform({ [key]: false }, BODY_META)).toEqual({ [key]: false });
    }
  });

  it("keeps null meaningful where null means something", () => {
    // setAiProcessing's null is not "missing" — it clears the per-connection override back to the
    // account-wide setting, so the schema must accept it while still rejecting a non-boolean.
    expect(pipe(SetAiProcessingDtoSchema).transform({ enabled: null }, BODY_META)).toEqual({ enabled: null });
    expect(() => pipe(SetAiProcessingDtoSchema).transform({ enabled: "null" }, BODY_META)).toThrow(BadRequestException);
  });

  it("still accepts an omitted optional field", () => {
    expect(pipe(DismissAttentionItemDtoSchema).transform({}, BODY_META)).toEqual({});
    expect(() => pipe(DismissAttentionItemDtoSchema).transform({ reason: 42 }, BODY_META)).toThrow(BadRequestException);
  });

  it("bounds free text rather than accepting anything", () => {
    expect(() => pipe(AddHistoryNoteDtoSchema).transform({ noteText: "" }, BODY_META)).toThrow(BadRequestException);
    expect(() => pipe(AddHistoryNoteDtoSchema).transform({ noteText: "x".repeat(5001) }, BODY_META)).toThrow(BadRequestException);
    expect(pipe(AddHistoryNoteDtoSchema).transform({ noteText: "Called the vet" }, BODY_META)).toEqual({ noteText: "Called the vet" });
  });

  it("reports a field error rather than a bare message, so a client can point at the input", () => {
    try {
      pipe(SetAppointmentVisibilityDtoSchema).transform({ visibility: "shared_link" }, BODY_META);
      throw new Error("should have thrown");
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as { code: string; fieldErrors?: Record<string, string[]> };
      expect(body.code).toBe("VALIDATION_FAILED");
      expect(Object.keys(body.fieldErrors ?? {})).toContain("visibility");
    }
  });
});

/**
 * The standing guard. `@Body("field")` is the shape that silently opts a handler out of validation, so
 * this fails the build if one appears again without a pipe — the same "ask the rule instead of restating
 * it" posture as share-link-rule.guard.test.ts.
 */
describe("no handler may take a body without validating it", () => {
  const controllers: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".controller.ts")) controllers.push(p);
    }
  })(join(__dirname, ".."));

  it("finds no @Body() handler without a reachable ZodValidationPipe", () => {
    const offenders: string[] = [];
    for (const file of controllers) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.includes("@Body(")) continue;
        if (/@Body\(\s*new ZodValidationPipe/.test(lines[i]!)) continue;
        let decorators = "";
        for (let j = i; j >= 0 && i - j < 15; j--) {
          decorators = lines[j] + "\n" + decorators;
          if (/^\s{2}\}/.test(lines[j]!) || /export class/.test(lines[j]!)) break;
        }
        if (/ZodValidationPipe/.test(decorators)) continue;
        offenders.push(`${file.split(/[\\/]/).slice(-2).join("/")}:${i + 1}  ${lines[i]!.trim().slice(0, 80)}`);
      }
    }

    // The four that remain are deliberate and each verifies its caller before reading the body:
    // three provider webhooks (Gmail push JWT, Microsoft Graph clientState, Plaid signature header) and
    // the Apple OAuth callback, whose body is a form post validated by the OAuth exchange itself. They
    // are listed rather than pattern-excluded so adding a fifth is a decision, not an accident.
    const ALLOWED = ["webhooks.controller.ts", "billing.controller.ts", "identity.controller.ts:"];
    const unexpected = offenders.filter((o) => !ALLOWED.some((a) => o.includes(a)));
    expect(unexpected, "a @Body() handler with no validation pipe").toEqual([]);
  });
});
