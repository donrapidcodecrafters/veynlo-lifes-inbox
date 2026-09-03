import type { DocumentProcessingState } from "@veynlo/core";

/**
 * §40.3 "Representative state machines" (Document row): "uploaded → malware scan → OCR/parser →
 * classified → extracted → linked → verified / superseded / archived / deleted." The first two steps
 * ("malware scan", "OCR/parser") never appear as a stored `processingState` value — see `upload()`'s own
 * doc comment: malware scanning happens before a document row exists at all, and OCR/parsing is the
 * in-flight gap between "uploaded" and "classified"/"extracted". `DocumentProcessingStateSchema` in
 * `@veynlo/core` still lists them (as `malware_scan`/`ocr_parsing`) for documentation completeness, but
 * they're intentionally absent from `PIPELINE` below and therefore never a valid transition target.
 *
 * `PIPELINE` is the forward-only, monotonic backbone every document's `processingState` climbs through on
 * its way to (or towards) "verified". `superseded`/`archived`/`deleted` are overlay outcomes that can be
 * reached directly from any pipeline stage, but have their own, narrower rules for what they can become
 * next — see `isValidProcessingStateTransition` below.
 */
export const DOCUMENT_PROCESSING_PIPELINE: readonly DocumentProcessingState[] = ["uploaded", "classified", "extracted", "linked", "verified"];

/**
 * The single source of truth for which `processingState` → `processingState` transitions this module
 * allows, used by every explicit user-triggered action (verify/archive/unarchive/markSuperseded/delete) so
 * a client can never force a document into a nonsensical or destructive state — e.g. regressing a
 * "verified" document back to "uploaded", or reviving a hard-deleted one. Internal automatic pipeline
 * advances (upload/processOcr/linkToEntity) are already deterministic and forward-only by construction, but
 * route through this too for defense in depth and a single place this rule set lives.
 */
export function isValidProcessingStateTransition(from: DocumentProcessingState, to: DocumentProcessingState): boolean {
  if (from === to) return true; // idempotent re-application (e.g. verifying an already-verified document) is always fine

  // "uploaded" is the one-time state a document is created in (DocumentsService.upload) — nothing ever
  // transitions back into it, not even an archived-and-restored document (DocumentsService.unarchive
  // restores at earliest to "classified"/whatever pipeline stage it was actually archived from — see that
  // method's own doc comment for why "uploaded" itself is never a legitimate restore target).
  if (to === "uploaded") return false;

  // Deletion is final in this module's document model — see DocumentsService.delete's own doc comment:
  // only the account-deletion and connector-data-deletion workers ever hard-delete a document's content;
  // there is no in-app single-document "undelete." So once "deleted", no further transition is valid.
  if (from === "deleted") return false;

  // A superseded document is still tidyable (a user can archive or eventually delete an old, replaced
  // version) but never revived back into the live pipeline — that would recreate exactly the "two live,
  // ambiguous documents" state supersession exists to resolve.
  if (from === "superseded") return to === "archived" || to === "deleted";

  // Unarchiving restores whichever pipeline stage (or "superseded") the document was actually in right
  // before it was archived — DocumentsService.unarchive computes `to` from the stored
  // `previousProcessingState` snapshot, never from client input, so this branch is a sanity check on that
  // computed value rather than a client-facing choice. Deleting an archived document outright is the other
  // legal way out.
  if (from === "archived") return to === "deleted" || to === "superseded" || DOCUMENT_PROCESSING_PIPELINE.includes(to);

  const fromIdx = DOCUMENT_PROCESSING_PIPELINE.indexOf(from);
  if (fromIdx === -1) return false; // e.g. "malware_scan"/"ocr_parsing" — never actually stored, so never a valid `from` either

  const toIdx = DOCUMENT_PROCESSING_PIPELINE.indexOf(to);
  if (toIdx !== -1) return toIdx > fromIdx; // forward-only through the pipeline, never sideways or backward

  return to === "superseded" || to === "archived" || to === "deleted"; // any live pipeline stage can be superseded/archived/deleted directly
}
