import type { Metadata } from "next";
import { LegalPlaceholderPage } from "@/components/legal-placeholder-page";
import { getLegalDocument } from "@/lib/legal-documents";

export const metadata: Metadata = {
  title: "Family & Child Data Disclosures",
};

export default function Page() {
  const document = getLegalDocument("family-child-data");
  if (!document) return null;
  return <LegalPlaceholderPage document={document} />;
}
