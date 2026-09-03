import Link from "next/link";
import { Card, CardBody } from "@/components/ui/card";
import { LEGAL_CONTACT_EMAIL, LEGAL_DOCUMENTS, type LegalDocument } from "@/lib/legal-documents";

/**
 * Shared shell for every §51.3 "documents/policies required before public launch" placeholder route
 * (/terms, /privacy-policy, /security-overview, etc.). Deliberately does NOT contain real legal text —
 * writing binding terms, liability clauses, data-retention promises, or a governing-law statement without
 * counsel review would be worse than not having the page at all. This exists so the real app has an honest
 * page to link to instead of a 404, and so a visitor (or an app-store reviewer) gets a truthful answer:
 * this document is planned, not yet published, here's how to ask a question in the meantime.
 *
 * See SECURITY.md's pre-submission checklist — publishing the real, counsel-reviewed version of every one
 * of these remains the actual open item this page does not close.
 */
export function LegalPlaceholderPage({ document }: { document: LegalDocument }) {
  const otherDocuments = LEGAL_DOCUMENTS.filter((doc) => doc.slug !== document.slug);

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 py-12">
      <Link href="/" className="text-sm font-medium text-brand hover:underline">
        &larr; Veynlo
      </Link>
      <h1 className="mt-6 text-2xl font-semibold text-primary">{document.title}</h1>

      <Card className="mt-6">
        <CardBody className="space-y-4">
          <p className="text-sm font-medium uppercase tracking-wide text-tertiary">Not yet published</p>
          <p className="text-secondary">
            This page is a placeholder for Veynlo&apos;s {document.title}, which will cover {document.summary}.
            The real document has not been written or reviewed yet, and nothing on this page is a legally
            binding {document.title.toLowerCase()}.
          </p>
          <p className="text-secondary">
            Veynlo is still in private pre-launch testing. A real, counsel-reviewed version of this document
            will be published here before Veynlo is available to the public.
          </p>
          <p className="text-secondary">
            Questions in the meantime? Contact{" "}
            <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} className="font-medium text-brand hover:underline">
              {LEGAL_CONTACT_EMAIL}
            </a>
            .
          </p>
        </CardBody>
      </Card>

      <div className="mt-8">
        <p className="text-sm font-medium text-tertiary">Other documents (also placeholders for now)</p>
        <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {otherDocuments.map((doc) => (
            <li key={doc.slug}>
              <Link href={`/${doc.slug}`} className="text-sm text-brand hover:underline">
                {doc.title}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
