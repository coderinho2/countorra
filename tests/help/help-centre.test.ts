import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_CATEGORIES, HELP_FAQS, SUPPORT_EMAIL, SUPPORT_MAILTO } from "@/components/help/help-content";
import { searchHelp, tokenize } from "@/components/help/help-search-index";
import { PLAN_ENTITLEMENTS, FEATURE_IMPLEMENTED } from "@/domain/billing/entitlements";
import { supportedJurisdictions, supportedTaxYears } from "@/domain/tax/register";

/**
 * The Help Centre describes the real product, so these tests tie its
 * statements to the code they describe: when a plan limit, a tax rule set or
 * a sign-in method changes, the article that states it fails here instead of
 * quietly going stale.
 */

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const allText = JSON.stringify({ HELP_CATEGORIES, HELP_FAQS });
const articles = HELP_CATEGORIES.flatMap((category) => category.articles);

describe("search", () => {
  it("answers the question people actually type", () => {
    // The FAQ answer and the full article are both right; both lead.
    const top = searchHelp("How do I connect my bank?").slice(0, 2).map((result) => result.anchor);
    expect(top.sort()).toEqual(["connecting-a-bank", "faq-connect-bank-accounts"]);
  });

  it.each([
    ["forgot my password", "password-reset"],
    ["reset password", "password-reset"],
    ["verify email", "email-verification"],
    ["cancel subscription", "managing-your-subscription"],
    ["plaid", "connecting-a-bank"],
    ["delete my account", "deleting-your-account"],
    ["what is countorra", "what-is-countorra"],
    ["does it file my taxes", "tax-filing"],
    ["new york state tax", "supported-jurisdictions"],
    ["forecast", "forecasts"],
    ["savings rate", "reports"],
  ])("finds %j", (query, anchor) => {
    expect(searchHelp(query).map((result) => result.anchor).slice(0, 3)).toContain(anchor);
  });

  it("finds FAQ answers, and links them to their accordion item", () => {
    const faq = searchHelp("How is Countorra different from other solutions").find((result) => result.kind === "faq");
    expect(faq?.anchor).toBe("faq-how-is-countorra-different");
  });

  it("returns nothing for nothing, and for words it has never heard of", () => {
    expect(searchHelp("")).toEqual([]);
    expect(searchHelp("   ")).toEqual([]);
    expect(searchHelp("zzqxj")).toEqual([]);
  });

  it("ignores case and accents", () => {
    expect(tokenize("Café PLAID")).toEqual(["cafe", "plaid"]);
  });

  it("caps the number of results", () => {
    expect(searchHelp("account", 5).length).toBeLessThanOrEqual(5);
  });
});

