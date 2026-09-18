import { Button } from "@/components/ui/button";
import { PrimaryCta } from "./primary-cta";
import { Reveal } from "./reveal";
import { Sparkline } from "@/components/charts/sparkline";
import { cn } from "@/lib/utils";

/**
 * The homepage hero.
 *
 * Composed as one plate rather than as a headline with a widget beside it.
 * Three structural decisions carry it, each taken from a specific reading of
 * the two installed 21st.dev references:
 *
 * 1. **Bottom alignment.** hero-08's header grid is `items-end`, not
 *    `items-start` — its headline and its supporting block share a baseline
 *    at the bottom of the band. That single property is what stops a
 *    two-column hero reading as two independent objects, and it is the main
 *    thing missing from the previous version here. The headline and the
 *    statement fragment now hang from the same line.
 *
 * 2. **A ruled plate, not a lit one.** hero-1 draws a hairline grid and then
 *    buries it under a purple radial and a glowing ellipse. Both are on
 *    DESIGN.md §26's ban list. What is kept is the grid — and specifically
 *    its *non-square* cells (hero-1 uses 96×80), which read as ledger and
 *    graph stock rather than as a design-tool artboard. The mask fades it
 *    downward so the composition sits on paper that runs out, not on a
 *    rectangle that stops.
 *
 * 3. **No card around the artefact.** DESIGN.md §10 reserves boxes for
 *    genuinely discrete objects and §21 keeps shadows for floating layers.
 *    A bordered, shadowed card made the position float above the plate as a
 *    separate widget. Rules instead of a box let it sit *in* the composition,
 *    sharing the grid's own hairlines — a statement fragment torn from the
 *    product rather than a screenshot of it.
 *
 * The headline is set in the editorial Display serif (DESIGN.md §4). Its
 * tracking is zero, not negative: the tightening curve in §4 was grounded in
 * three sans references, and a didone's thin strokes collapse under it.
 *
 * The corner marks are the fourth device and are original here: a financial
 * document plate is annotated at its edges, and `FIG. 01` doing that work
 * is what makes the whole band read as an instrument rather than as a hero
 * section.
 *
 * Every figure is the same illustrative preview data the rest of the
 * marketing page uses. It is not read from the database and is labelled as
 * illustrative on the plate itself.
 */
const PREVIEW_NET = [318_940, 322_100, 319_880, 336_400, 341_220, 421_846];

/** The signature element: a strip of the ledger itself. Merchant names match
 *  the preview data used elsewhere on the page so the site tells one story. */
const LEDGER = [
  { date: "09.04", label: "Northwind", amount: "−$784.00", tone: "negative" as const },
  { date: "09.05", label: "Nordholt Studio", amount: "+$4,800.00", tone: "positive" as const },
  { date: "09.05", label: "Cascade Hosting", amount: "−$89.00", tone: "negative" as const },
  { date: "09.06", label: "Meridian Legal", amount: "−$320.00", tone: "negative" as const },
];

const CAPABILITIES = [
  { index: "01", title: "Understand", body: "Income, expenses, accounts and invoices as one system." },
  { index: "02", title: "Track", body: "Every movement categorised and searchable." },
  { index: "03", title: "Analyse", body: "The comparison and the reason, not just a number." },
  { index: "04", title: "Ask", body: "Real questions answered from your own records." },
];

