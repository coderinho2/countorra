import { SUPPORTED_STATES } from "@/domain/tax/supported-states";

/**
 * The Countorra financial guides, as data.
 *
 * One source for the listing (/guides), the individual pages
 * (/guides/[slug]) and the section on /resources, so the three cannot
 * disagree.
 *
 * EVERY STATEMENT HERE DESCRIBES THE PRODUCT AS IT IS IN THIS REPOSITORY,
 * on the same terms as src/components/help/help-content.ts. A guide may teach
 * a general financial idea, but the moment it says what Countorra does, that
 * has to be true today — not planned. Where the product is limited, the guide
 * says so. Where the code lives, for the claims most likely to drift:
 *
 *   supported states      src/domain/tax/supported-states.ts (read below)
 *   what tax is modelled  src/domain/tax/rules/registry.ts, /terms §7
 *   bank connections      src/domain/bank-connections, PLAID-INTEGRATION.md
 *   manual entry          src/domain/accounts/manual-entry.ts
 *   assistant + approval  src/domain/ai/tools/registry.ts, /terms §8–9
 *   documents             src/server/documents (PDF text layer, no OCR)
 *
 * NO AUTHOR AND NO PUBLICATION DATE. Countorra has no bylined authors, and
 * inventing either would be a fabricated fact on pages whose whole value is
 * being trustworthy. Reading time is computed from the text, so it cannot go
 * stale either.
 *
 * Tax guides carry `taxNotice`, which renders the same standard distinction
 * between general information and individual advice on every one of them.
 */

export interface GuideSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export type GuideCategory = "Foundations" | "Your accounts" | "Taxes" | "Using Countorra";

export interface Guide {
  slug: string;
  title: string;
  /** One sentence: the listing card, the page intro and the meta description. */
  summary: string;
  category: GuideCategory;
  sections: GuideSection[];
  /** Tax guides only: adds the information-not-advice notice. */
  taxNotice?: true;
  /** Slugs worth reading next. Every one is checked in the guides test. */
  related: string[];
}

export const GUIDE_CATEGORIES: readonly GuideCategory[] = ["Foundations", "Your accounts", "Taxes", "Using Countorra"];

const STATE_NAMES = SUPPORTED_STATES.map((state) => state.name);
const NO_INCOME_TAX = SUPPORTED_STATES.filter((state) => !state.leviesIndividualIncomeTax).map((state) => state.name);
const WITH_INCOME_TAX = SUPPORTED_STATES.filter((state) => state.leviesIndividualIncomeTax);

