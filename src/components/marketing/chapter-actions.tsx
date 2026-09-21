import { UploadSimple } from "@phosphor-icons/react/dist/ssr/UploadSimple";
import { FileMagnifyingGlass } from "@phosphor-icons/react/dist/ssr/FileMagnifyingGlass";
import { CheckCircle } from "@phosphor-icons/react/dist/ssr/CheckCircle";
import { ArrowsLeftRight } from "@phosphor-icons/react/dist/ssr/ArrowsLeftRight";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr/ArrowRight";
import { Tag } from "@phosphor-icons/react/dist/ssr/Tag";
import { Receipt } from "@phosphor-icons/react/dist/ssr/Receipt";
import { ChartBar } from "@phosphor-icons/react/dist/ssr/ChartBar";
import { Badge } from "@/components/ui/badge";

const WORKFLOW = [
  { icon: UploadSimple, label: "Document" },
  { icon: FileMagnifyingGlass, label: "Extraction" },
  { icon: CheckCircle, label: "Verification" },
  { icon: ArrowsLeftRight, label: "Transaction" },
];

const ACTIONS = [
  { icon: Tag, label: "Categorize a transaction", mode: "confirm" as const },
  { icon: Receipt, label: "Record an expense", mode: "confirm" as const },
  { icon: ChartBar, label: "Prepare a report", mode: "auto" as const },
];

/**
 * Chapter 04 visual — "Act". The workflow strip mirrors the real
 * document-confirmation gate (document_extracted_data.is_confirmed);
 * the action list mirrors the AI safety gate (src/domain/ai/safety.ts):
 * read/analyze/calculate actions run immediately, write/delete actions
 * always wait for human confirmation. The badges below are not
 * decorative, they reflect that real distinction.
 */
export function ChapterActions() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center rounded-md border border-border-subtle bg-surface p-4">
        {WORKFLOW.map((step, i) => {
          const Icon = step.icon;
          return (
            <div key={step.label} className="flex flex-1 items-center">
              <div className="flex flex-1 flex-col items-center gap-2 text-center">
                <span className="flex size-9 items-center justify-center rounded-sm border border-border-subtle text-text-primary">
                  <Icon size={16} weight="regular" />
                </span>
                <span className="text-[12px] text-text-secondary">{step.label}</span>
              </div>
              {i < WORKFLOW.length - 1 && <ArrowRight size={13} className="mb-5 shrink-0 text-border-strong" aria-hidden="true" />}
            </div>
          );
        })}
      </div>

      <div className="rounded-md border border-border-subtle bg-surface p-2">
        {ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <div key={action.label} className="flex items-center justify-between gap-3 border-b max-sm:flex-wrap max-sm:gap-y-2 border-border-subtle px-3 py-3 last:border-0">
              <div className="flex items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-border-subtle text-text-primary">
                  <Icon size={15} weight="regular" />
                </span>
                <span className="text-[14px] text-text-primary">{action.label}</span>
              </div>
              <Badge variant={action.mode === "confirm" ? "warning" : "neutral"} className="max-sm:ml-11">
                {action.mode === "confirm" ? "Needs your confirmation" : "Runs instantly"}
              </Badge>
            </div>
          );
        })}
      </div>
    </div>
  );
}
