import type { ReactNode } from "react";
import { WarningCircle } from "@phosphor-icons/react/dist/ssr/WarningCircle";
import { Label } from "@/components/ui/label";

/** Shared auth-form field: label (+ optional trailing action, e.g. "Forgot
 *  password?") and an inline error per DESIGN.md §9 — negative-colored
 *  helper text with a leading icon, associated to the field via
 *  `aria-describedby` (DESIGN.md §24: errors must be announced, not just
 *  colored). */
export function FormField({
  id,
  label,
  labelAction,
  error,
  children,
}: {
  id: string;
  label: string;
  labelAction?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {labelAction}
      </div>
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="flex items-center gap-1.5 text-[13px] text-negative">
          <WarningCircle size={13} weight="bold" className="shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
