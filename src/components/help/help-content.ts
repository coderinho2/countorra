/**
 * The Countorra Help Centre, as data.
 *
 * One source for the page (src/app/help/page.tsx) and for its search
 * (help-search.tsx), so the two can never disagree.
 *
 * EVERY STATEMENT HERE DESCRIBES THE PRODUCT AS IT IS IN THIS REPOSITORY.
 * Written against the code, not the roadmap: where a feature is limited or
 * not built yet, the article says so. When the product changes, change the
 * article in the same commit. Where the code lives, for the claims most
 * likely to drift:
 *
 *   plans and limits      src/domain/billing/entitlements.ts
 *   assistant tools       src/domain/ai/tools/registry.ts
 *   who can do what       src/domain/organizations/permissions.ts
 *   workspace navigation  src/components/app-shell/nav-items.ts
 *   tax rule sets         src/domain/tax/rules/registry.ts
 *   sign-in methods       src/server/auth/actions.ts (email + password only)
 *   bank connections      PLAID-INTEGRATION.md
 */

export const SUPPORT_EMAIL = "support@countorra.com";
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;

export interface HelpLink {
  label: string;
  href: string;
}

export interface HelpArticle {
  /** Anchor id on /help. Stable: links and search results point at it. */
  id: string;
  title: string;
  /** One sentence. Shown in search results and used for ranking. */
  summary: string;
  body: string[];
  points?: string[];
  /** Where this lives inside a workspace, e.g. "Settings → Security". */
  where?: string;
  /** Extra words people search with that the text itself may not use. */
  keywords?: string[];
  links?: HelpLink[];
}

export interface HelpCategory {
  id: string;
  title: string;
  description: string;
  articles: HelpArticle[];
}

export interface HelpFaq {
  id: string;
  question: string;
  answer: string[];
  points?: string[];
  keywords?: string[];
}

