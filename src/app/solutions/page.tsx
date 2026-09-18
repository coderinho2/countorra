import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr/ArrowRight";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Reveal } from "@/components/marketing/reveal";
import { EntitySegments } from "@/components/marketing/entity-segments";
import { SEGMENTS } from "@/components/marketing/segments-data";

export const metadata: Metadata = {
  title: "Solutions — Countorra",
  description: "How Countorra adapts to personal finances, freelance work, and business.",
};

export default function SolutionsPage() {
  return (
    <MarketingShell>
      <section className="mx-auto max-w-[1200px] px-6 pt-16 pb-14 lg:px-10 lg:pt-24">
        <Reveal>
          <h1 className="font-serif font-normal tracking-[0] max-w-[22ch] text-[40px] leading-[46px] text-ink sm:text-[48px] sm:leading-[56px]">
            One system, three ways of working with money.
          </h1>
          <p className="mt-5 max-w-[56ch] text-[17px] leading-[26px] text-text-secondary">
            Countorra does not ask you to pick a product edition — it adapts its focus to how
            you actually manage money.
          </p>
        </Reveal>
      </section>

      <section className="border-t border-border-subtle">
        <div className="mx-auto max-w-[1200px] px-6 py-14 lg:px-10 lg:py-16">
          <Reveal>
            <EntitySegments />
          </Reveal>
        </div>
      </section>

      <section className="border-t border-border-subtle">
        <div className="mx-auto max-w-[1200px] px-6 py-14 lg:px-10 lg:py-16">
          <Reveal>
            <div className="flex flex-col divide-y divide-border-subtle border-y border-border-subtle">
              {SEGMENTS.map((segment) => (
                <Link
                  key={segment.key}
                  href={`/solutions/${segment.key}`}
                  className="group flex items-center justify-between gap-4 py-5 transition-colors duration-100 ease-out hover:bg-surface-sunken"
                >
                  <div>
                    <p className="text-[16px] font-medium text-ink">{segment.label}</p>
                    <p className="mt-0.5 text-[13px] text-text-secondary">{segment.headline}</p>
                  </div>
                  <ArrowRight size={16} className="shrink-0 text-text-tertiary transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
                </Link>
              ))}
            </div>
          </Reveal>
        </div>
      </section>
    </MarketingShell>
  );
}
