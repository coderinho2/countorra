import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr/ArrowRight";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Reveal } from "@/components/marketing/reveal";
import { HELP_CATEGORIES, HELP_FAQS, SUPPORT_EMAIL, SUPPORT_MAILTO, type HelpArticle } from "@/components/help/help-content";
import { HelpSearch } from "@/components/help/help-search";
import Faqs01 from "@/components/ui/faqs-01";

export const metadata: Metadata = {
  title: "Help Centre",
  description: "How Countorra works: accounts, transactions, invoices, reports, Ask Countorra, bank connections, tax preparation, security and billing.",
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The Help Centre. Content lives in src/components/help/help-content.ts —
 * one source for this page and for its search — and describes the product as
 * it is, including what it does not do yet.
 *
 * Composition: the hero pairs the question ("How can we help?") and its
 * search with a ledger-style index of topics, so both ways in are visible
 * at once; below, a sticky contents rail beside long-form articles, and the
 * FAQ in its own band at the end. On a phone everything is one column and
 * the topic index is the navigation.
 */
export default function HelpCentrePage() {
  const topics = [
    ...HELP_CATEGORIES.map((category) => ({ id: category.id, title: category.title, description: category.description, count: category.articles.length })),
    { id: "faq", title: "FAQ", description: "Short answers to the questions people ask most.", count: HELP_FAQS.length },
  ];

  return (
    <MarketingShell>
      <section className="mx-auto grid max-w-[1200px] gap-12 px-6 pt-16 pb-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:gap-16 lg:px-10 lg:pt-24 lg:pb-20">
        <Reveal className="flex flex-col">
          <p className="font-numeric text-[11px] tracking-[0.14em] text-text-tertiary uppercase">Help Centre</p>
          <h1 className="mt-3 font-serif text-[40px] leading-[46px] font-normal tracking-[0] text-ink sm:text-[52px] sm:leading-[58px]">How can we help?</h1>
          <p className="mt-5 max-w-[52ch] text-[17px] leading-[26px] text-text-secondary">
            How Countorra works, written from the product as it is today — including the parts that are limited or not built yet.
          </p>
          <div className="mt-8 max-w-[600px]">
            <HelpSearch />
          </div>
        </Reveal>

        <Reveal delayMs={80}>
          <nav aria-label="Help topics">
            <h2 className="font-numeric flex items-center gap-3 border-b border-border pb-2.5 text-[10px] tracking-[0.14em] text-text-tertiary uppercase">
              Browse by topic
              <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
            </h2>
            <ol className="divide-y divide-border-subtle">
              {topics.map((topic, index) => (
                <li key={topic.id}>
                  <a href={`#${topic.id}`} className="group grid grid-cols-[28px_minmax(0,1fr)_auto] items-baseline gap-x-3 py-3.5 transition-colors duration-100 ease-out">
                    <span className="font-numeric text-[12px] text-text-tertiary">{pad(index + 1)}</span>
                    <span className="min-w-0">
                      <span className="block text-[15px] font-medium text-ink transition-colors duration-[120ms] ease-out group-hover:text-accent">{topic.title}</span>
                      <span className="mt-0.5 block text-[13px] leading-[1.5] text-text-secondary">{topic.description}</span>
                    </span>
                    <span className="font-numeric text-[12px] text-text-tertiary" aria-label={`${topic.count} ${topic.id === "faq" ? "questions" : "articles"}`}>
                      {pad(topic.count)}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </Reveal>
      </section>

      <div className="border-t border-border-subtle">
        <div className="mx-auto grid max-w-[1200px] px-6 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-16 lg:px-10">
          <aside className="hidden lg:block">
            <nav aria-label="Help Centre contents" className="sticky top-24 py-16">
              <p className="font-numeric text-[10px] tracking-[0.14em] text-text-tertiary uppercase">Contents</p>
              <ol className="mt-4 flex flex-col gap-1 border-l border-border-subtle">
                {topics.map((topic) => (
                  <li key={topic.id}>
                    <a
                      href={`#${topic.id}`}
                      className="-ml-px block border-l border-transparent py-1.5 pl-4 text-[14px] text-text-secondary transition-colors duration-100 ease-out hover:border-border-strong hover:text-text-primary"
                    >
                      {topic.title}
                    </a>
                  </li>
                ))}
              </ol>
              <a href={SUPPORT_MAILTO} className="mt-8 block text-[13px] leading-[1.5] text-text-secondary transition-colors duration-100 ease-out hover:text-text-primary">
                Contact support
                <span className="block font-medium break-all text-accent">{SUPPORT_EMAIL}</span>
              </a>
            </nav>
          </aside>

          <div className="min-w-0 max-w-[720px] pb-8">
            {HELP_CATEGORIES.map((category, index) => (
              <section key={category.id} id={category.id} aria-labelledby={`${category.id}-title`} className="scroll-mt-20 border-b border-border-subtle py-14 last:border-b-0 lg:py-16">
                <Reveal>
                  <p className="font-numeric text-[12px] text-text-tertiary">{pad(index + 1)}</p>
                  <h2 id={`${category.id}-title`} className="mt-2 text-[24px] leading-[30px] font-semibold tracking-[-0.01em] text-ink sm:text-[28px] sm:leading-[34px]">
                    {category.title}
                  </h2>
                  <p className="mt-2 max-w-[56ch] text-[15px] leading-[1.6] text-text-secondary">{category.description}</p>
                </Reveal>
                <div className="mt-6 flex flex-col divide-y divide-border-subtle border-t border-border-subtle">
                  {category.articles.map((article) => (
                    <Article key={article.id} article={article} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>

      <section id="faq" className="scroll-mt-16 border-t border-border-subtle bg-surface-sunken/40">
        {/* The same two columns as the articles, so the FAQ lines up with them. */}
        <div className="mx-auto grid max-w-[1200px] px-6 py-16 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-16 lg:px-10 lg:py-24">
          <Faqs01 items={HELP_FAQS} supportEmail={SUPPORT_EMAIL} className="max-w-[720px] lg:col-start-2 lg:mx-0" />
        </div>
      </section>
    </MarketingShell>
  );
}

function Article({ article }: { article: HelpArticle }) {
  return (
    <article id={article.id} aria-labelledby={`${article.id}-title`} className="scroll-mt-24 py-7">
      <h3 id={`${article.id}-title`} className="text-[18px] leading-[26px] font-semibold text-ink">
        {article.title}
      </h3>
      {article.where && (
        <p className="font-numeric mt-1.5 text-[11px] leading-[16px] tracking-[0.06em] text-text-tertiary uppercase">
          <span className="sr-only">Where to find it: </span>
          In the app · {article.where}
        </p>
      )}
      <div className="mt-3 flex flex-col gap-3 text-[15px] leading-[1.65] text-text-secondary">
        {article.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        {article.points && (
          <ul className="flex flex-col gap-2">
            {article.points.map((point) => (
              <li key={point} className="relative pl-4 before:absolute before:top-[0.8em] before:left-0 before:h-px before:w-2 before:bg-border-strong">
                {point}
              </li>
            ))}
          </ul>
        )}
      </div>
      {article.links && (
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          {article.links.map((link) => (
            <Link key={link.href} href={link.href} className="inline-flex items-center gap-1.5 text-[14px] font-medium text-accent hover:underline">
              {link.label}
              <ArrowRight size={13} aria-hidden="true" />
            </Link>
          ))}
        </div>
      )}
    </article>
  );
}
