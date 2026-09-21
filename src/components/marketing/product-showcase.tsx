import { ThreeDPhotoCarousel, type CarouselCard } from "@/components/ui/3d-carousel";

/**
 * The product showcase band on the landing page.
 *
 * Ten surfaces of the product, drawn in the product's own language — paper,
 * hairlines, ink, one navy accent, figures in a monospaced face — rather than
 * photographed or mocked in a foreign style. They are illustrations, and the
 * caption under the carousel says so: this repository does not ship screenshots
 * of a running workspace, and a drawing presented as a screenshot would be the
 * kind of small dishonesty the rest of the site is careful to avoid.
 *
 * Order tells the story the section's heading promises: what the product is,
 * then what it answers, then the records it answers from, then what it makes
 * of them.
 */
const CARDS: CarouselCard[] = [
  {
    src: "/showcase/brand.svg",
    alt: "The Countorra mark: three ledger rows resolving into a single total bar, above the line “Your money. Finally understood.”",
    caption: "Countorra: one workspace for the records and the questions you ask of them.",
  },
  {
    src: "/showcase/ask-countorra.svg",
    alt: "The assistant answering “How much did I spend this month?” with $4,182.60 across 63 transactions, and the data sources it used",
    caption: "Ask your money a plain question. Every figure comes from your own records, with its sources named.",
  },
  {
    src: "/showcase/dashboard.svg",
    alt: "A dashboard showing a cash position of $42,184.60, a six-month trend line, income, expenses and profit, and two items needing attention",
    caption: "Your position, the month's movement, and the few things that want a decision.",
  },
  {
    src: "/showcase/transactions.svg",
    alt: "A transactions ledger listing income and expenses with categories and right-aligned amounts",
    caption: "Income and expenses in one ledger, searchable and categorised.",
  },
  {
    src: "/showcase/invoices.svg",
    alt: "An invoice list with paid, sent and overdue statuses and an outstanding total of $3,550.00",
    caption: "Invoices from draft to paid, with what is still outstanding in view.",
  },
  {
    src: "/showcase/reports.svg",
    alt: "A profit and loss report for the first quarter of 2026 showing income, expenses, profit and a 33.3% margin",
    caption: "Profit and loss for any period, calculated from the transactions themselves.",
  },
  {
    src: "/showcase/forecast.svg",
    alt: "A cash balance chart with a solid actual line and a dashed projected line, marking the lowest projected point",
    caption: "A projection, labelled as one: actual behind you, projected ahead.",
  },
  {
    src: "/showcase/automation.svg",
    alt: "Detected recurring commitments including subscriptions and rent, each with a confidence label and an annualised total",
    caption: "Recurring commitments found in your own history, with how sure we are.",
  },
  {
    src: "/showcase/tax-preparation.svg",
    alt: "A 2026 tax preparation checklist for federal and California with an estimated federal tax of $9,412.00 before credits",
    caption: "Tax preparation organised section by section. Preparation, not filing.",
  },
  {
    src: "/showcase/documents.svg",
    alt: "A W-2 document with three fields read from its text layer, proposed to tax preparation and awaiting confirmation",
    caption: "Documents read into figures you confirm. Nothing is used until you do.",
  },
];

export function ProductShowcase() {
  return (
    <div className="flex flex-col gap-6">
      {/* On a phone the stage runs to the screen edges (cancelling the
          section's px-6), so turning cards leave at the edge of the screen
          instead of being cut off 24px inside it. */}
      <ThreeDPhotoCarousel cards={CARDS} className="max-sm:-mx-6 max-sm:w-[calc(100%+3rem)]" />
      <p className="text-text-tertiary mx-auto max-w-[52ch] text-center text-[12px]">
        Drag to turn the carousel, or select a card to enlarge it. Illustrations of Countorra&apos;s interface, drawn in the product&apos;s own design
        system.
      </p>
    </div>
  );
}
