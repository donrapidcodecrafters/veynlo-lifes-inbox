"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
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
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [history, setHistory] = useState<Array<{ question: string; response: AskResponse }>>([]);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [voiceSupported, setVoiceSupported] = useState(false);

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

      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="When does my warranty expire?"
          className="flex-1"
        />
        {voiceSupported && (
          <Button type="button" variant={listening ? "primary" : "secondary"} onClick={toggleVoice}>
            {listening ? "Listening…" : "🎙"}
          </Button>
        )}
        <Button type="submit" loading={loading}>
          Ask
        </Button>
        <Button type="button" variant="secondary" onClick={saveCurrentQuestion} disabled={!question.trim()}>
          Save
        </Button>
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
    </div>
  );
}
