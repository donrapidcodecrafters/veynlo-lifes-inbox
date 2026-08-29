"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

interface SharedItem {
  reasonText: string;
  urgency: "critical" | "important" | "useful" | "informational";
  dueAt: TemporalValueLike | null;
  moneyAtStakeMinorUnits: number | null;
  moneyAtStakeCurrency: string | null;
}

const URGENCY_TONE: Record<SharedItem["urgency"], "critical" | "warning" | "info" | "neutral"> = {
  critical: "critical",
  important: "warning",
  useful: "info",
  informational: "neutral",
};

/** Public — no sign-in required. Anyone with this link can view exactly the fields SharedService returns, nothing else. */
export default function SharedItemPage() {
  const params = useParams<{ token: string }>();
  const [item, setItem] = useState<SharedItem | "loading" | "invalid">("loading");

  useEffect(() => {
    api
      .get<SharedItem>(`/v1/shared/${params.token}`)
      .then(setItem)
      .catch((err) => setItem(err instanceof ApiError ? "invalid" : "invalid"));
  }, [params.token]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-[480px]">
        <div className="mb-8 text-center">
          <span className="text-xl font-semibold tracking-tight text-primary">Veynlo</span>
          <p className="mt-1 text-sm text-tertiary">Shared with you</p>
        </div>

        {item === "loading" && (
          <Card>
            <CardBody>
              <div className="h-16 animate-pulse rounded-lg bg-subtle" />
            </CardBody>
          </Card>
        )}

        {item === "invalid" && (
          <Card>
            <CardBody className="space-y-1 text-center">
              <p className="text-[0.9375rem] font-medium text-primary">This link isn't available anymore.</p>
              <p className="text-sm text-tertiary">It may have expired or been revoked by whoever shared it.</p>
            </CardBody>
          </Card>
        )}

        {item !== "loading" && item !== "invalid" && (
          <Card>
            <CardBody className="space-y-2">
              <Badge tone={URGENCY_TONE[item.urgency]}>{item.urgency}</Badge>
              <p className="text-[0.9375rem] font-medium text-primary">{item.reasonText}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-tertiary">
                {formatTemporal(item.dueAt) && <span>Due {formatTemporal(item.dueAt)}</span>}
                {formatMoneyMinorUnits(item.moneyAtStakeMinorUnits, item.moneyAtStakeCurrency) && (
                  <span className="font-medium text-primary">
                    {formatMoneyMinorUnits(item.moneyAtStakeMinorUnits, item.moneyAtStakeCurrency)} at stake
                  </span>
                )}
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
