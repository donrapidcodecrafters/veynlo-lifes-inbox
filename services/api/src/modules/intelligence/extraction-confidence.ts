/**
 * §39.2 "per-domain calibration evaluations" — until a real calibration dataset exists, a fixed
 * `confidenceScore: 0.82` on every single extraction (found live via a real audit) meant the confidence
 * band the UI surfaces ("why should I trust this?") was never actually informative — every extraction
 * landed in the same band regardless of how much the model actually found.
 *
 * This is a genuine, if simple, heuristic rather than a calibrated probability: every extraction schema in
 * `extraction-schemas.ts` instructs the model to return `null` for a field it isn't confident about rather
 * than guess (every systemPrompt: "never invent a date or amount that is not clearly stated"), so how much
 * of the schema came back non-null is a real, if imperfect, signal of how much the model actually found
 * versus declined to answer. It is NOT a signal that a populated field is correct — a model can still
 * confidently hallucinate a wrong-but-present value — which is exactly why the mapped range stays bounded
 * well short of [0, 1] rather than claiming certainty either extreme would imply.
 */
export function computeExtractionConfidence(data: Record<string, unknown>): number {
  const entries = Object.entries(data).filter(([key]) => key !== "confidenceNotes");
  if (entries.length === 0) return 0.5;
  const isPresent = (value: unknown): boolean => {
    if (value === null || value === undefined || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  };
  const completeness = entries.filter(([, value]) => isPresent(value)).length / entries.length;
  return 0.5 + 0.45 * completeness;
}
