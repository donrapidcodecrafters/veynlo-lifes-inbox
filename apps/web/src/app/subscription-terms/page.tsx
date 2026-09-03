import type { Metadata } from "next";
import { LegalPlaceholderPage } from "@/components/legal-placeholder-page";
import { getLegalDocument } from "@/lib/legal-documents";

export const metadata: Metadata = {
  title: "Subscription & Auto-Renewal Terms",
};

export default function Page() {
  const document = getLegalDocument("subscription-terms");
  if (!document) return null;
  return <LegalPlaceholderPage document={document} />;
}