export function HeroTerminal() {
  return (
    <section className="border-border-subtle bg-paper relative isolate overflow-hidden border-b">
      {/* Ruled plate. Non-square cells, masked downward. Decorative, so it is
          hidden from assistive tech and sits behind everything. */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 -z-10",
          "bg-[linear-gradient(to_right,var(--color-border-subtle)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border-subtle)_1px,transparent_1px)]",
          "bg-[size:96px_80px]",
          "[mask-image:linear-gradient(to_bottom,#000_0%,#000_45%,transparent_92%)]",
        )}
      />

      <div className="mx-auto max-w-[1200px] px-6 lg:px-10">
        {/* ── Plate annotation, top edge ──────────────────────────────── */}
        <Reveal>
          <div className="border-border-subtle font-numeric text-text-tertiary flex items-center justify-between border-b py-3 text-[10px] tracking-[0.14em] uppercase">
            <span>Fig. 01 — Net position</span>
            <span className="hidden sm:inline">Illustrative</span>
          </div>
        </Reveal>

        {/* ── The band. `items-end` is the load-bearing property. ─────── */}
        <div className="grid grid-cols-1 items-end gap-12 pt-16 pb-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-14 lg:pt-24">
          {/* Statement */}
          <div>
            <Reveal>
              <p className="font-numeric text-text-tertiary text-[11px] tracking-[0.18em] uppercase">Financial intelligence</p>
            </Reveal>

            <Reveal delayMs={40}>
              {/* Display scale, 56px — DESIGN.md §4 permits it on marketing
                  pages only, and caps it there. The headline reads larger
                  than before not because it grew but because everything
                  around it shrank and the air above it doubled. */}
              <h1 className="font-serif text-ink mt-7 text-[44px] leading-[48px] font-normal tracking-[0] sm:text-[60px] sm:leading-[64px]">
                Your money.
                <br />
                Finally understood.
              </h1>
            </Reveal>

            <Reveal delayMs={80}>
              <p className="text-text-secondary mt-7 max-w-[42ch] text-[17px] leading-[26px]">
                One system for income, expenses, accounts and invoices — that answers real questions about them, grounded in your own records.
              </p>
            </Reveal>

            <Reveal delayMs={120}>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
                <PrimaryCta />
                <Button asChild variant="ghost" size="lg">
                  <a href="#story">See how it works</a>
                </Button>
              </div>
            </Reveal>
          </div>

          {/* Statement fragment — ruled, not boxed. */}
          <Reveal delayMs={100}>
            <figure className="border-border lg:border-border-subtle border-t pt-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-10">
              <figcaption className="font-numeric text-text-tertiary flex items-center justify-between text-[10px] tracking-[0.14em] uppercase">
                <span>Net position</span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="bg-positive size-1 rounded-full" />
                  Live
                </span>
              </figcaption>

              <p className="font-numeric text-ink mt-4 text-[40px] leading-[48px] font-medium tracking-[-0.015em]">$42,184.60</p>
              <p className="font-numeric text-positive mt-1 text-[13px]">+6.2% vs. last month</p>

              <div className="mt-6">
                <Sparkline values={PREVIEW_NET} width={360} height={52} ariaLabel="Illustrative six-month net movement" className="w-full" />
              </div>

              <dl className="border-border-subtle divide-border-subtle mt-6 grid grid-cols-2 divide-x border-t pt-4">
                <div className="flex flex-col gap-1 pr-6">
                  <dt className="font-numeric text-text-tertiary text-[10px] tracking-[0.08em] uppercase">In</dt>
                  <dd className="font-numeric text-positive text-[17px]">+$9,182.00</dd>
                </div>
                <div className="flex flex-col gap-1 pl-6">
                  <dt className="font-numeric text-text-tertiary text-[10px] tracking-[0.08em] uppercase">Out</dt>
                  <dd className="font-numeric text-negative text-[17px]">−$4,126.00</dd>
                </div>
              </dl>
            </figure>
          </Reveal>
        </div>
      </div>

      {/* ── The ledger strip ───────────────────────────────────────────────
          The signature element. Not a table — a horizontal run of the ledger
          itself, ruled top and bottom, with vertical hairlines between
          entries. It is the one thing on the page that could not belong to
          any other product. Scrolls inside its own container below `lg`
          rather than wrapping, so the rhythm survives on a phone. */}
      <Reveal>
        <div className="border-border-subtle bg-surface/60 border-y">
          <div className="mx-auto max-w-[1200px] overflow-x-auto px-6 lg:px-10">
            <ul className="divide-border-subtle flex min-w-max divide-x lg:grid lg:min-w-0 lg:grid-cols-[auto_repeat(4,minmax(0,1fr))]">
              <li className="font-numeric text-text-tertiary flex shrink-0 items-center pr-5 text-[10px] tracking-[0.14em] uppercase">Ledger</li>
              {LEDGER.map((entry) => (
                <li key={`${entry.date}-${entry.label}`} className="flex min-w-0 shrink-0 items-baseline gap-2.5 px-6 py-3.5 lg:shrink lg:px-4">
                  <span className="font-numeric text-text-tertiary shrink-0 text-[11px] tabular-nums">{entry.date}</span>
                  <span className="text-text-primary min-w-0 flex-1 truncate text-[13px] lg:text-[12px]">{entry.label}</span>
                  <span className={cn("font-numeric shrink-0 text-[13px] tabular-nums lg:text-[12px]", entry.tone === "positive" ? "text-positive" : "text-text-primary")}>
                    {entry.amount}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Reveal>

      {/* ── Capability index ───────────────────────────────────────────────
          hero-08's horizontal feature row as an index, not four cards: no
          backgrounds, no borders around each cell, just a number, a label and
          a rule that darkens on hover. §26 bans the equal-card block and §10
          reserves boxes for discrete objects; four capabilities of a single
          product are not four objects. */}
      <div className="mx-auto max-w-[1200px] px-6 pb-16 lg:px-10">
        <Reveal delayMs={60}>
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            {CAPABILITIES.map((capability) => (
              <li key={capability.index}>
                <a
                  href="#story"
                  className={cn(
                    "border-border-subtle hover:border-border-strong group block border-t pt-4 pb-2 lg:pr-8",
                    "transition-colors duration-[var(--duration-fast)] ease-out",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  )}
                >
                  <span className="font-numeric text-text-tertiary flex items-center gap-2 text-[10px] tracking-[0.14em] tabular-nums">
                    {capability.index}
                    <span
                      aria-hidden="true"
                      className="bg-border-subtle group-hover:bg-border-strong h-px w-3 transition-colors duration-[var(--duration-fast)] ease-out"
                    />
                  </span>
                  <span className="text-ink mt-2 block text-[17px] font-semibold tracking-[-0.005em]">{capability.title}</span>
                  <span className="text-text-secondary mt-1 block max-w-[32ch] text-[13px] leading-[20px]">{capability.body}</span>
                </a>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
