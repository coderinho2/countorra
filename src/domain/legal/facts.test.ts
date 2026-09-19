import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LegalFact } from "@/components/legal/legal-fact";
import { LEGAL_FACTS, LEGAL_FACT_LABELS, LEGAL_PLACEHOLDERS_REMAINING, type LegalFacts } from "./facts";

/**
 * The legal pages may not invent business facts, and may not state false
 * product facts. The first is enforced by rendering unknown facts as visible
 * placeholders; the second by a claims audit of the page sources.
 */

const page = (name: string) => readFileSync(path.resolve(process.cwd(), `src/app/${name}/page.tsx`), "utf8");

describe("business facts that only the business can supply", () => {
  it("lists exactly the facts still missing", () => {
    const missing = (Object.keys(LEGAL_FACTS) as (keyof LegalFacts)[]).filter((key) => LEGAL_FACTS[key] === null);
    expect(LEGAL_PLACEHOLDERS_REMAINING).toEqual(missing);
  });

  it("renders a missing fact as a visible, labelled placeholder — never blank, never invented", () => {
    for (const name of Object.keys(LEGAL_FACTS) as (keyof LegalFacts)[]) {
      const html = renderToStaticMarkup(createElement(LegalFact, { name }));
      if (LEGAL_FACTS[name] === null) {
        expect(html).toContain(`data-legal-placeholder="${name}"`);
        expect(html).toContain(`[${LEGAL_FACT_LABELS[name]} — to be provided before launch]`);
      } else {
        expect(html).toContain(LEGAL_FACTS[name]!);
      }
    }
  });

  it("is where those facts live — no page carries an old hand-typed placeholder", () => {
    for (const name of ["privacy", "terms", "security"]) {
      expect(page(name)).not.toMatch(/\[Company Legal Name\]|\[Company Registered Address\]|\[Governing Jurisdiction\]|yourdomain\.example/);
    }
  });
});

describe("the claims audit: statements that would now be false", () => {
  const FALSE_CLAIMS: [string, RegExp][] = [
    ["privacy: no payment processor", /not<\/strong> currently use[^.]*payment processor/],
    ["privacy: no bank connection", /does not connect to your bank/],
    ["privacy: no self-serve deletion", /Self-serve account deletion is not yet built/],
    ["terms: plans not purchasable", /not yet purchasable/],
    ["terms: no bank connections", /does not\s+currently connect to external bank accounts/],
    ["terms: payment processing not integrated", /payment processing is not integrated/],
    ["any: Textract active", /(uses|use|via|through) Amazon Textract/],
  ];

  it.each(FALSE_CLAIMS)("%s is gone", (_label, pattern) => {
    for (const name of ["privacy", "terms", "security"]) expect(page(name)).not.toMatch(pattern);
  });

  it("claims no certification that does not exist", () => {
    const security = page("security");
    expect(security).not.toMatch(/SOC 2 (certified|compliant|Type)|PCI (DSS )?(certified|compliant)|HIPAA|ISO 27001 certified|penetration[- ]tested/i);
    // The only mention of those words is the statement that they are NOT held.
    expect(security).toMatch(/has not been audited or certified by a third party/);
  });
});

describe("the statements that must now be there", () => {
  it("privacy names every processor actually used, and what Plaid provides", () => {
    const privacy = page("privacy");
    for (const provider of ["Supabase", "Vercel", "Anthropic", "Plaid", "Stripe", "Resend"]) expect(privacy).toContain(provider);
    expect(privacy).toContain('id="bank-connections"');
    expect(privacy).toMatch(/never receives or stores your bank username or password/);
    expect(privacy).toMatch(/AES-256-GCM/);
    expect(privacy).toMatch(/never receives or stores your full card number/);
    expect(privacy).toMatch(/Disconnecting\./);
    expect(privacy).toMatch(/Deleting your account<\/Strong> is self-serve/);
  });

  it("terms cover billing, Plaid, and the real limits of the tax figures", () => {
    const terms = page("terms");
    expect(terms).toContain("PLAN_ENTITLEMENTS");
    expect(terms).toMatch(/Recurring billing/);
    // Task 17: deletion now cancels billing first, and the page must say so —
    // and must no longer say the opposite.
    expect(terms).toMatch(/Deleting your account cancels your subscriptions/);
    expect(terms).toMatch(/confirms with Stripe/);
    expect(terms).not.toMatch(/does not cancel a subscription/);
    expect(terms).toMatch(/Bank connections through Plaid/);
    expect(terms).toMatch(/California, New York State, Arizona/);
    expect(terms).toMatch(/Florida and Texas/);
    expect(terms).toMatch(/does not e-file/);
    expect(terms).toMatch(/not authoritative/);
  });
});
