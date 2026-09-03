import type { Metadata } from "next";
import { LegalPlaceholderPage } from "@/components/legal-placeholder-page";
import { getLegalDocument } from "@/lib/legal-documents";

export const metadata: Metadata = {
  title: "Security Overview",
};

export default function Page() {
  const document = getLegalDocument("security-overview");
  if (!document) return null;
  return <LegalPlaceholderPage document={document} />;
}
