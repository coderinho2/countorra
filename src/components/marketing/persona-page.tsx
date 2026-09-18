import type { ReactNode } from "react";
import { MarketingShell } from "./marketing-shell";
import { Reveal } from "./reveal";
import { CtaSection } from "./cta-section";
import { PrimaryCta } from "./primary-cta";
import { cn } from "@/lib/utils";
import type { Segment } from "./segments-data";

/**
 * Shared scaffold for the three /solutions/[persona] pages.
 *
 * The three pages share a design language, not a layout. Each supplies its
 * own emphasis — the question that persona actually opens the product with —
 * and its own visual, and `layout` decides whether that visual leads the
 * section or sits beside the capability list. A freelancer's page is about
 * getting paid; a business's is about operating; a personal one is about
 * where it went. Rendering all three as the same page with three different
 * paragraphs is exactly what §20 of the brief rules out.
 */
export function PersonaPage({
  segment,
  visual,
  emphasis,
  layout = "visual-lead",
}: {
  segment: Segment;
  visual: ReactNode;
  /** The one question this persona opens the product with. */
  emphasis: { label: string; title: string; body: string };
  /** "visual-lead" gives the visual the full column width under its own
   *  heading; "split" sets it beside the capability list. */
  layout?: "visual-lead" | "split";
}) {
  return (
    <MarketingShell>
      <section className="mx-auto max-w-[1200px] px-6 pt-16 pb-16 lg:px-10 lg:pt-24">
        <Reveal>
          <p className="font-numeric text-[11px] tracking-[0.14em] text-text-tertiary uppercase">Solutions / {segment.label}</p>
          <h1 className="font-serif font-normal tracking-[0] mt-3 max-w-[22ch] text-[40px] leading-[46px] text-ink sm:text-[48px] sm:leading-[56px]">
            {segment.headline}
          </h1>
          <p className="mt-5 max-w-[56ch] text-[17px] leading-[26px] text-text-secondary">{segment.body}</p>
          <div className="mt-8">
            <PrimaryCta />
          </div>
        </Reveal>
      </section>

      {/* The emphasis band — what this persona is here for, stated once, as
          an editorial line rather than as another feature list. */}
      <section className="border-t border-border-subtle bg-surface-sunken/40">
        <div className="mx-auto max-w-[1200px] px-6 py-16 lg:px-10 lg:py-20">
          <Reveal>
            <p className="font-numeric flex items-center gap-3 text-[10px] tracking-[0.14em] text-text-tertiary uppercase">
              <span className="tabular-nums">01</span>
              <span aria-hidden="true" className="h-px w-6 bg-border" />
              {emphasis.label}
            </p>
            <h2 className="font-serif font-normal tracking-[0] mt-3 max-w-[24ch] text-[30px] leading-[38px] text-ink sm:text-[34px] sm:leading-[42px]">{emphasis.title}</h2>
            <p className="mt-4 max-w-[60ch] text-[15px] leading-[24px] text-text-secondary">{emphasis.body}</p>
          </Reveal>

          <Reveal delayMs={80} className="mt-10">
            {visual}
          </Reveal>
        </div>
      </section>

      <section className="border-t border-border-subtle">
        <div className="mx-auto max-w-[1200px] px-6 py-14 lg:px-10 lg:py-16">
          <Reveal>
            <p className="font-numeric flex items-center gap-3 border-b border-border pb-2.5 text-[10px] tracking-[0.14em] text-text-tertiary uppercase">
              <span className="tabular-nums">02</span>
              <span aria-hidden="true" className="h-px w-6 bg-border" />
              What it covers
            </p>
            {/* A ruled list, not a stack of bordered pills. Four identical
                outlined boxes read as four buttons; four ruled lines read as
                a list, which is what this is. */}
            <ul className={cn("mt-1 grid grid-cols-1", layout === "split" ? "sm:grid-cols-2 sm:gap-x-12" : "sm:grid-cols-2 lg:grid-cols-4 lg:gap-x-10")}>
              {segment.capabilities.map((capability) => (
                <li key={capability} className="border-b border-border-subtle py-3 text-[15px] text-text-primary last:border-b lg:last:border-b">
                  {capability}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      <section className="border-t border-border-subtle">
        <div className="mx-auto max-w-[1200px] px-6 py-16 lg:px-10">
          <Reveal>
            <CtaSection />
          </Reveal>
        </div>
      </section>
    </MarketingShell>
  );
}
