import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { SectionHeader } from "@/components/marketing/section-header";
import { HeroPreview } from "@/components/marketing/hero-preview";
import { HeroTerminal } from "@/components/marketing/hero-terminal";
import { LiveSignal } from "@/components/marketing/live-signal";
import { ProductShowcase } from "@/components/marketing/product-showcase";
import { TechnologyStrip } from "@/components/marketing/technology-strip";
import { FlowDiagram } from "@/components/marketing/flow-diagram";
import { ProductStory } from "@/components/marketing/product-story";
import { EntitySegments } from "@/components/marketing/entity-segments";
import { DocumentsFlow } from "@/components/marketing/documents-flow";
import { TrustSection } from "@/components/marketing/trust-section";
import { CtaSection } from "@/components/marketing/cta-section";
import { Reveal } from "@/components/marketing/reveal";

/**
 * The homepage had no metadata of its own, so the product's most important
 * page inherited a generic title and description. `title: null` uses the root
 * default verbatim rather than applying the "%s — Countorra" template,
 * which would otherwise produce a doubled name.
 */
export const metadata: Metadata = {
  title: null,
  description:
    "One system for income, expenses, accounts and invoices — that answers real questions about them, grounded in your own records.",
  alternates: { canonical: "/" },
};

/**
 * Public landing page (product spec, DESIGN.md throughout). Logged-out
 * and unauthenticated by design — the actual product lives behind
 * middleware-protected /app/[orgId]/... routes (src/proxy.ts), untouched
 * by this file. Every figure shown below is static, illustrative preview
 * data built from the app's real UI primitives — nothing here reads from
 * or writes to the database.
 *
 * Visual rhythm (product spec §6): sparse headline → dense product
 * workspace → editorial flow statement → the five-chapter product story
 * (alternating dense UI and short editorial beats) → sparse trust
 * section → CTA.
 */
export default function Home() {
  return (
    <MarketingShell>
        {/* Hero — ruled plate, statement + live position artefact, then the
            numbered capability taskbar. See HeroTerminal for how the two
            21st.dev references were adapted rather than imported. */}
        <HeroTerminal />

        <Reveal delayMs={80} id="workspace" as="div" className="mx-auto max-w-[1200px] px-6 pt-16 pb-20 lg:px-10">
          <HeroPreview />
        </Reveal>

        {/* Live signal — one small real piece of the product, sparse */}
        <section className="px-6 pb-20 lg:px-10">
          <Reveal>
            <LiveSignal />
          </Reveal>
        </section>

        {/* Product showcase — the surfaces themselves, turned by hand */}
        <section id="showcase" className="border-t border-border-subtle bg-surface-sunken/40">
          <div className="mx-auto max-w-[1200px] px-6 py-24 lg:px-10 lg:py-32">
            <Reveal>
              <SectionHeader index={1} title="Your finances, understood.">
                An AI accountant and the workspace it works in — the ledger, the invoices, the
                reports and the tax year, all reading from the same records.
              </SectionHeader>
            </Reveal>
            <Reveal delayMs={80} className="mt-8">
              <ProductShowcase />
            </Reveal>
          </div>
        </section>

        {/* Infrastructure strip — what the product is built on, stated quietly
            and with no claim of endorsement. Unnumbered on purpose: it is
            credibility, not a chapter of the product story. */}
        <section className="border-border-subtle border-t">
          <div className="mx-auto max-w-[1200px] px-6 py-16 lg:px-10">
            <Reveal>
              <TechnologyStrip />
            </Reveal>
          </div>
        </section>

        {/* Signature flow — editorial statement + technical diagram */}
        <section className="border-t border-border-subtle bg-surface-sunken/40">
          <div className="mx-auto max-w-[1200px] px-6 py-24 lg:px-10 lg:py-32">
            <Reveal>
              <SectionHeader index={2} title="Raw activity becomes a decision.">
                Every transaction moves through the same chain — from what happened, to what it
                means, to what to do next.
              </SectionHeader>
            </Reveal>
            <Reveal delayMs={80} className="mt-10">
              <FlowDiagram />
            </Reveal>
          </div>
        </section>

        {/* Product story — five chapters, one evolving system */}
        <section className="mx-auto max-w-[1200px] px-6 lg:px-10">
          <ProductStory />
        </section>

        {/* Who it's for */}
        <section id="solutions" className="border-b border-border-subtle bg-surface-sunken/40">
          <div className="mx-auto max-w-[1200px] px-6 py-24 lg:px-10 lg:py-32">
            <Reveal>
              <SectionHeader index={3} title="Built to fit how you actually work with money.">
                The same system adapts its focus depending on whether you are managing personal
                finances, freelance income, or a business.
              </SectionHeader>
            </Reveal>
            <Reveal delayMs={80} className="mt-10">
              <EntitySegments />
            </Reveal>
          </div>
        </section>

        {/* Documents */}
        <section id="documents" className="mx-auto max-w-[1200px] px-6 py-24 lg:px-10 lg:py-32">
          <Reveal>
            <SectionHeader index={4} title="Your documents, put to work.">
              Invoices, receipts, and financial documents move from a folder to a system you can
              ask questions of.
            </SectionHeader>
          </Reveal>
          <Reveal delayMs={80} className="mt-10">
            <DocumentsFlow />
          </Reveal>
        </section>

        {/* Trust / security — sparse */}
        <section id="security" className="border-t border-border-subtle">
          <div className="mx-auto max-w-[1200px] px-6 py-24 lg:px-10 lg:py-32">
            <Reveal>
              <SectionHeader index={5} title="Built on a security-first architecture.">
                This is software for real financial data, so isolation and access control are part
                of the design, not an afterthought.
              </SectionHeader>
            </Reveal>
            <Reveal delayMs={80} className="mt-10 flex flex-col gap-6">
              <TrustSection compact />
              <Link href="/security" className="inline-flex w-fit items-center gap-1.5 text-[14px] text-accent hover:underline">
                See our full security architecture
              </Link>
            </Reveal>
          </div>
        </section>

        {/* Final CTA */}
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
