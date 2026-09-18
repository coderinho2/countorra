import { Buildings } from "@phosphor-icons/react/dist/ssr/Buildings";
import { UsersThree } from "@phosphor-icons/react/dist/ssr/UsersThree";
import { LockKey } from "@phosphor-icons/react/dist/ssr/LockKey";
import { ClipboardText } from "@phosphor-icons/react/dist/ssr/ClipboardText";
import { ShieldCheck } from "@phosphor-icons/react/dist/ssr/ShieldCheck";
import { HandPalm } from "@phosphor-icons/react/dist/ssr/HandPalm";
import { Calculator } from "@phosphor-icons/react/dist/ssr/Calculator";

export const TRUST_ITEMS = [
  { icon: Buildings, title: "Organization-scoped data", body: "Every record belongs to one organization. Data from one never becomes visible to another." },
  { icon: UsersThree, title: "Role-based access", body: "What a team member can view, edit, or confirm is controlled by their role in the organization." },
  { icon: ShieldCheck, title: "Database-level isolation", body: "Access control is enforced by row-level security policies at the database layer, not only in application code." },
  { icon: LockKey, title: "Private document storage", body: "Uploaded documents are stored per organization and are never publicly reachable." },
  { icon: ClipboardText, title: "Auditable actions", body: "Financial changes leave an append-only record of what happened and when." },
  { icon: HandPalm, title: "Confirmation before write or delete", body: "The AI assistant can read and analyze freely. Any change to your records waits for your approval first." },
  { icon: Calculator, title: "Deterministic calculations", body: "Totals, balances, and tax figures come from a pure calculation engine — the AI never invents a number." },
];

/**
 * Trust / security section (product spec). States only what's actually
 * enforced in the schema/RLS layer — no claimed certifications, no
 * implementation detail exposed beyond what's already true in the docs.
 */
export function TrustSection({ compact = false }: { compact?: boolean } = {}) {
  const items = compact ? TRUST_ITEMS.slice(0, 4) : TRUST_ITEMS;
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div key={item.title} className="flex gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-sm border border-border-subtle text-text-secondary">
              <Icon size={18} weight="regular" />
            </span>
            <div>
              <h4 className="text-[15px] font-medium text-text-primary">{item.title}</h4>
              <p className="mt-0.5 text-[13px] text-text-secondary">{item.body}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
