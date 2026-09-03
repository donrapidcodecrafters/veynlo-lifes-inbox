"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";

interface Household {
  id: string;
  name: string;
}

interface MyHousehold {
  household: Household;
}

interface EmergencyBinderMember {
  id: string;
  userId: string | null;
  role: string;
  relationshipLabel: string | null;
  status: string;
  displayName: string | null;
  email: string | null;
}

interface EmergencyBinderDependent {
  id: string;
  displayName: string;
  birthDate: string | null;
}

interface EmergencyBinderVehicle {
  id: string;
  label: string;
  make: string | null;
  model: string | null;
  year: number | null;
  vin: string | null;
}

interface EmergencyBinderProperty {
  id: string;
  label: string;
  propertyType: string;
  address: string | null;
}

interface EmergencyBinderDocument {
  id: string;
  title: string;
  documentType: string;
}

interface EmergencyBinderPet {
  id: string;
  label: string;
  species: string | null;
  breed: string | null;
  microchipNumber: string | null;
  vetProviderName: string | null;
  insuranceProviderName: string | null;
  vaccinations: Array<{ label: string; expirationDate: TemporalValueLike | null }>;
  medications: Array<{ medicationName: string; nextRefillDate: TemporalValueLike; pharmacy: string | null }>;
}

interface EmergencyBinderPayload {
  household: Household;
  medicationsNotes: string | null;
  emergencyInstructions: string | null;
  members: EmergencyBinderMember[];
  dependents: EmergencyBinderDependent[];
  vehicles: EmergencyBinderVehicle[];
  properties: EmergencyBinderProperty[];
  pets: EmergencyBinderPet[];
  documents: EmergencyBinderDocument[];
  generatedAt: string;
}

/** The household creator's own membership row is seeded server-side with the literal placeholder
 * relationshipLabel "self" (household.service.ts's `create()`) — rendering it verbatim reads as a data bug,
 * not a relationship label. Same fix already applied in settings/household/page.tsx's member list. */
function memberRelationshipLabel(m: EmergencyBinderMember): string {
  if (m.relationshipLabel && m.relationshipLabel.toLowerCase() !== "self") return m.relationshipLabel;
  return ROLE_LABEL[m.role] || m.role;
}

const ROLE_LABEL: Record<string, string> = {
  individual_owner: "Owner",
  household_owner: "Owner",
  adult_member: "Adult member",
  dependent_profile: "Dependent",
  caregiver_delegate: "Caregiver",
  emergency_contact: "Emergency contact",
  support_agent: "Support agent",
  service_principal: "Service",
};

/**
 * Phase 2 §52.2 "emergency binder" — the real cross-domain packet (household roster, vehicles, property,
 * flagged documents, medications/instructions), closing the "document-only subset" gap. §28.9 step-up
 * password gate before this ever reveals anything, since aggregating all of it in one place is what makes
 * it "biometric-protected" per spec — see EmergencyBinderService.getBinder's own doc comment for why the
 * gate lives server-side, not just as a client-side lock screen.
 */
