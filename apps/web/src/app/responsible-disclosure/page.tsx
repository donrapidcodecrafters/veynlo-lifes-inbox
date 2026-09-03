import type { Metadata } from "next";
import { LegalPlaceholderPage } from "@/components/legal-placeholder-page";
import { getLegalDocument } from "@/lib/legal-documents";

export const metadata: Metadata = {
  title: "Vulnerability Disclosure Policy",
};

export default function Page() {
  const document = getLegalDocument("responsible-disclosure");
  if (!document) return null;
  return <LegalPlaceholderPage document={document} />;
}
