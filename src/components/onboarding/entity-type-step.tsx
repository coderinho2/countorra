"use client";

import { useRef } from "react";
import { Briefcase } from "@phosphor-icons/react/dist/ssr/Briefcase";
import { Buildings } from "@phosphor-icons/react/dist/ssr/Buildings";
import { Check } from "@phosphor-icons/react/dist/ssr/Check";
import { User } from "@phosphor-icons/react/dist/ssr/User";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UserEntityType } from "@/domain/organizations/types";

const ENTITY_OPTIONS: Array<{ value: UserEntityType; title: string; description: string; icon: typeof User }> = [
  { value: "personal", title: "Personal", description: "Manage my personal money.", icon: User },
  { value: "freelancer", title: "Freelancer", description: "Manage income, expenses and taxes from my independent work.", icon: Briefcase },
  { value: "business", title: "Business", description: "Manage my company's finances.", icon: Buildings },
];

/**
 * Product spec §6 entity-type picker, built as a real ARIA radiogroup: one
 * value is selected at a time, arrow keys move focus AND selection (native
 * radio behavior), and the choice stays visible (accent ring + check) so a
 * user can change their mind before confirming — rather than navigating
 * away the instant a card is clicked.
 */
export function EntityTypeStep({
  value,
  onSelect,
  onContinue,
}: {
  value: UserEntityType | null;
  onSelect: (v: UserEntityType) => void;
  onContinue: () => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const moveFocus = (fromIndex: number, delta: number) => {
    const nextIndex = (fromIndex + delta + ENTITY_OPTIONS.length) % ENTITY_OPTIONS.length;
    onSelect(ENTITY_OPTIONS[nextIndex].value);
    refs.current[nextIndex]?.focus();
  };

  return (
    <div className="flex flex-col gap-6">
      <div role="radiogroup" aria-label="What are you using Countorra for?" className="flex flex-col gap-2.5">
        {ENTITY_OPTIONS.map((option, index) => {
          const Icon = option.icon;
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (value === null && index === 0) ? 0 : -1}
              onClick={() => onSelect(option.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                  e.preventDefault();
                  moveFocus(index, 1);
                } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                  e.preventDefault();
                  moveFocus(index, -1);
                }
              }}
              className={cn(
                "group relative flex items-start gap-4 rounded-md border p-4 text-left transition-colors duration-100 ease-out",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20 focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
                selected ? "border-accent bg-accent-subtle" : "border-border-subtle bg-surface hover:border-border",
              )}
            >
              <span
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-sm border transition-colors duration-100 ease-out",
                  selected ? "border-accent/30 bg-surface text-accent" : "border-border-subtle bg-surface-sunken text-text-secondary group-hover:border-border",
                )}
              >
                <Icon size={20} weight={selected ? "fill" : "regular"} />
              </span>
              <span className="flex flex-1 flex-col gap-0.5 pt-0.5">
                <span className={cn("text-[15px] font-medium", selected ? "text-accent" : "text-text-primary")}>{option.title}</span>
                <span className="text-[13px] text-text-secondary">{option.description}</span>
              </span>
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full transition-colors duration-100 ease-out",
                  selected ? "bg-accent text-accent-contrast" : "bg-transparent text-transparent",
                )}
                aria-hidden="true"
              >
                <Check size={12} weight="bold" />
              </span>
            </button>
          );
        })}
      </div>

      <Button type="button" size="lg" disabled={value === null} onClick={onContinue} className="w-full justify-center">
        Continue
      </Button>
    </div>
  );
}
