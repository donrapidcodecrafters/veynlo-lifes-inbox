import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 text-center">
          <span className="text-xl font-semibold tracking-tight text-primary">Veynlo</span>
          <p className="mt-1 text-sm text-tertiary">Your life, remembered.</p>
        </div>
        {children}
      </div>
      {/* §51.3 placeholder legal documents — see apps/web/src/lib/legal-documents.ts. A real app would
          link its footer to these; none of them have real, counsel-reviewed content yet, and each page
          says so honestly. */}
      <footer className="mt-10 flex max-w-[380px] flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-tertiary">
        <Link href="/terms" className="hover:underline">
          Terms
        </Link>
        <Link href="/privacy-policy" className="hover:underline">
          Privacy
        </Link>
        <Link href="/cookie-policy" className="hover:underline">
          Cookies
        </Link>
        <Link href="/accessibility" className="hover:underline">
          Accessibility
        </Link>
      </footer>
    </div>
  );
}