export default function EmergencyBinderPage() {
  const { data: myHouseholds } = useSWR<MyHousehold[]>("/v1/households", swrFetcher);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Same "read from window.location.search directly" pattern as reset-password/sign-in — avoids needing a
  // Suspense boundary around a `useSearchParams()` call for a value that's only ever read once, on mount.
  // A link from Household settings ("View full binder →") carries ?householdId= for a specific household.
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("householdId");
    if (fromQuery) setSelectedId(fromQuery);
  }, []);

  const selected = myHouseholds?.find((h) => h.household.id === selectedId) ?? myHouseholds?.[0] ?? null;

  return (
    <div className="space-y-6">
      <header>
        <Link href="/settings/household" className="text-sm text-tertiary hover:text-primary">
          ← Household
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Emergency binder</h1>
        <p className="mt-1 text-sm text-tertiary">
          Everything a family member or first responder would need in an emergency, in one place. Confirm your
          password to view it — this is more sensitive than most pages in Veynlo, since it combines several
          kinds of information at once.
        </p>
      </header>

      {myHouseholds && myHouseholds.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {myHouseholds.map(({ household }) => (
            <button
              key={household.id}
              onClick={() => setSelectedId(household.id)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                (selected?.household.id ?? myHouseholds[0]?.household.id) === household.id
                  ? "bg-brand text-on-brand"
                  : "bg-subtle text-secondary hover:bg-border-subtle"
              }`}
            >
              {household.name}
            </button>
          ))}
        </div>
      )}

      {myHouseholds && myHouseholds.length === 0 && (
        <EmptyState title="No household yet" description="Create one from Household settings to build an emergency binder." />
      )}

      {selected && <BinderGate key={selected.household.id} householdId={selected.household.id} />}
    </div>
  );
}

function BinderGate({ householdId }: { householdId: string }) {
  const [binder, setBinder] = useState<EmergencyBinderPayload | null>(null);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock(withPassword?: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await api.post<EmergencyBinderPayload>(`/v1/emergency-binder/${householdId}/unlock`, { password: withPassword });
      setBinder(data);
      setPasswordPromptOpen(false);
      setPassword("");
    } catch (err) {
      // §28.9 step-up: try with no password first (matches data-export/settings/data-export's own
      // pattern) — an OAuth-only account never needs one, so this avoids prompting everyone up front.
      if (err instanceof ApiError && err.code === "PASSWORD_REQUIRED") {
        setPasswordPromptOpen(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't unlock the binder. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (binder) {
    return (
      <BinderView
        binder={binder}
        onLock={() => {
          // Re-locks on demand — the gate isn't a one-time-ever unlock; leaving this tab open and coming
          // back later should still require re-confirming, same reasoning as mobile's biometric re-prompt
          // on every screen open (see apps/mobile's emergency-binder screen).
          setBinder(null);
        }}
      />
    );
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        {!passwordPromptOpen && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-tertiary">Locked. Confirm your password to view this household&apos;s emergency binder.</p>
            <Button onClick={() => unlock()} loading={loading}>
              Unlock
            </Button>
          </div>
        )}
        {passwordPromptOpen && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              unlock(password);
            }}
            className="space-y-3"
            noValidate
          >
            <div>
              <Label htmlFor="binder-password">Confirm your password to continue</Label>
              <Input
                id="binder-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="flex gap-3">
              <Button type="submit" size="sm" loading={loading}>
                Unlock
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPasswordPromptOpen(false);
                  setPassword("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
            {error}
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function BinderView({ binder, onLock }: { binder: EmergencyBinderPayload; onLock: () => void }) {
  const activeMembers = binder.members.filter((m) => m.status === "active");

  return (
    <div className="space-y-6">
      {/* Print styles: everything else on the page (nav chrome from the (app) layout, the unlock controls,
          household-picker pills) is irrelevant on a printed/PDF copy — only #binder-printable should show.
          No PDF library anywhere in this app (checked services/api's data-export, the only other
          export-shaped feature — it's JSON-only) and adding one just for this one button would be out of
          proportion; every modern browser's own "Print → Save as PDF" is a real, zero-dependency PDF path. */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #binder-printable, #binder-printable * { visibility: visible; }
          #binder-printable { position: absolute; left: 0; top: 0; width: 100%; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="no-print flex items-center justify-between gap-3">
        <p className="text-xs text-tertiary">Generated {new Date(binder.generatedAt).toLocaleString()}</p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => window.print()}>
            Print / Save as PDF
          </Button>
          <Button variant="ghost" size="sm" onClick={onLock}>
            Hide
          </Button>
        </div>
      </div>

      <div id="binder-printable" className="space-y-6">
        <div className="hidden print:block">
          <h1 className="text-xl font-semibold">{binder.household.name} — Emergency binder</h1>
          <p className="text-sm text-tertiary">Generated {new Date(binder.generatedAt).toLocaleString()}</p>
        </div>

        {(binder.medicationsNotes || binder.emergencyInstructions) && (
          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Medications &amp; instructions</h2>
            <Card>
              <CardBody className="space-y-4">
                {binder.medicationsNotes && (
                  <div>
                    <p className="text-sm font-medium text-primary">Medications</p>
                    <p className="whitespace-pre-wrap break-words text-sm text-secondary">{binder.medicationsNotes}</p>
                  </div>
                )}
                {binder.emergencyInstructions && (
                  <div>
                    <p className="text-sm font-medium text-primary">Emergency instructions</p>
                    <p className="whitespace-pre-wrap break-words text-sm text-secondary">{binder.emergencyInstructions}</p>
                  </div>
                )}
              </CardBody>
            </Card>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Household</h2>
          <Card>
            <CardBody className="space-y-2">
              {activeMembers.map((m) => (
                <div key={m.id} className="flex items-center justify-between gap-3 border-b border-border-subtle pb-2 last:border-0 last:pb-0">
                  <p className="min-w-0 break-words text-sm font-medium text-primary">{m.displayName || m.email || "Household member"}</p>
                  <span className="shrink-0 text-xs text-tertiary">{memberRelationshipLabel(m)}</span>
                </div>
              ))}
              {binder.dependents.map((d) => (
                <div key={d.id} className="flex items-center justify-between gap-3 border-b border-border-subtle pb-2 last:border-0 last:pb-0">
                  <p className="min-w-0 break-words text-sm font-medium text-primary">{d.displayName}</p>
                  <span className="shrink-0 text-xs text-tertiary">Dependent</span>
                </div>
              ))}
            </CardBody>
          </Card>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Vehicles</h2>
          {binder.vehicles.length === 0 ? (
            <p className="text-sm text-tertiary">None on file.</p>
          ) : (
            <Card>
              <CardBody className="space-y-2">
                {binder.vehicles.map((v) => (
                  <div key={v.id} className="flex items-center justify-between gap-3 border-b border-border-subtle pb-2 last:border-0 last:pb-0">
                    <p className="min-w-0 break-words text-sm font-medium text-primary">{v.label}</p>
                    <span className="shrink-0 text-xs text-tertiary">{[v.year, v.make, v.model].filter(Boolean).join(" ")}{v.vin ? ` · VIN ${v.vin}` : ""}</span>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Property</h2>
          {binder.properties.length === 0 ? (
            <p className="text-sm text-tertiary">None on file.</p>
          ) : (
            <Card>
              <CardBody className="space-y-2">
                {binder.properties.map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-3 border-b border-border-subtle pb-2 last:border-0 last:pb-0">
                    <p className="min-w-0 break-words text-sm font-medium text-primary">{p.label}</p>
                    <span className="shrink-0 text-xs text-tertiary">{p.address || p.propertyType}</span>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Pets</h2>
          {binder.pets.length === 0 ? (
            <p className="text-sm text-tertiary">None on file.</p>
          ) : (
            <div className="space-y-3">
              {binder.pets.map((pet) => (
                <Card key={pet.id}>
                  <CardBody className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <p className="min-w-0 break-words text-sm font-medium text-primary">{pet.label}</p>
                      <span className="shrink-0 text-xs text-tertiary">{[pet.species, pet.breed].filter(Boolean).join(" · ")}</span>
                    </div>
                    {(pet.vetProviderName || pet.insuranceProviderName || pet.microchipNumber) && (
                      <p className="text-xs text-tertiary">
                        {pet.vetProviderName && `Vet: ${pet.vetProviderName}`}
                        {pet.vetProviderName && pet.insuranceProviderName ? " · " : ""}
                        {pet.insuranceProviderName && `Insurance: ${pet.insuranceProviderName}`}
                        {(pet.vetProviderName || pet.insuranceProviderName) && pet.microchipNumber ? " · " : ""}
                        {pet.microchipNumber && `Microchip: ${pet.microchipNumber}`}
                      </p>
                    )}
                    {pet.medications.length > 0 && (
                      <p className="text-xs text-secondary">
                        Medications: {pet.medications.map((m) => `${m.medicationName}${m.pharmacy ? ` (${m.pharmacy})` : ""}`).join(", ")}
                      </p>
                    )}
                    {pet.vaccinations.length > 0 && (
                      <p className="text-xs text-secondary">
                        Vaccinations:{" "}
                        {pet.vaccinations
                          .map((v) => `${v.label}${v.expirationDate ? ` (exp. ${formatTemporal(v.expirationDate)})` : ""}`)
                          .join(", ")}
                      </p>
                    )}
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Documents</h2>
          {binder.documents.length === 0 ? (
            <p className="text-sm text-tertiary">
              None yet — flag a shared document from the{" "}
              <Link href="/documents" className="text-brand hover:underline no-print">
                Documents
              </Link>{" "}
              page.
            </p>
          ) : (
            <Card>
              <CardBody className="space-y-2">
                {binder.documents.map((doc) => (
                  <div key={doc.id} className="flex items-center justify-between gap-3 border-b border-border-subtle pb-2 last:border-0 last:pb-0">
                    <p className="min-w-0 break-words text-sm font-medium text-primary">{doc.title}</p>
                    <span className="shrink-0 text-xs capitalize text-tertiary">{doc.documentType.replace(/_/g, " ")}</span>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}