/** "California, Texas, Arizona, Florida and New York" — never hand-typed. */
function sentenceList(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export const SUPPORTED_STATES_SENTENCE = sentenceList(STATE_NAMES);

export const GUIDES: Guide[] = [
  {
    slug: "organize-your-personal-finances",
    title: "How to organize your personal finances",
    summary: "A sequence that works: get everything in one place, make the records true, then start asking questions of them.",
    category: "Foundations",
    related: ["understand-your-monthly-cash-flow", "how-connected-accounts-work"],
    sections: [
      {
        heading: "Start with completeness, not categories",
        paragraphs: [
          "The instinct is to start categorizing. Resist it. A perfectly categorized picture of half your money is more misleading than an uncategorized picture of all of it, because it looks finished. The first job is completeness: every account that holds or moves your money should be represented, including the ones you would rather not look at.",
          "Completeness is also what makes the rest cheap. Once every account is present, categorization becomes something you do once and then maintain in minutes a month, rather than an archaeology project you restart every time you remember another card.",
        ],
      },
      {
        heading: "Make the records true before you make them tidy",
        paragraphs: [
          "A record is true when it matches what actually happened. That sounds obvious, but two things quietly break it: duplicates, and transfers counted as spending.",
          "Transfers are the more expensive mistake. Moving money from checking to savings is not spending, and paying a credit card from a bank account is not a new expense — the expense already happened when you used the card. If those movements are recorded as income and expense, your totals inflate on both sides, and every ratio built on them is wrong.",
        ],
        bullets: [
          "One record per real event, not one per account it touched.",
          "Money moving between your own accounts is a transfer, never income or expense.",
          "A credit card payment is a transfer. The spending was the purchases on the card.",
        ],
      },
      {
        heading: "Then ask questions",
        paragraphs: [
          "Only once the records are complete and true is it worth asking what they mean. This is the order everything else in Countorra assumes: accounts, then transactions, then the analysis and the tax year built on top of them.",
          "In Countorra, bank, credit card and other institutional accounts arrive by connecting the institution rather than being typed in, so the ledger matches the bank by construction. Cash and wallet accounts are the exception and can be added by hand, because nothing is going to sync physical cash for you.",
        ],
      },
    ],
  },
  {
    slug: "understand-your-monthly-cash-flow",
    title: "How to understand your monthly cash flow",
    summary: "Income minus expenses is the headline. The useful part is which of those numbers is volatile, and why.",
    category: "Foundations",
    related: ["build-a-personal-budget", "calculate-your-net-worth"],
    sections: [
      {
        heading: "The number, and what it hides",
        paragraphs: [
          "Cash flow is what came in minus what went out over a period. A positive month means you ended with more than you started; a negative month means the difference came from savings or from credit.",
          "The single number hides the thing you most need to know, which is stability. Two people can both average a few hundred a month positive: one is positive every month, the other alternates between a large surplus and a large shortfall. The second is far more fragile, and only a month-by-month view shows it.",
        ],
      },
      {
        heading: "Separate the three kinds of outflow",
        paragraphs: ["Most spending falls into three groups that behave completely differently, and mixing them is why budgets feel unpredictable."],
        bullets: [
          "Fixed and recurring — rent, insurance, subscriptions. Predictable, and the easiest to cut permanently rather than repeatedly.",
          "Variable but constant — groceries, fuel, everyday spending. The amount moves; the presence does not.",
          "Irregular — an annual renewal, a repair, travel. Individually surprising, collectively predictable if you look across a year rather than a month.",
        ],
      },
      {
        heading: "Why a bad month is usually an irregular month",
        paragraphs: [
          "When a month looks unusually bad, the cause is far more often a few large irregular charges than a general loss of discipline. The remedy differs for each: irregular costs need to be anticipated and spread, while a genuine drift in everyday spending needs a change in habit.",
          "Countorra detects recurring charges and shows spending against your own recent average, which is what makes that distinction visible rather than a matter of memory. Treat the comparison as a prompt to look, not as a verdict — a month can be above average for an entirely good reason.",
        ],
      },
    ],
  },
  {
    slug: "build-a-personal-budget",
    title: "How to build a personal budget",
    summary: "Build the budget from what you actually spent, in the categories your own money already falls into.",
    category: "Foundations",
    related: ["understand-your-monthly-cash-flow", "organize-your-personal-finances"],
    sections: [
      {
        heading: "Start from evidence, not intention",
        paragraphs: [
          "Most budgets fail in the first month because they were written as a wish. A budget built from three months of your own history starts approximately right, and being approximately right is what keeps you using it.",
          "So begin by reading what you already spent, by category, for the last two or three months. The categories you need are the ones your money already falls into — not a standard list borrowed from someone whose life is shaped differently.",
        ],
      },
      {
        heading: "Budget the irregular costs first",
        paragraphs: [
          "The costs that break budgets are the ones that do not arrive monthly: an annual insurance premium, a renewal, a holiday, a repair you know is coming. Total them for a year, divide by twelve, and treat that as a fixed monthly line even in the months when nothing is due.",
          "Do the same with recurring subscriptions, which are individually small and collectively not. Seeing them as one annual figure is usually the moment a few of them get cancelled.",
        ],
      },
      {
        heading: "Keep it coarse enough to survive",
        paragraphs: [
          "A budget with thirty lines requires thirty decisions a month and will be abandoned. Six to ten categories is usually enough to change behaviour, because the point is not precision — it is noticing, early, when a category is running ahead of where it should be.",
          "Countorra does not hold budget targets for you today. What it does have is the input that makes a budget realistic: categorized history, detected recurring charges, and spending compared against your own average. Build the budget from those, and keep the targets wherever you already keep plans.",
        ],
      },
    ],
  },
  {
    slug: "calculate-your-net-worth",
    title: "How to calculate your net worth",
    summary: "Everything you own minus everything you owe — one number, whose direction matters far more than its size.",
    category: "Foundations",
    related: ["understand-your-monthly-cash-flow", "how-connected-accounts-work"],
    sections: [
      {
        heading: "The calculation",
        paragraphs: [
          "Add up what you own: cash and bank balances, investments, retirement accounts, and the realistic resale value of anything substantial like a property or a vehicle. Then subtract what you owe: credit card balances, loans, and any remaining mortgage.",
          "The result can be negative, and for anyone early in a mortgage or carrying student debt that is both common and not in itself alarming. A single reading says very little. The same number taken every few months says a great deal, because the direction of travel is the actual signal.",
        ],
      },
      {
        heading: "Be conservative about what you own",
        paragraphs: [
          "Net worth becomes useless the moment it is flattered. Value assets at what you could actually sell them for, not what you paid or what you hope. Illiquid things — a car, a property — should be marked cautiously, and personal possessions are generally best left out entirely.",
          "Debt, by contrast, should be counted in full and at its current balance, including anything on a card that you intend to clear this month.",
        ],
      },
      {
        heading: "In Countorra",
        paragraphs: [
          "Countorra computes net worth from the balances of the accounts in your workspace, treating credit cards and loans as what you owe. Accounts connected to an institution keep their balances current on their own; anything outside Countorra is outside the figure.",
          "That last point is the one to remember. If a retirement account or a mortgage is not represented in the workspace, the number is a partial one — and it is worth knowing in which direction it is partial.",
        ],
      },
    ],
  },
  {
    slug: "how-connected-accounts-work",
    title: "How connected bank accounts work in Countorra",
    summary: "What happens when you connect an institution, what Countorra receives, and what it never receives.",
    category: "Your accounts",
    related: ["review-imported-transactions", "organize-your-personal-finances"],
    sections: [
      {
        heading: "What happens when you connect",
        paragraphs: [
          "Connecting an institution opens Plaid, which handles the sign-in with your bank directly. Countorra never receives or stores your bank username or password — what comes back from that exchange is an access token, which is encrypted before it is stored and is only ever used from the server.",
          "Once connected, Countorra imports the accounts at that institution and then their transactions. The first import brings history across in stages, so an account can keep gaining older transactions for a short while after it first appears. After that, syncing is incremental: each run asks only for what changed.",
        ],
      },
      {
        heading: "What comes across, and what does not",
        paragraphs: [
          "Countorra requests transaction data. It receives the account name and type, the last four digits of the account number, balances, and the transactions themselves — date, amount, and the description the institution supplies.",
          "It does not receive your full account number, your bank credentials, or products it has not asked for. Some banks require you to re-authorize a connection periodically; when that happens the connection reports that it needs attention rather than silently going stale.",
        ],
      },
      {
        heading: "Why you cannot type a bank account in by hand",
        paragraphs: [
          "Bank, credit card and other institutional accounts are created by connecting the institution, not by being entered manually. This is deliberate: a hand-made bank account drifts from the real one immediately, and a ledger that disagrees with the bank is worse than no ledger, because it is trusted.",
          "Cash and wallet accounts are the exception and can be added and recorded by hand. Accounts that were entered by hand before this rule existed keep working and remain editable.",
        ],
      },
    ],
  },
  {
    slug: "review-imported-transactions",
    title: "How to review imported transactions",
    summary: "A short, repeatable pass that keeps an imported ledger honest: transfers, then duplicates, then categories.",
    category: "Your accounts",
    related: ["how-connected-accounts-work", "understand-your-monthly-cash-flow"],
    sections: [
      {
        heading: "Find the transfers first",
        paragraphs: [
          "The highest-value thing you can do in a review pass is to identify movements between your own accounts. A payment from checking to a credit card, or a move into savings, is neither spending nor income. Left misclassified, each one inflates both your income and your expense totals, and every ratio built on them.",
          "This matters most in exactly the case that is most common: paying a card you also have connected. The purchases on the card are the expense. The payment is the transfer.",
        ],
      },
      {
        heading: "Then look for duplicates",
        paragraphs: [
          "Duplicates usually appear for a structural reason rather than at random: the same account connected twice through two institutions, or a period of history that was also entered by hand before the account was connected.",
          "Countorra matches on the institution's own identifier for a transaction, so re-running a sync does not create second copies of anything it has already seen. The duplicates worth hunting are the ones that came from two different sources describing the same event.",
        ],
      },
      {
        heading: "Categorize last, and coarsely",
        paragraphs: [
          "Categorization is worth doing after the ledger is structurally correct, because recategorizing a duplicate is wasted effort. Keep the set of categories small enough that the choice is obvious; ambiguity between two similar categories costs more than it ever returns.",
          "The assistant can categorize a transaction for you, but anything that changes a record waits for you to approve it. That is a fixed rule in Countorra, not a setting — a proposal is shown, and nothing is written until you confirm it.",
        ],
      },
    ],
  },
  {
    slug: "prepare-for-tax-season",
    title: "How to prepare your financial information for tax season",
    summary: "Most of the work is gathering and organizing, and almost all of it can be done before the forms arrive.",
    category: "Taxes",
    taxNotice: true,
    related: ["before-you-speak-to-a-tax-professional", "federal-and-state-income-tax"],
    sections: [
      {
        heading: "Organize during the year, not in April",
        paragraphs: [
          "Almost everything that makes tax season painful is reconstruction: working out months later what a payment was for, or which account something came from. The work is far cheaper done as it happens, and the records are far more accurate.",
          "Countorra organizes your tax year as you go rather than producing it at the end. Uploading a document when it arrives, and keeping transactions categorized, is most of the preparation.",
        ],
      },
      {
        heading: "What to gather",
        paragraphs: ["The specific forms depend on your situation, but the categories are stable from year to year."],
        bullets: [
          "Income documents — employment, interest, dividends, and any other income you received.",
          "Your filing status, and details of anyone you are claiming as a dependent.",
          "Records for anything you intend to deduct, if you itemize.",
          "Evidence of tax already paid: withholding, and any estimated payments you made.",
        ],
      },
      {
        heading: "What Countorra does, and does not do",
        paragraphs: [
          "Countorra organizes your tax information and produces an estimate and a summary you can export. It does not prepare returns, does not e-file, does not submit anything to the IRS or any state, and does not provide a professional review.",
          "The estimate has limits, and it lists them alongside every figure. It always uses the standard deduction, so itemized deductions are not modelled; it does not model tax credits; and it does not account for withholding or estimated payments you have already made. Read that list before you rely on a number.",
          "Documents you upload are read for their text where they have a text layer, and any values found are shown to you as proposals. Nothing extracted from a document enters your tax information until you confirm it.",
        ],
      },
    ],
  },
  {
    slug: "federal-and-state-income-tax",
    title: "Federal and state personal income tax",
    summary: "Two separate systems, two separate calculations — and in some states, only one of them applies.",
    category: "Taxes",
    taxNotice: true,
    related: ["prepare-for-tax-season", "before-you-speak-to-a-tax-professional"],
    sections: [
      {
        heading: "Two systems, not one",
        paragraphs: [
          "Federal income tax is administered by the IRS and applies wherever in the United States you live. State income tax is separate: its own rules, its own brackets, its own return, decided by the state you are a resident of.",
          "They are calculated independently, which is why a change in your income can move the two figures by quite different amounts, and why living in a state with no income tax does not reduce your federal bill at all.",
        ],
      },
      {
        heading: "Residence is what selects the state rules",
        paragraphs: [
          `Countorra supports ${SUPPORTED_STATES_SENTENCE}. Your workspace records the state you live in, and that is what selects which state rules are used — it is read from your workspace on the server every time a figure is produced, never guessed and never taken from the page you are looking at.`,
          `Of those states, ${sentenceList(NO_INCOME_TAX)} levy no individual income tax, so the state figure is zero and only the federal calculation applies. ${sentenceList(
            WITH_INCOME_TAX.map((state) => `${state.name} uses ${state.individualReturn}`),
          )}.`,
        ],
      },
      {
        heading: "What the estimate covers",
        paragraphs: [
          "Countorra estimates 2026 US individual income tax from the information you enter or confirm. It is an estimate, and it is explicit about its boundaries rather than quietly approximate.",
          "New York figures cover New York State only — not New York City, Yonkers, or the MCTMT. No other state and no local tax is covered, and no non-US tax system is covered at all. Every result lists what it does not include; that list is part of the answer, not a footnote to it.",
        ],
      },
    ],
  },
  {
    slug: "before-you-speak-to-a-tax-professional",
    title: "How to prepare before speaking with a tax professional",
    summary: "Arrive with organized records and a written list of questions, and the conversation is worth far more.",
    category: "Taxes",
    taxNotice: true,
    related: ["prepare-for-tax-season", "federal-and-state-income-tax"],
    sections: [
      {
        heading: "Bring records, not a shoebox",
        paragraphs: [
          "A professional's time is largely spent either advising or reconstructing, and you control which. Arriving with income documents gathered, transactions categorized, and the year's activity in one place converts hours of reconstruction into advice.",
          "Countorra can export a summary of your tax information, which is a reasonable starting point for that conversation. Bring the underlying documents too — a summary is a description of your records, not a substitute for them.",
        ],
      },
      {
        heading: "Write the questions down beforehand",
        paragraphs: [
          "The questions worth asking are usually the ones you thought of in the weeks before, not during the meeting. Keep a running list as things come up: a change in circumstances, an unusual transaction, something you were unsure how to treat.",
          "Be specific about what changed this year — moving, a change in employment or income, a property transaction, a new dependent. These are the facts most likely to change the answer, and the ones most easily forgotten in the moment.",
        ],
      },
      {
        heading: "Be clear about what any estimate is",
        paragraphs: [
          "If you bring a figure from Countorra, bring its limits with it. The estimate always uses the standard deduction, does not model tax credits, and does not account for payments already made — so a professional's number can differ from it substantially and legitimately.",
          "Countorra is software for organizing your own financial information. It is not a tax preparer, an accounting firm or a law firm, and nothing in it is a substitute for advice about your particular circumstances.",
        ],
      },
    ],
  },
  {
    slug: "using-an-ai-financial-assistant",
    title: "How to use an AI financial assistant responsibly",
    summary: "Useful for reading your own records and explaining what changed. Not a source of authority about your money.",
    category: "Using Countorra",
    related: ["review-imported-transactions", "organize-your-personal-finances"],
    sections: [
      {
        heading: "What it is good at",
        paragraphs: [
          "An assistant that can read your own records is genuinely useful for questions that would otherwise mean building a spreadsheet: what a category totalled this year, what changed between two months, which recurring charges you are carrying, what a figure consists of.",
          "The quality of every one of those answers depends entirely on the records underneath. An assistant reading an incomplete ledger will answer confidently and wrongly, which is a good reason to get the records right first.",
        ],
      },
      {
        heading: "Where the numbers actually come from",
        paragraphs: [
          "In Countorra, the financial and tax calculations the assistant presents are produced by the product's own calculation code, not by the language model. The model decides what to ask for and how to describe it; it does not do the arithmetic.",
          "That distinction tells you what kind of error to look for. A number is unlikely to be invented. A description of what that number means can still be wrong, incomplete, or answering a slightly different question than the one you asked.",
        ],
      },
      {
        heading: "Nothing changes without your approval",
        paragraphs: [
          "Anything the assistant proposes that would create, change or delete a record waits for explicit approval from someone with permission to make that change. Reads and reports run immediately; writes never do.",
          "Treat each of those prompts as a real decision rather than a formality. The confirmation step is the point at which a proposal becomes your record.",
        ],
      },
      {
        heading: "What it is not",
        paragraphs: [
          "The assistant's explanations and suggestions are not authoritative, and they are not professional financial, tax, legal or accounting advice. For anything consequential — a filing decision, a large purchase, a change in how you are taxed — verify independently and speak to someone qualified.",
        ],
      },
    ],
  },
];

/** Reading time, computed from the text so it can never be stale or invented. */
export function readingMinutes(guide: Guide): number {
  const words = [guide.summary, ...guide.sections.flatMap((section) => [section.heading, ...section.paragraphs, ...(section.bullets ?? [])])]
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
  // Ceil, not round: 290 words is a two-minute read, and rounding it down
  // to "1 min" reads as a stub rather than as an estimate.
  return Math.max(1, Math.ceil(words / 200));
}

export function guideBySlug(slug: string): Guide | undefined {
  return GUIDES.find((guide) => guide.slug === slug);
}

export function guidesInCategory(category: GuideCategory): Guide[] {
  return GUIDES.filter((guide) => guide.category === category);
}

/** The one wording used on every tax guide, so it cannot drift between them. */
export const TAX_NOTICE =
  "This guide is general information about how these systems work, not advice about your particular circumstances. Countorra does not prepare or file tax returns, and nothing here is a substitute for a qualified tax professional.";
