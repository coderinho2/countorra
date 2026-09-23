import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE_CATEGORIES, GUIDES, guideBySlug, readingMinutes, SUPPORTED_STATES_SENTENCE, TAX_NOTICE } from "@/components/guides/guides-content";
import { SUPPORTED_STATES } from "@/domain/tax/supported-states";

/**
 * The financial guides.
 *
 * These pages are public, permanent and indexed, which makes them the
 * easiest place in the product for a false claim to survive. The cases below
 * are the ones that would otherwise only be caught by a reader: a guide
 * describing a feature the product does not have, a tax guide naming a state
 * the engine cannot calculate, a dead "read next" link, or an invented
 * author or publication date.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const allText = GUIDES.flatMap((guide) => [
  guide.title,
  guide.summary,
  ...guide.sections.flatMap((section) => [section.heading, ...section.paragraphs, ...(section.bullets ?? [])]),
]).join("\n");

describe("structure", () => {
  it("publishes guides at all — the empty state is gone", () => {
    expect(GUIDES.length).toBeGreaterThanOrEqual(6);
    // The exact string the Resources page used to render in its place.
    expect(read("src/app/resources/page.tsx")).not.toMatch(/aren.t published yet/);
    expect(read("src/app/resources/page.tsx")).not.toContain("EmptyState");
  });

  it("has unique, url-safe slugs", () => {
    const slugs = GUIDES.map((guide) => guide.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug, slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("gives every guide a real body, not a stub", () => {
    for (const guide of GUIDES) {
      expect(guide.sections.length, guide.slug).toBeGreaterThanOrEqual(3);
      expect(readingMinutes(guide), guide.slug).toBeGreaterThan(0);
      for (const section of guide.sections) {
        expect(section.paragraphs.length, `${guide.slug}/${section.heading}`).toBeGreaterThan(0);
        for (const paragraph of section.paragraphs) expect(paragraph.length, `${guide.slug}/${section.heading}`).toBeGreaterThan(80);
      }
    }
  });

  it("files every guide under a known category", () => {
    for (const guide of GUIDES) expect(GUIDE_CATEGORIES, guide.slug).toContain(guide.category);
  });

  it("links only to guides that exist, and never to itself", () => {
    for (const guide of GUIDES) {
      expect(guide.related.length, guide.slug).toBeGreaterThan(0);
      for (const slug of guide.related) {
        expect(guideBySlug(slug), `${guide.slug} -> ${slug}`).toBeDefined();
        expect(slug).not.toBe(guide.slug);
      }
    }
  });
});

describe("no invented facts", () => {
  it("claims no author and no publication date", () => {
    const source = read("src/components/guides/guides-content.ts");
    for (const field of ["author", "publishedAt", "publishedOn", "byline", "datePublished"]) {
      expect(source.toLowerCase(), field).not.toMatch(new RegExp(`\\b${field}\\s*[:?]`, "i"));
    }
    expect(allText).not.toMatch(/\bby [A-Z][a-z]+ [A-Z][a-z]+\b/);
  });

  it("ships no placeholder text", () => {
    expect(allText).not.toMatch(/lorem|ipsum|TODO|TBD|coming soon|placeholder/i);
  });
});

describe("claims match the product", () => {
  it("never presents deferred or non-launch functionality", () => {
    // Countorra launches personal-only; invoicing and customers are deferred
    // (src/domain/organizations/launch-scope.ts).
    for (const banned of [/\binvoic/i, /\bcustomers\b/i, /\bfreelanc/i, /\bpayroll\b/i, /accounts payable/i, /accounts receivable/i, /\binventory\b/i]) {
      expect(allText, String(banned)).not.toMatch(banned);
    }
  });

  it("never claims Countorra files or submits a tax return", () => {
    expect(allText).not.toMatch(/we (?:can )?file your (?:tax )?return/i);
    expect(allText).not.toMatch(/Countorra (?:files|submits|e-files)/i);
    // And says the opposite somewhere it matters.
    expect(allText).toMatch(/does not prepare returns, does not e-file/);
  });

  it("names every supported state and no other", () => {
    for (const state of SUPPORTED_STATES) expect(SUPPORTED_STATES_SENTENCE, state.name).toContain(state.name);
    // A state outside the engine's scope must not be discussed as supported.
    for (const unsupported of ["Oregon", "Illinois", "Massachusetts", "Washington", "Colorado", "Georgia"]) {
      expect(allText, unsupported).not.toContain(unsupported);
    }
  });

  it("describes no non-US tax system", () => {
    for (const term of ["VAT", "HMRC", "Self Assessment", "GST", "CRA", "PAYE"]) expect(allText, term).not.toContain(term);
  });

  it("separates general information from advice on every tax guide", () => {
    const taxGuides = GUIDES.filter((guide) => guide.category === "Taxes");
    expect(taxGuides.length).toBeGreaterThan(0);
    for (const guide of taxGuides) expect(guide.taxNotice, guide.slug).toBe(true);
    expect(TAX_NOTICE).toMatch(/not advice about your particular circumstances/);
  });

  it("keeps the AI guide honest about where numbers come from and what needs approval", () => {
    const guide = guideBySlug("using-an-ai-financial-assistant");
    const text = guide!.sections.flatMap((section) => section.paragraphs).join("\n");
    expect(text).toMatch(/not authoritative/);
    expect(text).toMatch(/waits for explicit approval/);
    expect(text).toMatch(/own calculation code, not by the language model/);
  });

  it("keeps the bank guide honest about credentials", () => {
    const text = guideBySlug("how-connected-accounts-work")!.sections.flatMap((section) => section.paragraphs).join("\n");
    expect(text).toMatch(/never receives or stores your bank username or password/);
  });
});

describe("routing", () => {
  it("is reachable: the index, the guide route and the navigation all exist", () => {
    expect(() => read("src/app/guides/page.tsx")).not.toThrow();
    expect(() => read("src/app/guides/[slug]/page.tsx")).not.toThrow();
    expect(read("src/components/marketing/nav-data.ts")).toContain('href: "/guides"');
    expect(read("src/components/marketing/marketing-footer.tsx")).toContain('href: "/guides"');
    // Every guide is in the sitemap, because the sitemap is generated from
    // this same list rather than maintained by hand.
    expect(read("src/app/sitemap.ts")).toContain("GUIDES.map");
  });
});
