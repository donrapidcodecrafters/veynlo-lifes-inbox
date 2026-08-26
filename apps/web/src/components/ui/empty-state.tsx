import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

/**
 * Empty states teach how value gets created here — never a bare
 * "No records." (product requirement).
 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-default px-6 py-12 text-center">
      {icon && <div className="text-tertiary">{icon}</div>}
      <div className="space-y-1">
        <h3 className="text-[0.9375rem] font-medium text-primary">{title}</h3>
        <p className="mx-auto max-w-sm text-sm text-tertiary">{description}</p>
      </div>
      {action}
    </div>
  );
}
