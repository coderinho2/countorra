import { TrendUp } from "@phosphor-icons/react/dist/ssr/TrendUp";
import { ArrowsLeftRight } from "@phosphor-icons/react/dist/ssr/ArrowsLeftRight";
import { Tag } from "@phosphor-icons/react/dist/ssr/Tag";
import { ChartLine } from "@phosphor-icons/react/dist/ssr/ChartLine";
import { Compass } from "@phosphor-icons/react/dist/ssr/Compass";
import { CheckCircle } from "@phosphor-icons/react/dist/ssr/CheckCircle";
import { ArrowDown } from "@phosphor-icons/react/dist/ssr/ArrowDown";

const NODES = [
  { icon: TrendUp, label: "Income", body: "Every deposit, payment, and payout." },
  { icon: ArrowsLeftRight, label: "Transactions", body: "Every charge and transfer, as it happens." },
  { icon: Tag, label: "Categories", body: "Grouped by what they actually are." },
  { icon: ChartLine, label: "Cash flow", body: "What's coming in against what's going out." },
  { icon: Compass, label: "Forecast", body: "Where your balance is headed next." },
  { icon: CheckCircle, label: "Decisions", body: "What it means for your next move." },
];

/**
 * Signature financial-intelligence visual (product spec). Raw financial
 * activity becoming a decision, shown as one connected chain rather than
 * an abstract "AI" graphic — no neural network, no glow, no gradient.
 * Mono step numbers, hairline connectors, flat icons only.
 */
export function FlowDiagram() {
  return (
    <div className="flex flex-col lg:flex-row lg:items-stretch">
      {NODES.map((node, i) => {
        const Icon = node.icon;
        const isLast = i === NODES.length - 1;
        return (
          <div key={node.label} className="flex min-w-0 flex-1 flex-col items-stretch lg:flex-row lg:items-center">
            <div className="flex flex-1 flex-col gap-3 rounded-md border border-border-subtle bg-surface p-5">
              <div className="flex items-center justify-between">
                <span className="flex size-8 items-center justify-center rounded-sm border border-border-subtle text-text-primary">
                  <Icon size={16} weight="regular" />
                </span>
                <span className="font-numeric text-[11px] text-text-tertiary">{String(i + 1).padStart(2, "0")}</span>
              </div>
              <div>
                <h4 className="text-[14px] font-semibold text-ink">{node.label}</h4>
                <p className="mt-0.5 text-[12px] text-text-secondary">{node.body}</p>
              </div>
            </div>

            {!isLast && (
              <div className="flex shrink-0 items-center justify-center py-1 lg:w-6 lg:py-0" aria-hidden="true">
                <ArrowDown size={14} className="text-border-strong lg:-rotate-90" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
