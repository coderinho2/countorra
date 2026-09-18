import type { ToolExecutionResult } from "./service";

/**
 * Product spec §7 ("Based on 42 transactions · Aug 1–Aug 31") — a subtle,
 * generic transparency line derived from the tool calls a turn actually
 * made, not a per-tool template. Every one of the ~35 tools would need its
 * own caption otherwise; instead this looks for the two shapes that are
 * actually meaningful to surface (a transaction list, or a date-scoped
 * calculation) and falls back to naming the data sources used.
 */
export interface SourceSummary {
  text: string;
  toolNames: string[];
}

function formatDateRange(from: string, to: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const f = fmt.format(new Date(`${from}T00:00:00Z`));
  const t = fmt.format(new Date(`${to}T00:00:00Z`));
  return f === t ? f : `${f}–${t}`;
}

export function summarizeSources(executedTools: ToolExecutionResult[]): SourceSummary | null {
  if (executedTools.length === 0) return null;
  const toolNames = [...new Set(executedTools.map((t) => t.toolName))];

  for (const t of executedTools) {
    const output = t.output as { transactions?: unknown[]; total?: number } | undefined;
    if (Array.isArray(output?.transactions)) {
      const count = output.total ?? output.transactions.length;
      const input = t.toolInput as { from?: string; to?: string } | undefined;
      const range = input?.from && input?.to ? ` · ${formatDateRange(input.from, input.to)}` : "";
      return { text: `Based on ${count} transaction${count === 1 ? "" : "s"}${range}`, toolNames };
    }
  }

  for (const t of executedTools) {
    const input = t.toolInput as { from?: string; to?: string } | undefined;
    if (input?.from && input?.to) {
      return { text: `Based on your data from ${formatDateRange(input.from, input.to)}`, toolNames };
    }
  }

  return {
    text: `Based on ${toolNames.length} data ${toolNames.length === 1 ? "source" : "sources"}: ${toolNames.join(", ")}`,
    toolNames,
  };
}
