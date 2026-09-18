"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useTransition } from "react";
import { Segmented } from "@/components/ui/segmented";
import { presetRange } from "@/lib/date-range";

const PRESETS = [
  { value: "this-month", label: "This month" },
  { value: "last-month", label: "Last month" },
  { value: "last-90-days", label: "90 days" },
  { value: "this-year", label: "This year" },
];

/**
 * The reporting period.
 *
 * This was four buttons, one of which was filled in the accent colour when
 * active — so the current period looked like a primary call to action, which
 * is the loudest thing a button can look like and the wrong signal for "you
 * are here". It is now a segmented control per DESIGN.md §15/§26: one track,
 * one indicator that slides, and no button pretending to be an action.
 *
 * Reflected in the URL, like every other filter in the product, so a report
 * view is shareable and survives a refresh.
 */
export function DateRangePicker({ activePreset }: { activePreset: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const applyPreset = (preset: string) => {
    const { from, to } = presetRange(preset);
    const params = new URLSearchParams(searchParams.toString());
    params.set("preset", preset);
    params.set("from", from);
    params.set("to", to);
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  };

  return <Segmented options={PRESETS} value={activePreset} onValueChange={applyPreset} ariaLabel="Reporting period" size="sm" />;
}
