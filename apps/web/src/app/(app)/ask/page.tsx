"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FetchError } from "@/components/ui/fetch-error";
import { formatMoneyMinorUnits } from "@/lib/format";

interface RelatedSavedMemory {
  id: string;
  title: string | null;
  category: string | null;
  sourceKind: string;
}

interface AskResponse {
  answer: string;
  evidence: Array<{ resourceType: string; resourceId: string; text: string }>;
  insufficientEvidence: boolean;
  // SAVE-004 "query-based resurfacing" — saved memories relevant to the question but not themselves pulled
  // into the grounding context above.
  relatedSavedMemories: RelatedSavedMemory[];
}

interface SearchPurchase {
  id: string;
  merchantName: string | null;
  orderNumber: string | null;
  totalMinorUnits: number | null;
  totalCurrency: string | null;
  state: string;
}
interface SearchBill {
  id: string;
  billerLabel: string;
  amountDueMinorUnits: number | null;
  amountDueCurrency: string | null;
}
interface SearchDocument {
  id: string;
  title: string;
  documentType: string;
}
interface SearchEvent {
  id: string;
  title: string;
  location: string | null;
}
interface SearchWarranty {
  id: string;
  productLabel: string;
  expirationDate: { date: string | null } | null;
}
interface SearchSubscription {
  id: string;
  serviceLabel: string;
  cadence: string;
  typicalAmountMinorUnits: number | null;
  typicalAmountCurrency: string | null;
}
interface SearchShipment {
  id: string;
  carrier: string;
  trackingNumber: string;
  status: string;
}
interface SearchReturnCase {
  id: string;
  state: string;
  orderNumber: string | null;
  merchantName: string | null;
}
interface SearchTrip {
  id: string;
  label: string | null;
  destinationLabel: string | null;
  status: string;
}
interface SearchSavedMemory {
  id: string;
  title: string | null;
  category: string | null;
  sourceKind: string;
}
interface SearchPet {
  id: string;
  label: string;
  species: string | null;
  breed: string | null;
}
interface SearchHealthAppointment {
  id: string;
  providerName: string | null;
  appointmentType: string | null;
}
interface SearchResponse {
  purchases: SearchPurchase[];
  bills: SearchBill[];
  documents: SearchDocument[];
  events: SearchEvent[];
  warranties: SearchWarranty[];
  subscriptions: SearchSubscription[];
  shipments: SearchShipment[];
  returnCases: SearchReturnCase[];
  trips: SearchTrip[];
  savedMemories: SearchSavedMemory[];
  pets: SearchPet[];
  healthAppointments: SearchHealthAppointment[];
  relatedSavedMemories: RelatedSavedMemory[];
}

/** SAVE-004 "query-based resurfacing" — a small "you might also want to revisit" strip shown alongside
 * either mode's primary results, never as its own independent feed. */
