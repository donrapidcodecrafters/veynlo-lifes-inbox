"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardBody } from "@/components/ui/card";

interface AskResponse {
  answer: string;
  evidence: Array<{ resourceType: string; resourceId: string; text: string }>;
  insufficientEvidence: boolean;
}

const SUGGESTIONS = [
  "What purchases can I still return?",
  "What bills are due this week?",
  "How much am I paying for subscriptions?",
];

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResponse | null>(null);
  const [history, setHistory] = useState<Array<{ question: string; response: AskResponse }>>([]);

  async function ask(q: string) {
    if (!q.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const response = await api.post<AskResponse>("/v1/ask", { question: q });
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
        <Button type="submit" loading={loading}>
          Ask
        </Button>
      </form>

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
