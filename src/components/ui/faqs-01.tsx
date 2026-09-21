"use client";

import { useState, useSyncExternalStore } from "react";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr/ArrowRight";
import { ChatCircleText } from "@phosphor-icons/react/dist/ssr/ChatCircleText";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * FAQ section: heading, a single-open accordion, and a contact card.
 *
 * Adapted from the `faqs-01` block to DESIGN.md: Phosphor instead of lucide
 * (§20), no sparkle badge (§14), a mono overline instead of a pill, hairline
 * cards instead of a dashed, fully rounded panel (§21, §26), and the
 * product's own Button. The questions come in as props, so the content lives
 * with the page that asks them.
 *
 * Deep links: each item is also an anchor (`#faq-<id>`). Arriving at one —
 * from the Help Centre search or a shared link — opens that answer.
 */

export interface FaqItem {
  id: string;
  question: string;
  answer: string[];
  points?: string[];
}

export interface Faqs01Props {
  items: FaqItem[];
  /** The item open on first render, as `faq-<id>`. */
  defaultValue?: string;
  supportEmail: string;
  title?: string;
  className?: string;
}

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function useLocationHash(): string {
  return useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash.slice(1),
    () => "",
  );
}

export default function Faqs01({ items, defaultValue, supportEmail, title = "Frequently asked questions", className }: Faqs01Props) {
  const hash = useLocationHash();
  const hashValue = items.some((item) => `faq-${item.id}` === hash) ? hash : null;
  // The person's own open/close choice wins until they follow a new link to
  // a different answer.
  const [choice, setChoice] = useState<{ hash: string; value: string } | null>(null);
  const value = choice && (choice.hash === hash || hashValue === null) ? choice.value : (hashValue ?? defaultValue ?? "");
  const mailto = `mailto:${supportEmail}`;

  return (
    <div className={cn("mx-auto w-full max-w-3xl", className)}>
      <div className="flex flex-col gap-3">
        <p className="font-numeric text-[11px] tracking-[0.14em] text-text-tertiary uppercase">FAQ</p>
        <h2 className="text-[28px] leading-[34px] font-semibold tracking-[-0.015em] text-ink sm:text-[32px] sm:leading-[38px]">{title}</h2>
        <p className="max-w-[60ch] text-[15px] leading-[1.6] text-text-secondary">
          Short answers to what people ask most. Can&apos;t find yours? Write to{" "}
          <a href={mailto} className="font-medium text-accent hover:underline">
            {supportEmail}
          </a>
          .
        </p>
      </div>

      <Accordion type="single" collapsible value={value} onValueChange={(next) => setChoice({ hash, value: next })} className="mt-8 border-t border-border-subtle">
        {items.map((item) => (
          <AccordionItem key={item.id} value={`faq-${item.id}`} id={`faq-${item.id}`} className="scroll-mt-24">
            <AccordionTrigger>{item.question}</AccordionTrigger>
            <AccordionContent>
              <div className="flex max-w-[64ch] flex-col gap-3">
                {item.answer.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
                {item.points && (
                  <ul className="flex flex-col gap-2">
                    {item.points.map((point) => (
                      <li key={point} className="relative pl-4 before:absolute before:top-[0.7em] before:left-0 before:h-px before:w-2 before:bg-border-strong">
                        {point}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>

      <div className="mt-10 flex flex-col items-start justify-between gap-4 rounded-md border border-border-subtle bg-surface p-5 sm:flex-row sm:items-center">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-sm border border-border-subtle text-text-primary">
            <ChatCircleText size={18} aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-0.5">
            <p className="text-[15px] font-medium text-ink">Still have a question?</p>
            <p className="text-[13px] leading-[1.5] text-text-secondary">
              Contact the Countorra support team at{" "}
              <a href={mailto} className="font-medium break-all text-accent hover:underline">
                {supportEmail}
              </a>
            </p>
          </div>
        </div>
        <Button asChild size="sm" variant="secondary" className="shrink-0 max-sm:w-full">
          <a href={mailto}>
            Email support
            <ArrowRight size={14} aria-hidden="true" />
          </a>
        </Button>
      </div>
    </div>
  );
}