export const HELP_CATEGORIES: HelpCategory[] = [
  {
    id: "getting-started",
    title: "Getting started",
    description: "What Countorra is, creating an account, and your first workspace.",
    articles: [
      {
        id: "what-is-countorra",
        title: "What is Countorra?",
        summary: "A financial workspace for your own records, with an AI assistant that answers questions from them.",
        body: [
          "Countorra is an AI-powered personal finance and personal tax platform. You keep your accounts, income and expenses in it, and Countorra turns those records into an overview, reports, insights and preparation for your personal tax return.",
          "Built into it is Ask Countorra, an assistant that answers questions about your money from those same records. Its figures are calculated by Countorra's calculation engine rather than estimated by the AI, and anything it would change in your books waits for your confirmation.",
          "Countorra is software. It is not professional financial, tax, legal or accounting advice, it does not file tax returns, and it never moves money.",
        ],
        keywords: ["about", "overview", "introduction", "accounting", "app"],
      },
      {
        id: "creating-your-account",
        title: "Creating your account",
        summary: "Sign up with your name, email address and a password, then confirm your email.",
        body: [
          "Choose Get started and enter your first name, last name, email address and a password of at least 8 characters, then agree to the Terms of Service and Privacy Policy.",
          "Countorra then sends a confirmation link to your email address. Your account becomes active once you open it — see Verifying your email address.",
        ],
        keywords: ["sign up", "signup", "register", "new account", "get started"],
        links: [{ label: "Create an account", href: "/signup" }],
      },
      {
        id: "your-personal-workspace",
        title: "Your personal workspace",
        summary: "Countorra is built for personal finances: one person's or one household's money and personal taxes.",
        body: [
          "Every Countorra workspace is a personal one. It holds your own accounts, spending and income, the reports and insights built from them, and the preparation of your personal tax return.",
          "Workspaces for freelancers and businesses — with invoices, customers and business books — are not part of Countorra yet. If you have side income, it still belongs on your personal return, and tax preparation includes it.",
        ],
        keywords: ["personal", "workspace", "individual", "household", "freelancer", "business", "self-employed", "entity", "onboarding"],
      },
      {
        id: "setting-up-your-workspace",
        title: "Setting up your workspace",
        summary: "Name the workspace, connect your bank, and check the details tax preparation relies on.",
        body: [
          "Onboarding asks two things: what to call your workspace, and which state you live in — California, Texas, Arizona, Florida or New York. Your state selects the state tax rules Countorra uses. After that, a useful order is:",
        ],
        points: [
          "Connect your bank (Premium and Business) so your bank and credit card accounts, and their transactions, come straight from it — they can't be typed in by hand.",
          "Add cash or a wallet you track yourself as a cash account, with its opening balance, and record its transactions by hand.",
          "Review the starter categories in Settings → Categories so reports group spending the way you think about it.",
          "Check your state in Settings → Workspace; you can change it there at any time. Tax preparation reads the state from here every time it calculates.",
        ],
        where: "Accounts · Settings → Workspace · Settings → Categories",
        keywords: ["setup", "onboarding", "first steps", "opening balance", "configure"],
      },
      {
        id: "workspaces",
        title: "Working with more than one workspace",
        summary: "Each workspace is a separate set of books with its own members and plan.",
        body: [
          "A workspace holds one person's or one household's finances. Its data is never visible from another workspace, and each has its own members and its own plan.",
          "To add one, open the workspace switcher and choose New workspace. How many workspaces you can have depends on your plan: one on Free, three on Premium, and unlimited on Business.",
        ],
        where: "Workspace switcher → New workspace",
        keywords: ["organization", "organisations", "multiple", "switch", "household", "new workspace"],
      },
      {
        id: "the-overview",
        title: "Understanding the Overview",
        summary: "Your position, what needs attention, cash flow, where your money went and financial health.",
        body: [
          "The Overview is the first page of every workspace. It shows your current position across accounts, the items that need your attention, income against expenses by month, your top spending categories this month, and a financial health score built from weighted, explained factors.",
          "Every figure on it is calculated from the transactions in the workspace, so it is only as complete as your records.",
        ],
        where: "Overview",
        keywords: ["dashboard", "home", "summary", "position", "cash flow", "financial health", "score"],
      },
    ],
  },
  {
    id: "using-countorra",
    title: "Using Countorra",
    description: "The assistant, your records, invoicing, reports, insights and documents.",
    articles: [
      {
        id: "ask-countorra",
        title: "Ask Countorra",
        summary: "Ask questions about your finances in plain language and get answers from your own records.",
        body: [
          "Ask Countorra appears in the app as “Ask your money”. Ask a question in your own words — “how much did I spend on software this quarter?” — and it answers from the records in this workspace. Balances, totals, profit, margins and comparisons are calculated by Countorra's calculation engine; the assistant chooses what to calculate, not the result.",
          "It can also propose changes: categorising a transaction, recording a transaction or expense, or suggesting a tax figure. None of these happens until someone with permission confirms it. It cannot delete anything, connect banks or move money.",
          "Each plan includes a number of AI requests per day, counted over the last 24 hours. Settings → Plan & usage shows how many you have used.",
        ],
        where: "Ask your money",
        keywords: ["ai", "assistant", "chat", "ai accountant", "question", "ask your money", "limit"],
      },
      {
        id: "transactions",
        title: "Transactions",
        summary: "Every income and expense entry in the workspace, searchable and categorised.",
        body: [
          "Transactions are the records everything else is calculated from. Each belongs to an account and is either income or an expense.",
        ],
        points: [
          "Add a transaction by hand, or import them from a connected bank.",
          "Categorise one transaction, or several at once.",
          "Mark transactions as reviewed once you have checked them.",
          "Delete a transaction you entered by mistake. Owners, admins and accountants can delete; other roles cannot.",
        ],
        where: "Transactions",
        keywords: ["transaction", "categorize", "categorise", "entries", "ledger", "record"],
      },
      {
        id: "income-and-expenses",
        title: "Income and expenses",
        summary: "Both are kinds of transaction; totals appear on the Overview, in reports and in the assistant.",
        body: [
          "Countorra does not keep income and expenses in separate places. Each transaction is recorded as one or the other, so both live in Transactions.",
          "Totals are shown on the Overview, in Reports, and by Ask Countorra, which can total income or expenses for any date range and compare one period with another. Figures are on a cash basis: they count transactions when they happen.",
        ],
        keywords: ["income", "expenses", "spending", "earnings", "revenue", "costs", "profit"],
      },
      {
        id: "accounts",
        title: "Accounts",
        summary: "Bank accounts, cash, credit cards and wallets, each with a balance.",
        body: [
          "An account is anywhere money is kept: a bank account, a credit card, cash or a wallet. Its balance is its opening balance plus every transaction in it.",
          "Bank and credit card accounts and their transactions come from connecting your bank, so they can't be added or entered by hand. Cash and wallet accounts are the ones you add and fill in yourself. Accounts you entered by hand before stay, with their history, and can be connected to your bank so new transactions arrive from it.",
          "An account you no longer use can be archived.",
        ],
        where: "Accounts",
        keywords: ["account", "balance", "bank account", "credit card", "cash", "archive"],
      },
      {
        id: "reports",
        title: "Reports",
        summary: "Income and spending for any period: what came in, where it went, and what was left.",
        body: [
          "Reports show a statement for the date range you choose: income, then expenses by category, then the net — what you saved, or how much you spent beyond what came in — and your savings rate.",
          "Ask Countorra can prepare the same statement, and compare one period with another.",
        ],
        where: "Reports",
        keywords: ["report", "statement", "income and spending", "savings rate", "net", "financial reports"],
      },
      {
        id: "insights",
        title: "Insights and recurring commitments",
        summary: "What Countorra noticed in your books, and the charges it can see repeating.",
        body: [
          "Insights lists what Countorra has noticed in your records. Recurring commitments are charges that repeat on a predictable schedule — subscriptions, rent, utilities — detected from your transaction history, each with a confidence level.",
          "Detection needs history: once a workspace has a few months of transactions, likely subscriptions and recurring bills start to appear. Ask Countorra can also flag possibly unusual transactions from the last 30 days, such as unusually large amounts, new merchants or possible duplicates.",
        ],
        where: "Insights",
        keywords: ["insight", "subscriptions", "recurring", "anomalies", "unusual", "duplicates"],
      },
      {
        id: "forecasts",
        title: "Forecasts",
        summary: "Cash-flow projections are available through Ask Countorra, always labelled as projections.",
        body: [
          "There is no separate forecast page. Ask Countorra can project your cash balance forward from recent trends and the recurring payments it knows about — ask something like “what will my balance look like at the end of next month?”.",
          "Every point in a forecast is labelled actual or projected. A projection is an estimate from your history, not a prediction Countorra can guarantee.",
        ],
        where: "Ask your money",
        keywords: ["forecast", "forecasting", "projection", "future balance", "cash flow forecast", "predict"],
      },
      {
        id: "documents",
        title: "Documents",
        summary: "Keep receipts, bills, statements and tax forms with your records.",
        body: [
          "Upload PDF, PNG, JPEG or WEBP files of up to 20 MB. Documents are stored privately in the workspace.",
          "Countorra can read the figures in PDFs that contain real text, such as a W-2 downloaded from a payroll provider. What it reads is shown with where it found it, and reaches tax preparation only as a suggestion you confirm.",
          "Scanned PDFs and photos are stored but not read: text recognition (OCR) is not available yet, and is marked coming soon on the pricing page.",
        ],
        where: "Documents",
        keywords: ["document", "upload", "receipt", "w-2", "w2", "ocr", "scan", "pdf", "files"],
      },
    ],
  },
  {
    id: "connections-and-data",
    title: "Connections & data",
    description: "Connecting a bank through Plaid, how imports work, and your data.",
    articles: [
      {
        id: "connecting-a-bank",
        title: "Connecting a bank through Plaid",
        summary: "On Premium and Business, connect a bank and its checking, savings and credit card accounts arrive in Countorra with their transactions.",
        body: [
          "Bank connections are part of the Premium and Business plans. Choose Connect a bank and Plaid opens: you pick your bank and sign in there. Countorra never sees or stores your bank username or password.",
          "When the connection is made, Countorra creates an account for each checking, savings and credit card account at that bank, brings in its posted transactions, and keeps its balance equal to what your bank reports. Pending transactions appear once they post, never twice.",
          "Loans, investment and retirement accounts, and other account types are listed but not imported yet. If you already kept an account by hand, Countorra asks whether to continue it — matching your entries instead of adding them twice — or import the bank account as a new one.",
          "You can connect several banks. If a bank asks you to sign in again, the account shows Needs sign-in with a Reconnect bank link; your accounts and history stay as they are. If bank connections are not available on your plan, the Bank connections page says so — cash you track yourself can still be recorded by hand.",
        ],
        where: "Bank connections",
        keywords: ["plaid", "bank", "connect bank", "link bank", "import", "automatic", "sync"],
        links: [{ label: "Compare plans", href: "/pricing" }],
      },
      {
        id: "how-bank-imports-work",
        title: "How bank imports work",
        summary: "Imported transactions are matched against yours, and nothing is overwritten without you.",
        body: [
          "Imported transactions go into the account you chose, kept apart from the ones you recorded by hand. Countorra checks each against your own entries. Where one might already be in your books, it waits for you to decide: import it as a new transaction, or don't import it.",
          "A connection can be connected, need you to sign in to your bank again, or be disconnected. If it needs signing in again, Plaid opens so you can do that.",
        ],
        where: "Bank connections",
        keywords: ["sync", "syncing", "duplicates", "review", "needs review", "sign in again", "reconnect"],
      },
      {
        id: "disconnecting-a-bank",
        title: "Disconnecting a bank",
        summary: "Stop importing from a bank at any time; the transactions already in your books stay.",
        body: [
          "Owners and admins can disconnect a bank from the Bank connections page. Countorra stops importing from it. Transactions that were already imported stay in your books.",
        ],
        where: "Bank connections",
        keywords: ["disconnect", "remove bank", "unlink", "stop sync"],
      },
      {
        id: "your-data",
        title: "Your data",
        summary: "What stays in your workspace, what is recorded, and how to remove it.",
        body: [
          "Your financial records stay in your workspace and are visible only to its members. Changes to financial records are also written to an audit log that cannot be edited or erased.",
          "When you use Ask Countorra, your question and the records needed to answer it are sent to the AI provider, Anthropic, to produce the answer. Countorra does not sell your data or use your financial data to train AI models.",
          "To remove your data, delete your account — see Deleting your account.",
        ],
        keywords: ["data", "export", "privacy", "delete data", "audit", "anthropic", "retention"],
        links: [{ label: "Privacy Policy", href: "/privacy" }],
      },
    ],
  },
  {
    id: "taxes-and-accounting",
    title: "Taxes & accounting",
    description: "Tax preparation, supported jurisdictions, filing readiness and their limits.",
    articles: [
      {
        id: "tax-preparation",
        title: "Tax preparation",
        summary: "Organise a tax year's information and see what the supported tax rules produce from it.",
        body: [
          "Tax preparation gathers a tax year in one place: the taxpayer and filing status, income, deductions and payments, and dependents. Add wages from a W-2, self-employment profit, withholding and similar figures, then see what the supported rules produce.",
          "Only confirmed figures are used in a calculation. Figures suggested by Ask Countorra or read from a document wait for your review. Countorra records whether a tax ID exists, never the number itself, and it does not decide whether someone qualifies for anything.",
        ],
        points: [
          "Results are estimates before credits. Tax credits are not modelled yet.",
          "What needs attention lists every blocker with a way to resolve it.",
        ],
        where: "Tax preparation",
        keywords: ["tax", "taxes", "tax return", "w-2", "estimate", "self-employment tax", "withholding"],
      },
      {
        id: "supported-jurisdictions",
        title: "Supported jurisdictions and tax years",
        summary: "United States only: federal plus California, New York and Arizona income tax, for tax year 2026.",
        body: ["Tax support is limited, and deliberately specific:"],
        points: [
          "Country: the United States only.",
          "Tax year: 2026.",
          "Federal: estimated federal income tax and self-employment tax.",
          "State income tax: California, New York and Arizona. Texas and Florida are recognised as having no state income tax.",
          "Other states and countries: not supported yet.",
        ],
        keywords: ["jurisdiction", "state", "california", "new york", "arizona", "texas", "florida", "federal", "irs", "country", "tax year"],
      },
      {
        id: "tax-filing",
        title: "Tax filing readiness",
        summary: "Check whether a prepared return is ready, lock a reviewed version, and export it — Countorra does not file.",
        body: [
          "Tax filing checks whether your prepared return is ready and lists what is stopping it. You can then create a filing snapshot — an unchangeable record of the version under review — and finalise it. Only owners, admins and accountants can finalise.",
          "Finalising locks that version inside Countorra. It does not file or submit anything to a tax authority. Export the filing package for whoever files the return; exports are preparation summaries, not filing forms.",
        ],
        where: "Tax filing",
        keywords: ["file", "filing", "submit", "irs", "e-file", "finalize", "export", "snapshot"],
      },
      {
        id: "financial-reports-and-tax",
        title: "Financial figures and tax",
        summary: "Reports and the assistant use your recorded transactions, calculated on a cash basis.",
        body: [
          "Income, expenses, profit and margin are calculated from the transactions in your workspace on a cash basis. Sales tax and VAT are not looked up: the assistant can apply a rate you give it, but that arithmetic is not the tax owed.",
        ],
        keywords: ["sales tax", "vat", "cash basis", "accounting", "margin", "profit"],
      },
    ],
  },
  {
    id: "account-and-security",
    title: "Account & security",
    description: "Signing in, email verification, passwords, settings and how your data is protected.",
    articles: [
      {
        id: "signing-in",
        title: "Signing in",
        summary: "Sign in with your email address and password.",
        body: [
          "Countorra accounts use an email address and password. Signing in with Google, Apple or another provider is not available.",
          "After several failed attempts, sign-in is paused for a while to protect the account. If that happens, wait and try again, or reset your password.",
        ],
        keywords: ["login", "log in", "sign in", "google", "apple", "oauth", "locked out", "too many attempts"],
        links: [{ label: "Sign in", href: "/login" }],
      },
      {
        id: "email-verification",
        title: "Verifying your email address",
        summary: "Open the confirmation link Countorra emails you to activate your account.",
        body: [
          "After signing up, open the confirmation link in the email Countorra sends you. Open it in the same browser you signed up in and you are signed in straight away. Opened on another device, it still confirms your address — you just sign in afterwards.",
          "If the email doesn't arrive, check your spam or junk folder. If it still isn't there, write to support.",
        ],
        keywords: ["verify", "verification", "confirm email", "confirmation link", "activate", "email not received"],
      },
      {
        id: "password-reset",
        title: "Resetting or changing your password",
        summary: "Request a reset link from the sign-in page, or change your password from Settings.",
        body: [
          "On the sign-in page choose Forgot password? and enter your email address. Countorra emails a reset link. Each link works once and expires; if yours has, request a new one.",
          "To change your password while signed in, go to Settings → Security. Countorra sends a confirmation link to your email address, and the password does not change until you use it.",
        ],
        where: "Settings → Security",
        keywords: ["forgot password", "reset password", "change password", "reset link", "expired link"],
        links: [{ label: "Reset your password", href: "/forgot-password" }],
      },
      {
        id: "account-settings",
        title: "Account settings",
        summary: "Your profile, the workspace's details, categories, members, plan and security.",
        body: ["Settings has one section for each of these:"],
        points: [
          "Profile — your name, as other members see it.",
          "Workspace — its name, country, state and currency.",
          "Categories — how transactions are grouped in reports and spending breakdowns.",
          "Members — everyone with access to the workspace, and their roles.",
          "Plan & usage — the workspace's plan and today's AI usage.",
          "Security — your password.",
          "Delete account.",
        ],
        where: "Settings",
        keywords: ["settings", "profile", "name", "currency", "categories", "preferences"],
      },
      {
        id: "members-and-roles",
        title: "Members and roles",
        summary: "What owners, admins, accountants, managers, employees and viewers can do.",
        body: ["Every member has a role, and the role decides what they can do. It is enforced by the database itself, not just by the app:"],
        points: [
          "Owner, admin and accountant — read, add, change and delete records.",
          "Manager and employee — read, add and change records, but not delete them.",
          "Viewer — read only.",
          "Owners and admins manage members, billing and bank connections. Owners, admins, accountants and managers can confirm changes proposed by Ask Countorra.",
        ],
        where: "Settings → Members",
        keywords: ["roles", "permissions", "team", "members", "admin", "viewer", "accountant", "access"],
      },
      {
        id: "security",
        title: "How your data is protected",
        summary: "Workspace isolation in the database, private documents, an audit log and encrypted bank access.",
        points: [
          "Every table holding financial data is protected by database rules scoped to workspace membership. One workspace's session cannot read another's data.",
          "Documents are stored privately per workspace, and download links expire within minutes.",
          "Changes to financial records are written to an append-only audit log.",
          "Bank sign-in happens in Plaid's window, and the access key Plaid issues is encrypted before it is stored.",
          "Anything the assistant would change waits for confirmation.",
        ],
        body: ["Protection is built into the database and the server, not only into the interface. The Security page describes each of these in detail:"],
        keywords: ["security", "encryption", "rls", "isolation", "safe", "protection", "audit log"],
        links: [{ label: "Security architecture", href: "/security" }],
      },
      {
        id: "deleting-your-account",
        title: "Deleting your account",
        summary: "Permanently delete your account and every workspace only you use.",
        body: [
          "Settings → Delete account permanently deletes your account and every workspace no one else uses. You will need your password.",
          "Before anything is deleted, Countorra cancels the paid subscription of each of those workspaces and confirms that nothing can be charged again. If that cannot be confirmed, nothing is deleted. Deletion cannot be undone.",
        ],
        where: "Settings → Delete account",
        keywords: ["delete", "close account", "remove account", "cancel account", "erase"],
      },
    ],
  },
  {
    id: "billing",
    title: "Billing",
    description: "The Free, Premium and Business plans, and managing a subscription.",
    articles: [
      {
        id: "plans",
        title: "Free, Premium and Business",
        summary: "What each plan includes, and what is still coming soon.",
        body: ["Plans belong to a workspace, not to a person. Every plan includes Ask Countorra."],
        points: [
          "Free — $0. One workspace, 3 AI requests a day.",
          "Premium — $19 a month. Three workspaces, 100 AI requests a day, and bank connections through Plaid.",
          "Business — $49 a month. Unlimited workspaces, 500 AI requests a day, and bank connections through Plaid.",
          "Document text recognition (OCR), advanced tax tools and priority support are listed on the pricing page as coming soon. They are not available yet on any plan.",
        ],
        keywords: ["price", "pricing", "cost", "free", "premium", "business", "plan", "limits", "how much"],
        links: [{ label: "Compare plans", href: "/pricing" }],
      },
      {
        id: "managing-your-subscription",
        title: "Upgrading and managing a subscription",
        summary: "Upgrade from the pricing page; manage payment and cancellation in Settings → Plan & usage.",
        body: [
          "Choose a plan on the pricing page to upgrade. Payments are handled by Stripe.",
          "Once a workspace has a subscription, owners and admins can use Manage billing in Settings → Plan & usage to open Stripe's billing portal, where the subscription and payment details are managed. The same section shows when the plan renews or ends.",
          "If a payment fails, paid features for that workspace are paused until the payment method is fixed.",
        ],
        where: "Settings → Plan & usage",
        keywords: ["upgrade", "downgrade", "cancel", "subscription", "stripe", "payment", "card", "renew", "invoice history"],
      },
    ],
  },
];

