import { BadRequestException, type ArgumentMetadata, type PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

/**
 * A pipe attached via method-level `@UsePipes` runs against EVERY parameter
 * of that handler, not just `@Body()` — so it must ignore anything that
 * isn't the body (e.g. `@CurrentUser()`, `@Param()`) rather than validating
 * it against a body schema it was never meant for.
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, metadata: ArgumentMetadata) {
    if (metadata.type !== "body") return value;

    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: "VALIDATION_FAILED",
        message: "Request body failed validation.",
        fieldErrors: result.error.flatten().fieldErrors,
      });
    }
    return result.data;
  }
}
