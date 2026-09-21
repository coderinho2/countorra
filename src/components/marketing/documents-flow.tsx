import { UploadSimple } from "@phosphor-icons/react/dist/ssr/UploadSimple";
import { Gear } from "@phosphor-icons/react/dist/ssr/Gear";
import { FileMagnifyingGlass } from "@phosphor-icons/react/dist/ssr/FileMagnifyingGlass";
import { Eye } from "@phosphor-icons/react/dist/ssr/Eye";
import { CheckCircle } from "@phosphor-icons/react/dist/ssr/CheckCircle";
import { Database } from "@phosphor-icons/react/dist/ssr/Database";
import { Badge } from "@/components/ui/badge";

const STEPS = [
  { icon: UploadSimple, label: "Upload" },
  { icon: Gear, label: "Process" },
  { icon: FileMagnifyingGlass, label: "Extract" },
  { icon: Eye, label: "Review" },
  { icon: CheckCircle, label: "Confirm" },
  { icon: Database, label: "Use" },
];

const FIELDS = [
  { label: "Employer", value: "Northwind Co.", confirmed: true },
  { label: "Wages (box 1)", value: "$86,400.00", confirmed: true },
  { label: "Federal withholding (box 2)", value: "$9,120.00", confirmed: false },
];

/**
 * Documents → intelligence (product spec §12). Upload and private per-org
 * storage are real (supabase/migrations/0018_document_storage.sql).
 * Automated field extraction runs behind a pluggable DocumentExtractor
 * interface (src/domain/documents/document-processor.ts) and is not
 * claimed as fully live — the "needs confirmation" state below mirrors
 * the real `document_extracted_data.is_confirmed` gate: nothing an
 * extractor reads is applied to a financial record until confirmed.
 */
export function DocumentsFlow() {
  return (
    <div>
      <ol className="flex items-start justify-between gap-1">
        {STEPS.map((step, i) => {
          const Icon = step.icon;
          return (
            <li key={step.label} className="flex flex-1 flex-col items-center gap-2 text-center">
              <div className="flex w-full items-center">
                <span className={`h-px flex-1 ${i === 0 ? "bg-transparent" : "bg-border-subtle"}`} aria-hidden="true" />
                <span className="flex size-9 shrink-0 items-center justify-center rounded-sm border border-border-subtle bg-surface text-text-primary">
                  <Icon size={16} weight="regular" />
                </span>
                <span className={`h-px flex-1 ${i === STEPS.length - 1 ? "bg-transparent" : "bg-border-subtle"}`} aria-hidden="true" />
              </div>
              <span className="text-[12px] text-text-secondary">{step.label}</span>
            </li>
          );
        })}
      </ol>

      <div className="mx-auto mt-8 max-w-md rounded-md border border-border-subtle bg-surface p-5">
        <div className="flex items-baseline justify-between border-b border-border-subtle pb-3">
          <div>
            <p className="text-[14px] font-semibold text-ink">w2-2026-northwind.pdf</p>
            <p className="text-[12px] text-text-tertiary">Uploaded to Documents</p>
          </div>
          <Badge variant="warning">Needs review</Badge>
        </div>
        <dl className="mt-3 flex flex-col gap-2.5">
          {FIELDS.map((field) => (
            <div key={field.label} className="flex items-center justify-between text-[13px]">
              <dt className="text-text-secondary">{field.label}</dt>
              <dd className="flex items-center gap-2">
                <span className="font-numeric text-text-primary">{field.value}</span>
                {field.confirmed ? (
                  <Badge variant="positive">Confirmed</Badge>
                ) : (
                  <Badge variant="warning">Needs confirmation</Badge>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="mt-8 max-w-[65ch] border-t border-border-subtle pt-6 text-[13px] text-text-secondary">
        Upload and private, per-organization storage are available today. Automated document
        understanding runs through a pluggable extraction provider and expands over time —
        extracted fields always wait for your confirmation before they touch a financial record,
        exactly as shown above.
      </p>
    </div>
  );
}
