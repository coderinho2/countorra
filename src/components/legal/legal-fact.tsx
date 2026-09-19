import { LEGAL_FACTS, LEGAL_FACT_LABELS, type LegalFacts } from "@/domain/legal/facts";

/**
 * A business fact stated on a legal page — or, while it is still unknown, a
 * visible placeholder that says so. Never blank, never invented: see
 * src/domain/legal/facts.ts.
 */
export function LegalFact({ name }: { name: keyof LegalFacts }) {
  const value = LEGAL_FACTS[name];
  if (value) return <strong className="text-text-primary">{value}</strong>;
  return (
    <mark data-legal-placeholder={name} className="rounded-[3px] bg-warning-subtle px-1 font-medium text-warning">
      [{LEGAL_FACT_LABELS[name]} — to be provided before launch]
    </mark>
  );
}

/** The notice at the top of a legal page while any placeholder remains. */
export function LegalPlaceholderNotice({ file }: { file: string }) {
  const remaining = (Object.keys(LEGAL_FACTS) as (keyof LegalFacts)[]).filter((key) => LEGAL_FACTS[key] === null);
  if (remaining.length === 0) return null;
  return (
    <div className="mt-6 rounded-md border border-border-subtle bg-surface-sunken p-4">
      <p className="text-[13px] leading-[1.6] text-text-secondary">
        <strong className="text-text-primary">Not yet final.</strong> Highlighted fields ({remaining.map((key) => LEGAL_FACT_LABELS[key]).join(", ").toLowerCase()}) are business
        details that have not been provided. They are set in{" "}
        <code className="rounded-[4px] bg-surface px-1 py-0.5 font-numeric text-[12px]">src/domain/legal/facts.ts</code>, and this page ({file}) should not be treated as
        binding until they are.
      </p>
    </div>
  );
}
