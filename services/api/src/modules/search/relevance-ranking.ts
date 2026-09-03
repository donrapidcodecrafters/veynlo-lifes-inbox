/**
 * §ASK-001 "grounded... retrieval" — originally Ask's ONLY ranking mechanism (a plain lexical-overlap
 * score computed in application code, since none of these fields were ever searchable via a SQL predicate:
 * either AES-GCM ciphertext at the source, per SearchService.structuredSearch's identical historical
 * constraint, or simply never indexed anywhere).
 *
 * §44.4 "Search architecture" — `search_documents` (packages/db/src/schema/search.ts) is now a real,
 * plaintext, Postgres-full-text-indexed mirror of these same domains (see
 * search-index.service.ts/search.service.ts), so `SearchService.structuredSearch` no longer uses this file
 * at all, and `SearchService.ask` now prefers a real `ts_rank` score wherever one is available. This module
 * survives purely as `ask`'s FALLBACK for whatever hasn't been indexed (not yet backfilled, or a write path
 * this phase didn't wire) — see `ask`'s own doc comment for why a fallback has to exist at all: real
 * semantic (embedding-similarity) matching is the eventual right answer for a vague/paraphrased question
 * with no literal keyword overlap (§44.4's "Semantic" mode), but needs a configured, paid embedding
 * provider that's out of scope this phase — search_documents.embedding stays unused until then.
 *
 * This is NOT a claim of semantic understanding — "cancel" and "terminate" won't match each other — only
 * that shared, meaningful words between the question and a candidate item make it more likely to be what
 * the question is actually about than an arbitrary item that happens to have loaded first.
 */

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "did", "do", "does", "for", "from", "had",
  "has", "have", "how", "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "that", "the", "this",
  "to", "was", "were", "what", "when", "where", "which", "who", "will", "with", "you", "your",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/**
 * Scores `text` against `question` by counting distinct meaningful question-words it contains, normalized
 * by the number of meaningful words in the question — so a candidate matching 3 of 4 significant terms
 * scores higher than one matching 1 of 4, regardless of either text's overall length. Returns 0..1.
 */
export function scoreRelevance(question: string, text: string): number {
  const questionWords = new Set(tokenize(question));
  if (questionWords.size === 0) return 0;
  const textWords = new Set(tokenize(text));
  let matched = 0;
  for (const word of questionWords) {
    if (textWords.has(word)) matched += 1;
  }
  return matched / questionWords.size;
}

/** Sorts candidates by relevance to `question` (highest first) and keeps the top `limit`. Ties keep their original relative order (a stable sort), which matters when many items score 0 and there's no other signal to break ties on. */
export function rankByRelevance<T>(question: string, items: T[], getText: (item: T) => string, limit: number): T[] {
  return items
    .map((item, index) => ({ item, index, score: scoreRelevance(question, getText(item)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}
