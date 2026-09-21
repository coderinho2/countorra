"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr/ArrowRight";
import { cn } from "@/lib/utils";
import { SEGMENTS } from "./segments-data";

/**
 * Who Countorra is for, as one panel — not identical pricing-style cards —
 * so typography and content carry it, per DESIGN.md §26's ban on repetitive
 * equal-card layouts. With more than one segment a segmented control switches
 * between them; at the personal-only launch there is one, so the control is
 * not rendered (a switch with a single position is a removed feature showing).
 */
export function EntitySegments() {
  const [active, setActive] = useState(0);
  const segment = SEGMENTS[active];

  return (
    <div>
      {SEGMENTS.length > 1 && (
        <div
          aria-label="Account type"
          className="inline-flex rounded-md border border-border-subtle bg-surface-sunken p-1"
        >
          {SEGMENTS.map((s, i) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={active === i}
              onClick={() => setActive(i)}
              className={cn(
                "rounded-sm px-4 py-1.5 text-[14px] font-medium transition-colors duration-100 ease-out",
                active === i
                  ? "bg-surface text-ink shadow-[var(--shadow-level-2)]"
                  : "text-text-secondary hover:text-text-primary",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <div
        className={cn(
          SEGMENTS.length > 1 && "mt-8",
          "grid grid-cols-1 gap-8 lg:grid-cols-[1fr_auto] lg:items-start",
        )}
      >
        <div className="max-w-[52ch]">
          <h3 className="text-2xl font-semibold tracking-[-0.01em] text-ink">
            {segment.headline}
          </h3>
          <p className="mt-3 text-[15px] leading-[1.6] text-text-secondary">
            {segment.body}
          </p>
        </div>

        <div className="flex flex-col gap-2 lg:min-w-[240px]">
          <ul className="flex flex-col gap-2">
            {segment.capabilities.map((capability) => (
              <li
                key={capability}
                className="rounded-sm border border-border-subtle px-3 py-2 text-[13px] text-text-secondary"
              >
                {capability}
              </li>
            ))}
          </ul>
          <Link
            href={`/solutions/${segment.key}`}
            className="flex items-center gap-1.5 px-3 py-1 text-[13px] text-accent transition-colors duration-100 ease-out hover:underline"
          >
            More for {segment.label.toLowerCase()}
            <ArrowRight size={13} />
          </Link>
        </div>
      </div>
    </div>
  );
}