function RelatedSavedMemories({ items }: { items: RelatedSavedMemory[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">You might also want to revisit</p>
      <div className="flex flex-wrap gap-2">
        {items.map((m) => (
          <Link key={m.id} href={`/saved/${m.id}`} className="rounded-lg border border-border-default px-3 py-2 text-sm text-secondary hover:bg-subtle">
            {m.title ?? "Untitled"}
            <span className="ml-1.5 text-xs capitalize text-tertiary">{(m.category ?? m.sourceKind).replace(/_/g, " ")}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  "What purchases can I still return?",
  "What bills are due this week?",
  "How much am I paying for subscriptions?",
];

// §ASK-001 "open source" — evidence came back from the API with a resourceType/resourceId on every item
// (exactly what's needed to link to the real record), but the Sources list rendered as plain, unlinked
// text — found live via a real audit. Mirrors the Timeline page's identical KIND_HREF mapping so a
// purchase/bill/event/etc. evidence item resolves to the same Life detail page either way. `document` has
// no per-document detail route yet (same gap Timeline's own map documents), so it links to the list.
const EVIDENCE_HREF: Record<string, (id: string) => string> = {
  purchase: (id) => `/life/purchases/${id}`,
  bill: (id) => `/life/bills/${id}`,
  calendar_event: (id) => `/life/events/${id}`,
  warranty: (id) => `/life/warranties/${id}`,
  subscription: (id) => `/life/subscriptions/${id}`,
  shipment: (id) => `/life/shipments/${id}`,
  return_case: (id) => `/life/returns/${id}`,
  document: () => `/documents`,
  // §ASK-002 domain coverage — mirrors search.service.ts's identical fix: trip/saved_memory/pet/
  // health_appointment evidence started coming back from Ask once those domains were added to grounding,
  // but with no matching route here they'd have rendered as plain unlinked text, same "Sources" bug this
  // page's own EVIDENCE_HREF comment describes for every other resource type.
  trip: (id) => `/trips/${id}`,
  saved_memory: (id) => `/saved/${id}`,
  pet: (id) => `/life/pets/${id}`,
  health_appointment: () => `/life`,
};

// Delegates to the same formatter Home/Inbox use (localized currency symbol, e.g. "$429.99") so an amount
// doesn't read differently depending on which page a user is on — this page previously rolled its own
// "429.99 USD" format instead of reusing lib/format.ts's formatMoneyMinorUnits.
function money(minorUnits: number | null, currency: string | null): string {
  return formatMoneyMinorUnits(minorUnits, currency) ?? "amount unknown";
}

export default function AskPage() {
  const [mode, setMode] = useState<"ask" | "search">("ask");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [history, setHistory] = useState<Array<{ question: string; response: AskResponse }>>([]);
  // Neither of ask()/runSearch() below had a catch at all before this fix — a transient 500/network
  // error on either request threw straight out of the form's submit handler as an unhandled promise
  // rejection, silently clearing the loading spinner with nothing else shown (no result, no error, no
  // way to tell the request even failed).
  const [askError, setAskError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  async function ask(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setResult(null);
    setAskError(null);
    try {
      const response = await api.post<AskResponse>("/v1/ask", { question: q });
      setResult(response);
      setHistory((h) => [{ question: q, response }, ...h]);
    } catch (err) {
      setAskError(err instanceof ApiError ? err.message : "Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function runSearch(q: string) {
    if (!q.trim()) {
      setSearchResult(null);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const response = await api.get<SearchResponse>(`/v1/search?q=${encodeURIComponent(q)}`);
      setSearchResult(response);
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : "Please check your connection and try again.");
    } finally {
      setSearchLoading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mode === "search") void runSearch(searchQuery);
    else void ask(question);
  }

  const searchTotal = searchResult
    ? searchResult.purchases.length +
      searchResult.bills.length +
      searchResult.documents.length +
      searchResult.events.length +
      searchResult.warranties.length +
      searchResult.subscriptions.length +
      searchResult.shipments.length +
      searchResult.returnCases.length +
      searchResult.trips.length +
      searchResult.savedMemories.length +
      searchResult.pets.length +
      searchResult.healthAppointments.length
    : 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Ask Veynlo</h1>
        <p className="mt-1 text-sm text-tertiary">
          {mode === "ask" ? "Ask about anything Veynlo knows — grounded in your own data." : "Search across your purchases, bills, documents, trips, pets, and more."}
        </p>
      </header>

      <div className="flex w-fit gap-1 rounded-lg bg-subtle p-1">
        {(["ask", "search"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === m ? "bg-surface text-primary shadow-sm" : "text-tertiary hover:text-secondary"
            }`}
          >
            {m === "ask" ? "Ask" : "Search"}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          value={mode === "ask" ? question : searchQuery}
          onChange={(e) => (mode === "ask" ? setQuestion(e.target.value) : setSearchQuery(e.target.value))}
          placeholder={mode === "ask" ? "When does my warranty expire?" : "Search by merchant, order number, biller, title…"}
          className="flex-1"
        />
        <Button type="submit" loading={mode === "ask" ? loading : searchLoading}>
          {mode === "ask" ? "Ask" : "Search"}
        </Button>
      </form>

      {mode === "ask" && (
        <>
          {!result && !loading && history.length === 0 && (
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setQuestion(s);
                    void ask(s);
                  }}
                  className="rounded-full border border-border-default px-3 py-1.5 text-sm text-secondary hover:bg-subtle"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {loading && <div className="h-24 animate-pulse rounded-xl bg-subtle" />}

          {!loading && askError && <FetchError what="an answer" message={askError} onRetry={() => ask(question)} />}

          {result && (
            <Card>
              <CardBody className="space-y-3">
                {/* §ASK-001 "uncertainty if any" — insufficientEvidence came back from the API on every
                    response but was never rendered, so a low-confidence answer looked exactly as
                    authoritative as a fully-grounded one. */}
                {result.insufficientEvidence && <Badge tone="warning">Not confident</Badge>}
                <p className="text-[0.9375rem] text-primary">{result.answer}</p>
                {result.evidence.length > 0 && (
                  <div className="border-t border-border-subtle pt-3">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Sources</p>
                    <ul className="space-y-1">
                      {result.evidence.map((e) => {
                        const href = EVIDENCE_HREF[e.resourceType]?.(e.resourceId);
                        return (
                          <li key={e.resourceId} className="text-sm text-secondary">
                            {href ? (
                              <Link href={href} className="text-brand hover:underline">
                                {e.text}
                              </Link>
                            ) : (
                              e.text
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </CardBody>
            </Card>
          )}

          {result && result.relatedSavedMemories.length > 0 && <RelatedSavedMemories items={result.relatedSavedMemories} />}

          {history.length > 1 && (
            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Earlier</p>
              {history.slice(1).map((h, i) => (
                <Card key={i}>
                  <CardBody className="space-y-1.5">
                    <p className="text-sm font-medium text-primary">{h.question}</p>
                    <p className="text-sm text-secondary">{h.response.answer}</p>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {mode === "search" && (
        <>
          {searchLoading && <div className="h-24 animate-pulse rounded-xl bg-subtle" />}

          {!searchLoading && searchError && <FetchError what="search results" message={searchError} onRetry={() => runSearch(searchQuery)} />}

          {!searchLoading && !searchError && searchResult && searchTotal === 0 && (
            <div className="space-y-5">
              <p className="text-sm text-tertiary">No matches for &ldquo;{searchQuery}&rdquo;.</p>
              <RelatedSavedMemories items={searchResult.relatedSavedMemories} />
            </div>
          )}

          {!searchLoading && searchResult && searchTotal > 0 && (
            <div className="space-y-5">
              <RelatedSavedMemories items={searchResult.relatedSavedMemories} />
              {searchResult.purchases.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Purchases</p>
                  <div className="space-y-2">
                    {searchResult.purchases.map((p) => (
                      <Link key={p.id} href={`/life/purchases/${p.id}`}>
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{p.merchantName ?? "Unknown merchant"}</p>
                            <p className="text-xs text-tertiary">
                              {p.orderNumber ? `Order ${p.orderNumber} — ` : ""}
                              {money(p.totalMinorUnits, p.totalCurrency)} — {p.state}
                            </p>
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {searchResult.bills.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Bills</p>
                  <div className="space-y-2">
                    {searchResult.bills.map((b) => (
                      <Link key={b.id} href={`/life/bills/${b.id}`}>
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{b.billerLabel}</p>
                            <p className="text-xs text-tertiary">{money(b.amountDueMinorUnits, b.amountDueCurrency)} due</p>
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {searchResult.events.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Events</p>
                  <div className="space-y-2">
                    {searchResult.events.map((e) => (
                      <Link key={e.id} href={`/life/events/${e.id}`}>
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{e.title}</p>
                            {e.location && <p className="text-xs text-tertiary">{e.location}</p>}
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {searchResult.documents.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Documents</p>
                  <div className="space-y-2">
                    {searchResult.documents.map((d) => (
                      <Link key={d.id} href="/documents">
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{d.title}</p>
                            <p className="text-xs capitalize text-tertiary">{d.documentType.replace(/_/g, " ")}</p>
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {/* §ASK-002 domain coverage — the eight categories below (warranties through health
                  appointments) mirror search.service.ts's identical structuredSearch fix: these domains were
                  never searched at all before, so there was nothing here to render for them either. */}
              {searchResult.warranties.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Warranties</p>
                  <div className="space-y-2">
                    {searchResult.warranties.map((w) => (
                      <Link key={w.id} href={`/life/warranties/${w.id}`}>
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{w.productLabel}</p>
                            {w.expirationDate?.date && <p className="text-xs text-tertiary">Expires {w.expirationDate.date}</p>}
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {searchResult.subscriptions.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Subscriptions</p>
                  <div className="space-y-2">
                    {searchResult.subscriptions.map((s) => (
                      <Link key={s.id} href={`/life/subscriptions/${s.id}`}>
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{s.serviceLabel}</p>
                            <p className="text-xs text-tertiary">
                              {money(s.typicalAmountMinorUnits, s.typicalAmountCurrency)} / {s.cadence}
                            </p>
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {searchResult.shipments.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Shipments</p>
                  <div className="space-y-2">
                    {searchResult.shipments.map((s) => (
                      <Link key={s.id} href={`/life/shipments/${s.id}`}>
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{s.carrier}</p>
                            <p className="text-xs text-tertiary">{s.trackingNumber} — {s.status}</p>
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {searchResult.returnCases.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Returns</p>
                  <div className="space-y-2">
                    {searchResult.returnCases.map((r) => (
                      <Link key={r.id} href={`/life/returns/${r.id}`}>
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{r.merchantName ?? "Unknown merchant"}</p>
                            <p className="text-xs text-tertiary">
                              {r.orderNumber ? `Order ${r.orderNumber} — ` : ""}
                              {r.state}
                            </p>
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {searchResult.trips.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Trips</p>
                  <div className="space-y-2">
                    {searchResult.trips.map((t) => (
                      <Link key={t.id} href={`/trips/${t.id}`}>
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{t.label ?? t.destinationLabel ?? "Trip"}</p>
                            <p className="text-xs capitalize text-tertiary">{t.status}</p>
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {searchResult.savedMemories.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Saved</p>
                  <div className="space-y-2">
                    {searchResult.savedMemories.map((m) => (
                      <Link key={m.id} href={`/saved/${m.id}`}>
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{m.title ?? "Untitled"}</p>
                            <p className="text-xs capitalize text-tertiary">{(m.category ?? m.sourceKind).replace(/_/g, " ")}</p>
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {searchResult.pets.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Pets</p>
                  <div className="space-y-2">
                    {searchResult.pets.map((p) => (
                      <Link key={p.id} href={`/life/pets/${p.id}`}>
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{p.label}</p>
                            {(p.species || p.breed) && (
                              <p className="text-xs text-tertiary">{[p.species, p.breed].filter(Boolean).join(" — ")}</p>
                            )}
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              {searchResult.healthAppointments.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Health appointments</p>
                  <div className="space-y-2">
                    {searchResult.healthAppointments.map((a) => (
                      <Link key={a.id} href="/life">
                        <Card className="transition-colors hover:bg-subtle">
                          <CardBody className="py-3">
                            <p className="text-sm font-medium text-primary">{a.providerName ?? a.appointmentType ?? "Appointment"}</p>
                            {a.appointmentType && a.providerName && <p className="text-xs capitalize text-tertiary">{a.appointmentType}</p>}
                          </CardBody>
                        </Card>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
