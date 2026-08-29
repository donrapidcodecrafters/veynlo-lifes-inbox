"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import useSWR from "swr";
import { api, swrFetcher } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardBody } from "@/components/ui/card";

interface AskResponse {
  answer: string;
  evidence: Array<{ resourceType: string; resourceId: string; text: string }>;
  insufficientEvidence: boolean;
}

/** ASK-002 "structured search" — was real and correct server-side (GET /v1/search) but had zero UI
 * calling it anywhere; this is that missing surface. A second mode on this same page rather than a
 * separate destination, matching the spec's own "Ask/Search" combined Core-UX entry. */
interface SearchResponse {
  purchases: Array<{ id: string; orderNumber: string | null }>;
  bills: Array<{ id: string; billerLabel: string }>;
  documents: Array<{ id: string; title: string }>;
  events: Array<{ id: string; title: string }>;
}

interface SavedQuery {
  id: string;
  questionText: string;
  createdAt: string;
}

const SUGGESTIONS = [
  "What purchases can I still return?",
  "What bills are due this week?",
  "How much am I paying for subscriptions?",
];

// Web Speech API isn't in the standard lib.dom types and is Chrome/Edge-only (no Safari support as of
// this writing) — feature-detected at runtime, never assumed present.
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

export default function AskPage() {
  const [mode, setMode] = useState<"ask" | "search">("ask");
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [history, setHistory] = useState<Array<{ question: string; response: AskResponse }>>([]);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [voiceSupported, setVoiceSupported] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);

  const { data: savedQueries, mutate: mutateSavedQueries } = useSWR<SavedQuery[]>("/v1/saved-queries", swrFetcher);

  useEffect(() => {
    setVoiceSupported(getSpeechRecognition() !== null);
  }, []);

  async function ask(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const recentHistory = history.slice(0, 5).map((h) => ({ question: h.question, answer: h.response.answer })).reverse();
      const response = await api.post<AskResponse>("/v1/ask", { question: q, history: recentHistory });
      setResult(response);
      setHistory((h) => [{ question: q, response }, ...h]);
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void ask(question);
  }

  async function runSearch(e: FormEvent) {
    e.preventDefault();
    if (!searchTerm.trim()) return;
    setSearching(true);
    try {
      const response = await api.get<SearchResponse>(`/v1/search?q=${encodeURIComponent(searchTerm)}`);
      setSearchResult(response);
    } finally {
      setSearching(false);
    }
  }

  async function openDocument(id: string) {
    const { url } = await api.get<{ url: string }>(`/v1/documents/${id}/download-url`);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function toggleVoice() {
    const SpeechRecognitionCtor = getSpeechRecognition();
    if (!SpeechRecognitionCtor) return;

    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) {
        setQuestion(transcript);
        void ask(transcript);
      }
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  async function saveCurrentQuestion() {
    if (!question.trim()) return;
    await api.post("/v1/saved-queries", { questionText: question });
    mutateSavedQueries();
  }

  async function deleteSavedQuery(id: string) {
    await api.post(`/v1/saved-queries/${id}/delete`);
    mutateSavedQueries();
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Ask Veynlo</h1>
        <p className="mt-1 text-sm text-tertiary">Ask about anything Veynlo knows — grounded in your own data.</p>
      </header>

      <div className="flex gap-1 rounded-lg bg-subtle p-1" role="tablist">
        {(["ask", "search"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === m ? "bg-surface text-primary shadow-xs" : "text-tertiary"
            }`}
          >
            {m === "ask" ? "Ask" : "Search"}
          </button>
        ))}
      </div>

      {mode === "search" ? (
        <div className="space-y-4">
          <form onSubmit={runSearch} className="flex gap-2">
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search purchases, bills, documents, events…"
              className="flex-1"
            />
            <Button type="submit" loading={searching}>
              Search
            </Button>
          </form>

          {searchResult && (
            <div className="space-y-5">
              {searchResult.purchases.length === 0 &&
                searchResult.bills.length === 0 &&
                searchResult.documents.length === 0 &&
                searchResult.events.length === 0 && <p className="text-sm text-tertiary">No matches.</p>}

              {searchResult.purchases.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Purchases</p>
                  {searchResult.purchases.map((p) => (
                    <Link key={p.id} href={`/life/purchases/${p.id}`} className="block text-sm text-brand hover:underline">
                      Order {p.orderNumber ?? p.id}
                    </Link>
                  ))}
                </div>
              )}

              {searchResult.bills.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Bills</p>
                  {searchResult.bills.map((b) => (
                    <Link key={b.id} href={`/life/bills/${b.id}`} className="block text-sm text-brand hover:underline">
                      {b.billerLabel}
                    </Link>
                  ))}
                </div>
              )}

              {searchResult.documents.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Documents</p>
                  {searchResult.documents.map((d) => (
                    <button key={d.id} onClick={() => openDocument(d.id)} className="block text-sm text-brand hover:underline">
                      {d.title}
                    </button>
                  ))}
                </div>
              )}

              {searchResult.events.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Events</p>
                  {searchResult.events.map((e) => (
                    <Link key={e.id} href={`/life/events/${e.id}`} className="block text-sm text-brand hover:underline">
                      {e.title}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="When does my warranty expire?"
          className="flex-1"
        />
        <div className="flex shrink-0 gap-2">
          {voiceSupported && (
            <Button type="button" variant={listening ? "primary" : "secondary"} onClick={toggleVoice} aria-label={listening ? "Listening" : "Ask by voice"}>
              {listening ? "Listening…" : "🎙"}
            </Button>
          )}
          <Button type="submit" loading={loading} className="flex-1 sm:flex-none">
            Ask
          </Button>
          <Button type="button" variant="secondary" onClick={saveCurrentQuestion} disabled={!question.trim()} className="flex-1 sm:flex-none">
            Save
          </Button>
        </div>
      </form>

      {savedQueries && savedQueries.length > 0 && !result && !loading && history.length === 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Saved questions</p>
          <div className="flex flex-wrap gap-2">
            {savedQueries.map((sq) => (
              <div key={sq.id} className="flex items-center gap-1 rounded-full border border-border-default pl-3 pr-1 py-1">
                <button
                  onClick={() => {
                    setQuestion(sq.questionText);
                    void ask(sq.questionText);
                  }}
                  className="text-sm text-secondary hover:text-primary"
                >
                  {sq.questionText}
                </button>
                <button
                  onClick={() => deleteSavedQuery(sq.id)}
                  aria-label="Delete saved question"
                  className="rounded-full px-1.5 text-tertiary hover:bg-subtle hover:text-critical"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

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

      {result && (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-[0.9375rem] text-primary">{result.answer}</p>
            {result.evidence.length > 0 && (
              <div className="border-t border-border-subtle pt-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Sources</p>
                <ul className="space-y-1">
                  {result.evidence.map((e) => (
                    <li key={e.resourceId} className="text-sm text-secondary">
                      {e.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>
      )}

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
    </div>
  );
}