describe("structure", () => {
  it("covers every topic the Help Centre promises", () => {
    expect(HELP_CATEGORIES.map((category) => category.id)).toEqual([
      "getting-started",
      "using-countorra",
      "connections-and-data",
      "taxes-and-accounting",
      "account-and-security",
      "billing",
    ]);
  });

  it("opens the FAQ with the required questions, in order", () => {
    expect(HELP_FAQS.map((faq) => faq.question)).toEqual([
      "What is Countorra?",
      "What is Countorra's role?",
      "How is Countorra different from other solutions?",
      "Why Countorra?",
      "How does Countorra work?",
      "Is Countorra for individuals or businesses?",
      "What can Ask Countorra do?",
      "How does Countorra handle my financial data?",
      "Can I connect my bank accounts?",
      "Does Countorra handle taxes?",
    ]);
  });

  it("gives every article and question a unique anchor", () => {
    const anchors = [...HELP_CATEGORIES.map((c) => c.id), ...articles.map((a) => a.id), ...HELP_FAQS.map((f) => `faq-${f.id}`), "faq"];
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("links only to public pages that exist", () => {
    for (const link of articles.flatMap((article) => article.links ?? [])) {
      const route = link.href.split("#")[0]!;
      const file = route === "/" ? "src/app/page.tsx" : ["src/app", route, "page.tsx"].join("/");
      const grouped = `src/app/(auth)${route}/page.tsx`;
      expect([file, grouped].some((candidate) => { try { read(candidate); return true; } catch { return false; } }), link.href).toBe(true);
    }
  });
});

describe("support contact", () => {
  it("is support@countorra.com, as a mailto link", () => {
    expect(SUPPORT_EMAIL).toBe("support@countorra.com");
    expect(SUPPORT_MAILTO).toBe("mailto:support@countorra.com");
  });

  it("carries no address but that one, and nothing from the source template", () => {
    // src/lib/support.ts is where the literal lives; the rest display it.
    // Every surface that offers a way to write to Countorra is read here, so
    // a second, unmonitored address cannot appear on any of them.
    const sources = [
      read("src/lib/support.ts"),
      read("src/components/help/help-content.ts"),
      read("src/app/help/page.tsx"),
      read("src/components/ui/faqs-01.tsx"),
      read("src/components/help/help-search.tsx"),
      read("src/components/marketing/marketing-footer.tsx"),
      read("src/app/error.tsx"),
      read("src/app/(auth)/verify-email/page.tsx"),
      read("src/app/app/[orgId]/error.tsx"),
      read("src/domain/legal/facts.ts"),
    ].join("\n");
    const addresses = new Set(sources.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []);
    expect([...addresses]).toEqual(["support@countorra.com"]);
    expect(sources).not.toMatch(/blockus|solaceui|example\.com|lorem/i);
  });
});

describe("statements match the product", () => {
  it("states each plan's price, workspace and AI limits exactly", () => {
    const plans = articles.find((article) => article.id === "plans")!.points!.join(" ");
    for (const tier of ["free", "premium", "business"] as const) {
      const plan = PLAN_ENTITLEMENTS[tier];
      expect(plans).toContain(`$${plan.priceMinorMonthly / 100}`);
      expect(plans).toContain(`${plan.aiMessagesPerDay} AI requests a day`);
    }
    expect(PLAN_ENTITLEMENTS.free.maxOrganizations).toBe(1);
    expect(PLAN_ENTITLEMENTS.premium.maxOrganizations).toBe(3);
    expect(PLAN_ENTITLEMENTS.business.maxOrganizations).toBeNull();
    expect(plans).toMatch(/Free — \$0\. One workspace/);
    expect(plans).toMatch(/Premium — \$19 a month\. Three workspaces/);
    expect(plans).toMatch(/Business — \$49 a month\. Unlimited workspaces/);
  });

  it("calls unbuilt features coming soon, and built ones available on paid plans", () => {
    // Document processing became true when Textract shipped; the Help Centre
    // article about scans was rewritten in the same change, which is what
    // this case exists to keep in step.
    expect(FEATURE_IMPLEMENTED.documentProcessing).toBe(true);
    expect(FEATURE_IMPLEMENTED.advancedTaxTools).toBe(false);
    expect(FEATURE_IMPLEMENTED.prioritySupport).toBe(false);
    expect(FEATURE_IMPLEMENTED.bankConnections).toBe(true);
    expect(PLAN_ENTITLEMENTS.free.bankConnections).toBe(false);
    expect(allText).toMatch(/not available yet on any plan/);
  });

  it("names exactly the tax jurisdictions and year that have rule sets", () => {
    expect(supportedJurisdictions().sort()).toEqual(["US_AZ", "US_CA", "US_FEDERAL", "US_FL", "US_NY", "US_TX"]);
    expect(supportedTaxYears("US_FEDERAL")).toEqual([2026]);
    const jurisdictions = articles.find((article) => article.id === "supported-jurisdictions")!.points!.join(" ");
    for (const state of ["California", "New York", "Arizona", "Texas", "Florida"]) expect(jurisdictions).toContain(state);
    expect(jurisdictions).toContain("2026");
  });

  it("never says Countorra files a return", () => {
    expect(allText).toMatch(/does not file/);
    expect(allText).not.toMatch(/(we|countorra) (files|submits|e-files) (your|the) (tax )?return/i);
  });

  it("does not advertise sign-in methods that do not exist", () => {
    expect(read("src/server/auth/actions.ts")).toMatch(/NO OAUTH PROVIDER IS CONFIGURED/);
    expect(allText).toMatch(/Signing in with Google, Apple or another provider is not available/);
    expect(allText).not.toMatch(/(sign|log) in with (google|apple)(?! or)/i);
  });

  it("describes forecasts as an assistant capability, because there is no forecast page", () => {
    expect(() => read("src/app/app/[orgId]/forecasts/page.tsx")).toThrow();
    expect(articles.find((article) => article.id === "forecasts")!.body.join(" ")).toMatch(/no separate forecast page/i);
  });
});

describe("the FAQ is only in the Help Centre", () => {
  it("is not on the homepage", () => {
    expect(read("src/app/page.tsx")).not.toMatch(/faqs-01|Faqs01|HELP_FAQS/);
  });

  it("is reachable from the Resources menu and the footer", () => {
    expect(read("src/components/marketing/nav-data.ts")).toMatch(/label: "Help Centre", [^\n]*href: "\/help"/);
    expect(read("src/components/marketing/marketing-footer.tsx")).toMatch(/label: "Help Centre", href: "\/help"/);
    expect(read("src/app/sitemap.ts")).toMatch(/path: "\/help"/);
  });
});

describe("ranking", () => {
  it("puts the article about a subject above ones that mention it", () => {
    expect(searchHelp("tax").slice(0, 3).map((result) => result.anchor)).toContain("tax-preparation");
    expect(searchHelp("tax")[0]?.anchor).not.toBe("financial-reports-and-tax");
  });
});

describe("personal-only launch scope", () => {
  it("has no articles for the deferred invoicing module", () => {
    const ids = articles.map((article) => article.id);
    expect(ids).not.toContain("invoices");
    expect(ids).not.toContain("customers");
  });

  it("answers someone searching for freelancer or business support with the personal workspace", () => {
    expect(searchHelp("freelancer").map((r) => r.anchor).slice(0, 2)).toContain("your-personal-workspace");
    expect(searchHelp("business workspace").map((r) => r.anchor).slice(0, 3)).toContain("your-personal-workspace");
  });

  it("says Countorra is for individuals", () => {
    const faq = HELP_FAQS.find((f) => f.id === "individuals-or-businesses")!;
    expect(faq.answer[0]).toMatch(/^Individuals\./);
    expect(faq.answer.join(" ")).toMatch(/not part of Countorra yet/);
  });

  it("never offers a workspace type to choose, or invoicing as something the assistant does", () => {
    expect(allText).not.toMatch(/Choose Personal, Freelancer or Business/);
    expect(allText).not.toMatch(/draft(ing)? an invoice/i);
    const assistant = HELP_FAQS.find((f) => f.id === "what-can-ask-countorra-do")!;
    expect(assistant.points!.join(" ")).not.toMatch(/invoice|customer/i);
  });
});

