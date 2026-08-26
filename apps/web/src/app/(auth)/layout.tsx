export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 text-center">
          <span className="text-xl font-semibold tracking-tight text-primary">Veynlo</span>
          <p className="mt-1 text-sm text-tertiary">Your life, remembered.</p>
        </div>
        {children}
      </div>
    </div>
  );
}