export const HELP_FAQS: HelpFaq[] = [
  {
    id: "what-is-countorra",
    question: "What is Countorra?",
    answer: [
      "Countorra is an AI-powered personal finance and personal tax platform. You keep your accounts, income and expenses in it, and Countorra turns them into an overview of where you stand, reports, insights about your spending, and preparation for your personal tax return.",
      "Ask Countorra, the assistant, answers questions about your finances in plain language, using the records in your workspace.",
    ],
  },
  {
    id: "countorras-role",
    question: "What is Countorra's role?",
    answer: [
      "Countorra organises your financial records and helps you understand them. The assistant can read your records, calculate totals, compare periods, spot recurring charges and unusual transactions, and project your cash flow.",
      "It can also propose changes — categorising a transaction, recording an expense, suggesting a tax figure — but none of them happens until someone with permission confirms it. Its figures are calculated by Countorra's calculation engine, not made up by the AI.",
      "Countorra is software, not an accountant or adviser: it is not professional financial, tax, legal or accounting advice, it does not file tax returns, and it never moves money.",
    ],
    keywords: ["role", "accountant", "advice", "adviser", "what does it do"],
  },
  {
    id: "how-is-countorra-different",
    question: "How is Countorra different from other solutions?",
    answer: ["The difference is in how it works rather than in any single feature:"],
    points: [
      "Answers come from your records. The assistant works from the transactions, accounts and documents in your workspace — not from general knowledge about money.",
      "Numbers are calculated, not generated. Every total, balance and profit figure is computed by a separate, tested calculation engine.",
      "Nothing changes without you. Anything the assistant would add or change is held until a person confirms it; it cannot delete.",
      "Uncertainty is labelled. Forecasts mark each point as actual or projected, recurring charges carry a confidence level, and tax results are stated as estimates before credits.",
      "One set of records. Your accounts, documents, reports and tax preparation all read from the same data, so there is nothing to copy between tools.",
    ],
    keywords: ["compare", "comparison", "competitors", "alternative", "difference", "unique", "why not"],
  },
  {
    id: "why-countorra",
    question: "Why Countorra?",
    answer: [
      "If your finances are spread across bank apps, spreadsheets and a folder of receipts, Countorra puts the records in one place and lets you ask questions of them directly — “what did I spend on software last quarter?”, “which subscriptions went up this year?” — and get an answer calculated from your own data.",
      "It is careful by design: it shows its reasoning, labels estimates as estimates, and waits for you before changing anything. You can start on the Free plan and upgrade a workspace when you need bank connections or more AI requests.",
    ],
    keywords: ["benefits", "value", "why use", "worth it"],
  },
  {
    id: "how-does-countorra-work",
    question: "How does Countorra work?",
    answer: ["From sign-up to your first answer:"],
    points: [
      "Create an account and confirm your email address.",
      "Name your personal workspace and choose the state you live in.",
      "Connect your bank through Plaid on Premium and Business to bring in your accounts and transactions; add cash you track yourself by hand.",
      "Read the Overview, Insights and Reports.",
      "Ask Countorra questions, and confirm any change it proposes.",
      "Prepare your personal tax return for a supported U.S. tax year.",
    ],
    keywords: ["workflow", "steps", "getting started", "how to use", "process"],
  },
  {
    id: "individuals-or-businesses",
    question: "Is Countorra for individuals or businesses?",
    answer: [
      "Individuals. Countorra is a personal finance and personal tax platform: every workspace holds one person's or one household's money. Workspaces for freelancers and businesses — invoicing, customers, business books and business tax returns — are not part of Countorra yet.",
      "If you have side income, it belongs on your personal return, and tax preparation includes it. You can keep more than one personal workspace, up to your plan's limit; each keeps its data separate and has its own plan.",
    ],
    keywords: ["personal", "freelancer", "business", "self-employed", "company", "individual", "entity"],
  },
  {
    id: "what-can-ask-countorra-do",
    question: "What can Ask Countorra do?",
    answer: ["Ask Countorra (“Ask your money” in the app) can:"],
    points: [
      "Summarise balances and this month's income, expenses and profit.",
      "Find transactions from a plain-language description.",
      "Total income, expenses, cash flow, profit and margin for any date range, and compare two periods.",
      "Detect recurring expenses and subscriptions, and flag possibly unusual transactions.",
      "Project your cash balance, with projections labelled as such.",
      "Explain what Countorra read from an uploaded document.",
      "Estimate US federal, self-employment and supported state income tax, and report where your tax preparation and filing readiness stand.",
      "Propose changes — categorise a transaction, record a transaction or expense, suggest a tax figure — each of which waits for confirmation.",
    ],
    keywords: ["ai", "assistant", "chat", "capabilities", "tools", "ask your money", "ai accountant"],
  },
  {
    id: "financial-data",
    question: "How does Countorra handle my financial data?",
    answer: [
      "Your records are kept in your workspace, and database rules scoped to workspace membership stop any other workspace from reading them. What each member can do is set by their role. Documents are stored privately, with download links that expire within minutes, and changes to financial records are written to an audit log that cannot be edited.",
      "When you use Ask Countorra, your question and the records needed to answer it are sent to the AI provider, Anthropic. Countorra does not sell your data or use your financial data to train AI models. The Security and Privacy pages describe all of this in full.",
    ],
    keywords: ["privacy", "security", "safe", "data", "encryption", "anthropic", "who can see"],
  },
  {
    id: "connect-bank-accounts",
    question: "Can I connect my bank accounts?",
    answer: [
      "Yes, on the Premium and Business plans, through Plaid. You sign in to your bank in Plaid's window — Countorra never sees your bank username or password — and choose which Countorra account each bank account feeds.",
      "Imported transactions are checked against the ones you entered, and nothing in your books is overwritten without you. If bank connections are not available on your plan or not yet switched on for the service, the Bank connections page says so, and you can record transactions by hand on any plan.",
    ],
    keywords: ["plaid", "bank", "connect", "link", "import", "sync", "automatic"],
  },
  {
    id: "does-countorra-handle-taxes",
    question: "Does Countorra handle taxes?",
    answer: [
      "It helps you prepare them; it does not file them. Tax support currently covers the United States only, for tax year 2026: estimated federal income tax and self-employment tax, plus state income tax for California, New York and Arizona. Texas and Florida are recognised as having no state income tax. Other states and countries are not supported yet.",
      "Results are estimates before credits, which are not modelled. You can check whether a prepared return is ready, lock a reviewed version, and export a preparation summary for whoever files your return — Countorra does not submit anything to a tax authority, and it is not tax advice.",
    ],
    keywords: ["tax", "taxes", "file", "filing", "irs", "state tax", "return", "w-2", "1099"],
  },
];
