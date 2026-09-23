import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Reveal } from "@/components/marketing/reveal";
import { GUIDES, guideBySlug, readingMinutes, TAX_NOTICE } from "@/components/guides/guides-content";

/**
 * One guide.
 *
 * Set in the same measure as the legal pages (max-w-[760px], 70ch of prose):
 * this is the product's other long-form reading context, and the two should
 * feel like the same publication. The display serif is used for the title
 * only, per DESIGN.md §4 — section headings stay in the UI face so the page
 * reads as a document rather than a brochure.
 *
 * Content, and the rules it is written under, live in
 * src/components/guides/guides-content.ts.
 */

export function generateStaticParams() {
  return GUIDES.map((guide) => ({ slug: guide.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const guide = guideBySlug((await params).slug);
  if (!guide) return {};
  return {
    title: guide.title,
    description: guide.summary,
    alternates: { canonical: `/guides/${guide.slug}` },
    openGraph: { type: "article", title: guide.title, description: guide.summary, url: `/guides/${guide.slug}` },
  };
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const guide = guideBySlug((await params).slug);
  if (!guide) notFound();

  const related = guide.related.map(guideBySlug).filter((entry) => entry !== undefined);

  return (
    <MarketingShell>
      <article className="mx-auto max-w-[760px] px-6 py-16 lg:px-10 lg:py-24">
        <Reveal>
          <div className="flex items-center gap-2 text-[13px] text-text-tertiary">
            <Link href="/guides" className="hover:text-text-secondary">
              Financial guides
            </Link>
            <span aria-hidden="true">·</span>
            <span>{guide.category}</span>
            <span aria-hidden="true">·</span>
            <span className="font-numeric">{readingMinutes(guide)} min read</span>
          </div>
          <h1 className="font-serif mt-3 text-[32px] leading-[40px] font-normal tracking-[0] text-ink sm:text-[38px] sm:leading-[46px]">{guide.title}</h1>
          <p className="mt-5 max-w-[70ch] text-[17px] leading-[1.7] text-text-secondary">{guide.summary}</p>
        </Reveal>

        <div className="mt-12 flex flex-col gap-10">
          {guide.sections.map((section) => (
            <Reveal key={section.heading}>
              <section className="flex flex-col gap-3 border-t border-border-subtle pt-8">
                <h2 className="text-2xl font-semibold tracking-[-0.01em] text-ink sm:text-[26px]">{section.heading}</h2>
                <div className="flex max-w-[70ch] flex-col gap-3 text-[15px] leading-[1.7] text-text-secondary">
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph.slice(0, 48)}>{paragraph}</p>
                  ))}
                  {section.bullets && (
                    <ul className="flex list-disc flex-col gap-1.5 pl-5">
                      {section.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            </Reveal>
          ))}
        </div>

        {guide.taxNotice && (
          <Reveal>
            <aside className="mt-10 rounded-md border border-border-subtle bg-surface-sunken p-4">
              <p className="max-w-[70ch] text-[13px] leading-[1.6] text-text-secondary">
                <strong className="text-text-primary">General information.</strong> {TAX_NOTICE}
              </p>
            </aside>
          </Reveal>
        )}

        {related.length > 0 && (
          <Reveal>
            <nav aria-label="Related guides" className="mt-12 border-t border-border-subtle pt-8">
              <h2 className="font-numeric text-[10px] tracking-[0.14em] text-text-tertiary uppercase">Read next</h2>
              <ul className="mt-4 flex flex-col divide-y divide-border-subtle">
                {related.map((entry) => (
                  <li key={entry.slug}>
                    <Link href={`/guides/${entry.slug}`} className="group flex flex-col gap-1 py-4">
                      <span className="text-[15px] font-semibold text-ink group-hover:text-accent">{entry.title}</span>
                      <span className="max-w-[62ch] text-[14px] leading-[1.6] text-text-secondary">{entry.summary}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </Reveal>
        )}
      </article>
    </MarketingShell>
  );
}
