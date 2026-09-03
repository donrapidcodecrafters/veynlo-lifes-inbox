import type { Metadata } from "next";
import { LegalPlaceholderPage } from "@/components/legal-placeholder-page";
import { getLegalDocument } from "@/lib/legal-documents";

export const metadata: Metadata = {
  title: "Cookie & Web Tracking Policy",
};

export default function Page() {
  const document = getLegalDocument("cookie-policy");
  if (!document) return null;
  return <LegalPlaceholderPage document={document} />;
}
