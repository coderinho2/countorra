import Link from "next/link";
import { MapPin } from "@phosphor-icons/react/dist/ssr/MapPin";
import type { StateContext } from "@/domain/tax/supported-states";

/**
 * Shown across the app while the workspace has no supported state — a
 * workspace created before onboarding asked, or one holding a state Countorra
 * does not support. Nothing is defaulted in the meantime: federal figures
 * still work, and no state tax is calculated until the person says where they
 * live. The fix is one field in Settings, so the notice links straight to it.
 */
export function StateNotice({ orgId, context }: { orgId: string; context: Exclude<StateContext, { status: "SET" }> }) {
  const message =
    context.status === "NOT_SET"
      ? "Tell Countorra which state you live in to get state tax calculations and state-specific guidance."
      : `${context.code} isn't a state Countorra supports yet. Choose California, Texas, Arizona, Florida or New York to get state tax calculations.`;

  return (
    <div role="status" className="border-border-subtle bg-accent-subtle flex shrink-0 items-center gap-3 border-b px-4 py-2 text-[13px] lg:px-6">
      <MapPin size={15} className="text-accent shrink-0" aria-hidden="true" />
      <span className="text-text-primary min-w-0 flex-1">{message}</span>
      <Link
        href={`/app/${orgId}/settings#organization`}
        className="text-accent hover:text-accent-hover focus-visible:outline-accent shrink-0 font-medium transition-colors duration-[var(--duration-fast)] ease-out focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        Set your state
      </Link>
    </div>
  );
}
