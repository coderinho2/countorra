# Countorra

Financial intelligence for your own records — accounts, transactions, invoices
and documents for individuals, freelancers and businesses, with an AI assistant
that answers from the organization's real data rather than inventing figures.

> **Repository naming.** The npm package, the Supabase project ref
> (`supabase/config.toml`) and this directory are still `accountant-ai` /
> `Accountant-AI`. Those are architectural identifiers: the project ref is what
> the Supabase CLI links the remote database by, and renaming it would break
> that link for no user-visible gain. The product brand is Countorra everywhere
> a person can see it.

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in the values it documents
npm run dev
```

Open http://localhost:3000.

`.env.example` is the reference for every variable, including which are
server-only. Nothing in it is a real credential and nothing real may be
committed to it.

## Commands

| | |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm test` | Unit + RLS suites (Vitest; RLS runs against real Postgres via PGlite) |
| `npm run e2e` | Playwright end-to-end |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

## Architecture

- `DEPLOYMENT.md` — **how to deploy and operate**: environments, every variable,
  Supabase/Plaid/Stripe/DNS setup, worker cron, rollback, rotation, smoke tests
- `ARCHITECTURE.md` — system layout
- `DESIGN.md` — the visual source of truth; read before any UI work
- `CLAUDE.md` — conventions for agents working in this repository
- `SECURITY-AUDIT.md`, `SECURITY-RATE-LIMITING.md`, `SECURITY-LIVE-VERIFICATION.md`
- `PLAID-INTEGRATION.md` — the bank-data provider adapter and its configuration
- `BANK-SYNC-WORKER.md` — how queued bank sync work runs, and what a deployment
  must invoke on a schedule
- `PLAID-SANDBOX-VERIFICATION.md` — the Sandbox live-verification runbook, and
  why it has not been run here

Database migrations live in `supabase/migrations` and are applied with
`npx supabase db push`. RLS is the enforcement boundary; application checks sit
on top of it, never instead of it.

## Billing (Stripe)

Billing is **optional**. With the `STRIPE_*` variables unset the product runs
normally, every workspace is on Free, and the pricing page says
"Billing setup required" rather than offering a purchase that cannot complete.

Setting *some* of them is refused at startup — a deployment that can charge a
card but cannot receive webhooks leaves customers billed and un-upgraded.

### One-time Stripe Dashboard setup (test mode)

1. **Products → add a product** for each paid plan, each with a **recurring
   monthly** price. The amounts must match `PLAN_ENTITLEMENTS` in
   `src/domain/billing/entitlements.ts` — $19 Premium, $49 Business. Nothing
   reconciles these automatically: Stripe charges the card, the canonical
   model decides what the customer gets.
2. Copy each price's **API ID** (`price_…`) into `STRIPE_PREMIUM_PRICE_ID` and
   `STRIPE_BUSINESS_PRICE_ID`.
3. **Developers → API keys** → secret key (`sk_test_…`) into
   `STRIPE_SECRET_KEY`.
4. **Settings → Billing → Customer portal** → activate it, and enable
   "Cancel subscription" and payment-method updates. The portal is where plan
   changes and cancellations happen; the app deliberately does not
   re-implement them.
5. **Developers → Webhooks → add endpoint** → `https://<your-domain>/api/stripe/webhook`,
   subscribed to at least:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`, `invoice.payment_succeeded`, `invoice.paid`.
   Copy its signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.

### Local webhook forwarding

Stripe cannot reach `localhost`, so deliveries are forwarded by the CLI
(https://stripe.com/docs/stripe-cli). In a second terminal:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

It prints its own signing secret (`whsec_…`) — put **that** value in
`.env.local` as `STRIPE_WEBHOOK_SECRET` while forwarding, not the dashboard
endpoint's. Trigger events without paying:

```bash
stripe trigger customer.subscription.updated
```

The automated test suite does **not** require the CLI or any Stripe
credentials: `tests/server/stripe-webhook.test.ts` signs its own payloads with
Stripe's own HMAC helper, so signature verification is exercised for real
offline.

## Tax Engine

Countorra includes **deterministic income tax engines** for US federal,
California, New York State, Florida and Texas, and a registered-but-pending
engine for Arizona. They produce an *estimate* with a full
calculation trace. The engines on their own are **not** tax preparation —
that is the separate layer described under [Tax preparation](#tax-preparation)
below — and nothing in Countorra produces a tax return or files anything.

### What is supported

| | US federal | California | New York State | Florida | Texas |
|---|---|---|---|---|---|
| Tax year | 2026 | 2025, and 2026 under a disclosed fallback | 2026 | 2026 | 2026 |
| Filing status | **All five** — calculated, qualification not determined | Single, Married/RDP Filing Jointly | **All five** | All five (no difference) | All five (no difference) |
| Income | Ordinary income, Schedule C net profit | Federal AGI + supplied CA adjustments | Federal AGI + supplied NY additions/subtractions | Not used | Not used |
| Method | Rate schedule | **Tax Table** at or below $100,000 of taxable income, **Tax Rate Schedule** above it | **Rate schedule** at or below $107,650 of NYAGI, **tax computation worksheet** above it | `NO_INDIVIDUAL_INCOME_TAX` | `NO_INDIVIDUAL_INCOME_TAX` |
| Exemptions | — | — | $1,000 per dependent | — | — |
| Self-employment | SE tax, wage-base cap, $400 threshold, deductible half, Additional Medicare Tax | None — no state SE tax | None — no state SE tax | None | None |
| Surcharge | — | Behavioral Health Services Tax, 1% above $1,000,000 of taxable income | — (the recapture is in the worksheets) | — | — |

Federal calculates all five 2026 filing statuses from the tables and standard
deductions in Rev. Proc. 2025-32 § 4.01 and § 4.14, with the Additional
Medicare Tax threshold for each status from IRS Topic 560.

**Calculating a filing status is not deciding that the taxpayer may use it.**
Head of household and qualifying surviving spouse have qualification tests
that Countorra does not evaluate, and a married person filing separately
cannot take the standard deduction if their spouse itemizes (IRS Topic 551).
So preparation flags head of household and qualifying surviving spouse for
review; filing readiness treats that as `REVIEW_REQUIRED` with **nothing**
finalizable; and for married filing separately Countorra asks whether the
spouse itemizes — unanswered is a review, "yes" blocks calculation, and only
"no" lets the standard deduction stand.

California's 2025 rules cover Single and Married/RDP Filing Jointly only, so a
California calculation under any other status is refused. Every unsupported
combination returns a structured refusal — it is never approximated with a neighbouring year, status
or jurisdiction, and a California request is **never** answered with federal
figures.

#### California 2026: answered with 2025's rules, and told so

As of the date the sources below were read, the Franchise Tax Board had **not
published** the 2026 California rate schedules or standard deduction — its own
2026 Form 540-ES worksheet directs filers to the *2025* tax table and the
*2025* exemption credit, and the deduction that worksheet prints
($5,706 / $11,412) is verifiably the 2025 amount.

A 2026 request is therefore answered using the **latest fully published**
California rules (2025), and the result says so in three places: a
`calculationStatus` of `ESTIMATE_USING_LATEST_PUBLISHED_RULES`, a `fallback`
object naming both years and the exact missing figures, and the first line of
the calculation trace. `requestedTaxYear` (2026) and `taxYear` (2025) are
separate fields, and `ruleSetVersion` pins the rules that actually ran.

What the fallback is **not**:

- Not a copy. `us-ca-2026.ts` still contains no bracket, no standard deduction
  and no tax table, still lists its figures as `pendingPublication`, and a test
  asserts none of the 2025 constants appear in it.
- Not generic. `resolveCaliforniaRuleSet` holds exactly one substitution —
  2026 → 2025 — and it is conditional on 2026's own rule set being marked
  pending. 2027 and every unmodelled historical year are refused outright, and
  no other jurisdiction has a fallback at all.
- Not permanent. The resolver prefers a requested year's own rules whenever
  they exist, so filling in `us-ca-2026.ts` and emptying `pendingPublication`
  switches 2026 over with no code change.

#### The California Tax Table

FTB requires the **Tax Table** for taxable income of $100,000 or less and the
**Tax Rate Schedules** above it, and the two give different answers — so the
engine implements both and reports which ran in `calculationMethod`.

The table is discrete: every income inside a row pays the same whole-dollar
tax. FTB builds each row by applying the rate schedule to the row's
**midpoint** and rounding to a whole dollar, and the interval structure
($1–$50, then $100-wide rows to $100,000, the last one truncated) lives in the
rule set as data, not in the calculation. That construction was verified
against **all 983 rows** recoverable from the published 2025 table — every one
reproduces exactly, in both filing-status columns — and 54 verbatim rows
spanning the range are kept as an executable oracle.

The difference is real: $100,000 of California AGI gives taxable income of
$94,294, which the table prices at **$5,209** (the published figure for row
$94,251–$94,350) where the rate schedule alone would say $5,207.98.

### New York State

`US_NY` covers **New York State** personal income tax for tax year 2026, for
all five filing statuses. Every figure comes from one primary document:
[Form IT-2105-I (2026)](https://www.tax.ny.gov/pdf/2026/inc/it2105i_2026.pdf),
the Department of Taxation and Finance's 2026 estimated-tax instructions —
standard deduction table (page 2), tax computation worksheets 1–16 (pages
3–7), the NYAGI-to-taxable-income path (page 9), and the three rate schedules
(page 10).

**2026 is not 2025, and that matters.** New York enacted rate reductions
effective 1 January 2026. The lower five rates fell from 4.00 / 4.50 / 5.25 /
5.50 / 6.00 to **3.90 / 4.40 / 5.15 / 5.40 / 5.90**, and every published base
amount moved with them. Carrying 2025's schedule forward would have overstated
the tax for essentially every New Yorker. A test asserts the 2025 rates and
bases appear nowhere in the rule set.

**The schedules are applied as New York publishes them.** New York states each
bracket as "$X plus R% of the excess over $T", and those bases are printed
whole dollars — $332 where the exact tax is $331.50. Summing per-bracket
amounts disagrees with the form by up to a dollar at every income, so
`applyPublishedRateSchedule` uses the printed base verbatim. One consequence
is reproduced rather than smoothed away: crossing $13,900 of taxable income
takes the tax *down* 25 cents, because $586.30 exact sits above the printed
$586 base. That is New York's rounding, not ours.

**The high-income worksheets are implemented, not skipped.** Above $107,650 of
New York adjusted gross income, New York recaptures the benefit of the lower
brackets so a high earner pays their top rate on every dollar. It publishes
this as sixteen numbered worksheets — phase-in, recapture, and a flat 10.9%
above $25,000,000 of NYAGI — with thresholds at $5,000,000 and $25,000,000
among others. All sixteen are transcribed as data and applied line by line,
including the fourth-decimal rounding of the phase-in fraction. An engine that
stopped at the brackets would understate a high earner's New York tax by
thousands while looking entirely reasonable.

**Verification.** Two independent oracles, both from the published document:
all 24 base amounts across the three schedules reconcile against their own
rates, and each worksheet's recapture base equals the previous worksheet's
base plus its incremental benefit in all three filing-status groups. A third
check falls out of the design — well above a threshold, the recapture drives
the tax to taxable income × the marginal rate, within New York's own
whole-dollar rounding.

**Fallback policy: none, deliberately.** New York's 2026 figures are
published, so `resolveNewYorkRuleSet` holds an *empty* policy map and answers
2026 with 2026's own rules (`PUBLISHED_RULES`). Every other year — including
2025 and 2027 — is refused rather than answered with the one rule set that
exists. If a future New York year is ever incomplete, it must be registered
with `pendingPublication` *and* given an explicit policy entry; until both are
done it refuses, which is the safe default.

**Known limitations.** New York State tax only. Not covered: New York City
resident tax (which would be registered as its own jurisdiction, never folded
in here), Yonkers, the MCTMT, itemized deductions (IT-196), every New York
credit, nonresident and part-year returns (IT-203), and the New York tax table
that a filed IT-201 uses below $65,000 of taxable income — New York has not
published a 2026 table, and its own 2026 instructions use the rate schedules
at every income, which is what this engine does.

### California State Disability Insurance

SDI is **payroll withholding, not income tax**: charged on wages rather than
taxable income, administered by EDD rather than FTB, and owed even when income
tax is zero. It has its own entry point (`calculateCaliforniaSdi`) and its own
AI tool, and it never appears in any income tax total.

For 2026 the rate is **1.3% with no taxable wage ceiling**. EDD states it
directly: "The SDI withholding rate for 2026 is 1.3 percent. Effective
January 1, 2024, all wages are subject to SDI contributions." The rule set stores the ceiling as `null` so
that its absence is a stated fact rather than a missing value.

### What is deliberately not modelled

Itemized deductions · the QBI deduction (§ 199A) · all tax credits ·
preferential capital-gains rates · AMT · NIIT · the age-65/blind additional
standard deduction · the 2025–2028 tips/overtime/senior/car-loan deductions ·
withholding and estimated payments already made · all state and local tax.

This list travels on **every** result as `notModelled`, because a figure
without it reads as more than it is.

### Florida

`US_FL` covers **Florida individual state income tax** for tax year 2026.
Florida levies none, so the answer is **$0** — and the point of registering
Florida at all is that "we know, and it is zero" is a different answer from
"we don't model this state". Leaving Florida out would have made the two
indistinguishable.

**It is a rule, not an absence.** The rule set carries a positive,
sourced `noIndividualIncomeTax` statement; the engine refuses to report $0
without it. There are **no brackets, no standard deduction and no
filing-status table**, because none exist — modelling Florida as a single 0%
bracket would be a fabricated rate schedule, and a test asserts the string
`rateBasisPoints` appears nowhere in the rule set. The result carries
`calculationMethod: NO_INDIVIDUAL_INCOME_TAX`, never a bracket or table
method, and the trace states the constitutional basis.

**It computes nothing.** No income figure is read, no deduction applied, no
federal figure consulted. Every total is zero — including gross and adjusted
gross income, and the echoed inputs — so the result cannot be mistaken for a
calculation that happened to come out at zero.

**$0 individual income tax is not $0 Florida tax.** Florida corporate
income/franchise tax (Fla. Stat. ch. 220), sales and use tax, documentary
stamp tax, reemployment tax and locally levied property tax are all real and
none are modelled anywhere in Countorra; Florida residents also owe federal
tax in full. `notModelled` names them and travels on every result, and the AI
guidance warns against exactly this conflation.

**Fallback policy: none.** 2026 resolves to Florida's own 2026 rule set; every
other year is refused. Florida's answer would be the same in any year, which
makes "just route every year to 2026" tempting and wrong — a codebase that
silently answers 2031 keeps answering it after the law changes.

**Out of scope:** Florida corporate income/franchise tax, sales and use tax,
documentary stamp tax, reemployment tax, property tax, and any Florida
filing. Countorra does not prepare or file any Florida return.

**A verification caveat worth recording.** Every `floridarevenue.com`,
`flsenate.gov` and `leg.state.fl.us` request failed from the environment this
was written in — DNS failure, connection refused, or blocked navigation — so
the cited documents were **not opened directly**. The conclusion rests on the
Florida Department of Revenue's own publication as indexed by search, plus the
constitutional and statutory citations below, which are long-standing and not
in dispute. Re-verify the citation text against the Department of Revenue site
from an environment that can reach it.

### Texas

`US_TX` covers **Texas individual state income tax** for tax year 2026. Texas
levies none, so the answer is **$0** — reached independently of Florida, not
by aliasing it.

**Texas's basis is its own, and it is recent.** Article VIII, Section 24-a of
the Texas Constitution: *"The legislature may not impose a tax on the net
incomes of individuals, including an individual's share of partnership and
unincorporated association income."* That section was added by **Proposition
4** (H.J.R. 38, 86th Legislature), approved at the election of **5 November
2019**, which repealed the former Section 24 — under which an individual
income tax was *permitted* if approved by the voters. Texas moved from
"permitted subject to referendum" to "prohibited" within living memory, which
is why the rule set dates its basis rather than treating it as timeless, and
why the resolver refuses years nobody has checked.

With no such tax, there is **no Texas individual income tax return to file**.

**Separate from Florida throughout.** Its own rule set, sources, version,
resolver, engine, trace and tests. `us-tx.ts` shares no rule data with
`us-fl.ts` and never delegates to it; tests assert that neither rule set
contains a string from the other. Same number, different law — and either
could change without the other.

**It computes nothing.** No income read, no deduction, no exemption, no
taxable income derived, no bracket consulted, no federal figure touched. The
trace distinguishes all three ways a figure can be zero: *"Zero because of
Texas's constitutional position, not because a calculation was skipped and not
because taxable income came out at zero."*

**$0 individual income tax is not $0 Texas tax.** The Comptroller administers
the franchise tax on business margin, sales and use tax and much else;
property tax is levied by local taxing units; and Texas residents owe federal
tax in full. None of those is modelled anywhere in Countorra. `notModelled`
names them — deliberately **without rates**, since no Texas rate was verified,
and an unverified rate is worse than none.

**Fallback policy: none.** 2026 resolves to Texas's own 2026 rule set; every
other year is refused.

**Out of scope:** Texas franchise tax, sales and use tax, property tax, other
business taxes, federal tax, and any tax filing. This is **not** Texas tax
preparation.

**Source verification caveat.** Every Texas government domain fails DNS
resolution from this environment — `comptroller.texas.gov`,
`statutes.capitol.texas.gov`, `capitol.texas.gov`, `tlc.texas.gov`,
`fmx.cpa.texas.gov`, `star.comptroller.texas.gov`, `www.sos.state.tx.us` and
`texas.gov`, tried with curl, nslookup, WebFetch and a browser. A reachable
federal corroboration was looked for and **not found**: the IRS's Texas page
links to the Comptroller without mentioning an individual income tax, and the
Census Bureau's State Government Tax Collections technical documentation
mentions Texas only for its 31 August fiscal year end. Both Texas sources are
therefore marked `SOURCE_UNVERIFIED_ENVIRONMENT` with no retrieval date.
**Re-verify from an environment that can reach Texas government sites.**

### Arizona — registered, and refusing on purpose

`US_AZ` is registered for tax year 2026 and **does not compute**. That is the
correct answer, not a gap, and the refusal is specific about why.

**What is settled.** The *rate*: A.R.S. § 43-1011(A)(9) sets a flat **2.5% of
taxable income**, with no brackets and no filing-status distinction. That
paragraph is conditional on a revenue-trigger notice under § 43-243, so the
statute alone does not prove it governs 2026 — but the Legislature's own Joint
Legislative Budget Committee does: *"Arizona used a graduated rate structure
through Tax Year (TY) 2022. Beginning in TY 2023, the state imposes a single
tax rate of 2.5% on the taxable income of all filers."* Its summary of
statutory changes through the 2025 session records no later change. Arizona
also starts from **federal adjusted gross income**.

**What is not settled — and why it stops everything.** The **2026 standard
deduction**. § 43-1041(A) states $15,750 / $23,625 / $31,500, which the JLBC
handbook (November 2025) shows as Arizona's *tax year 2025* amounts, and
§ 43-1041(H) leaves the annual inflation adjustment to the Department of
Revenue. azdor.gov is behind bot protection and could not be read. Without a
standard deduction there is no Arizona taxable income, and a rate with nothing
to apply to is not a tax figure.

It is tempting to derive it — the statutory base amounts *are* the 2025
federal standard deductions, indexed by the federal method, so 2026 would very
likely be the 2026 federal figures this codebase has already verified. **That
derivation is not made.** § 43-1041 sets its own amounts and borrows only the
indexing *method*, so deriving them would be this codebase's inference rather
than Arizona's published value.

**No fallback to 2025, deliberately.** California answers 2026 with 2025's
rules because FTB's own 2026 Form 540-ES instructs filers to do exactly that.
**No equivalent Arizona instruction was found**, so `resolve-arizona.ts`
carries an empty fallback policy. A disclosed substitution that no authority
asked for is still one this codebase invented.

**A new-for-2026 rule is already captured.** § 43-1041(I)(2) applies from tax
year 2026 and replaces the old percentage-of-charitable-contributions increase
to the standard deduction with the full amount under IRC § 170(c), capped at
$1,000 (single / married filing separately) and $2,000 (married filing
jointly). The statute names **no head-of-household cap**, and that gap is
listed as pending rather than filled in.

**When it publishes:** fill `filingStatuses` in `us-az-2026.ts` with the 2026
standard deductions and the flat 2.5% bracket, resolve the head-of-household
charitable cap, empty `pendingPublication`, and bump the version to `2026.1`.
The resolver needs no change.

**Major limitations for any future Arizona figure.** It will be **tax before
credits** — Arizona's dependent tax credit and its charitable, foster-care,
public-school and school-tuition-organisation credits are not modelled, and
none is small. Also not modelled: Arizona itemized deductions; the additions
and subtractions of §§ 43-1021/43-1022 (including the subtraction for Social
Security income, which Arizona does not tax, and the military retirement
exemption); the § 43-1023 exemptions; the small business income election
(Form 140-SBI); and nonresident/part-year computations.

**Out of scope:** Arizona transaction privilege tax, use tax, corporate income
tax and property tax. Countorra does not prepare or file any Arizona return.

### Source verification status

Every cited source declares how far it was actually checked, and the codebase
enforces the distinction — `source-integrity.test.ts` fails the build if a
source has no status, if a *verified* source has no retrieval date, if an
*unverified* one carries a date implying somebody read it, if a citation is
too thin to locate a value, if a URL is a moving target, or if any source
outside the pinned exception list is unverified.

| Status | Meaning |
|---|---|
| **VERIFIED** | The document at the URL was opened from this codebase's environment and the cited values were read out of it. `verification: "VERIFIED_PRIMARY_SOURCE"` plus a `retrievedOn` date. |
| **VERIFIED (official secondary)** | Opened and read, and official — but not the taxing authority's own statement of the rule. `verification: "VERIFIED_OFFICIAL_SECONDARY_SOURCE"`. |
| **UNVERIFIED** | The document could not be reached from this environment. `verification: "SOURCE_UNVERIFIED_ENVIRONMENT"`, **no** `retrievedOn`, and a `verificationNote` saying exactly why. The rule may still be correct — the *citation* is what is unconfirmed. |
| **PENDING** | The government has not published the material for the tax year. Expressed as `pendingPublication` on the rule set. Currently: California 2026's rate schedules and standard deduction. |
| **FALLBACK** | The requested year is answered with the latest fully published rule set, disclosed on the result. Currently: California 2026 → California 2025. |

**VERIFIED (16 of 20 sources)** — all federal, California, New York and
Arizona sources. Arizona's two Arizona Revised Statutes citations are primary;
its Joint Legislative Budget Committee handbook is classified
`VERIFIED_OFFICIAL_SECONDARY_SOURCE` — official Arizona government, but
legislative analysts describing the law rather than the Department applying
it, and the distinction is kept in the data. Re-confirmed directly during the source integrity audit, including a
full re-extraction of the FTB tax table PDF in which **983 of 983 published
rows** reproduced exactly in both modelled columns.

**UNVERIFIED (4 of 20 sources)** — the two Florida sources and the two Texas
sources. Florida: `floridarevenue.com` fails DNS resolution,
`www.flsenate.gov` fails DNS resolution, `www.leg.state.fl.us` resolves to
207.126.30.18 and then times out. Texas: every `texas.gov` domain fails DNS
resolution. Both rules (no individual personal income tax) are implemented
because they are independently well established, but the citation text rests
on search-engine indexes rather than on reading the documents. **Re-verify
both from an environment that can reach those states' government sites.**

A search-engine snippet quoting a document does not count as verification, and
neither does a summary produced by a model.

### Authoritative sources

Every figure is transcribed from a primary government source and carries its
citation in the rule set. No blog, aggregator or model recollection is a
source anywhere in this system.

**Federal**

- **IRS Rev. Proc. 2025-32** ([IRB 2025-45](https://www.irs.gov/irb/2025-45_IRB)) — 2026 rate tables and standard deductions
- **[IRS Topic 751](https://www.irs.gov/taxtopics/tc751)** — 2026 Social Security wage base ($184,500)
- **[IRS Topic 554](https://www.irs.gov/taxtopics/tc554)** — self-employment tax mechanics, and the Additional Medicare Tax thresholds by filing status
- **[IRS Topic 560](https://www.irs.gov/taxtopics/tc560)** — the three-step Additional Medicare Tax method, including reducing the threshold by Medicare wages received

**California**

- **[FTB 2025 Personal Income Tax Booklet (Form 540)](https://www.ftb.ca.gov/forms/2025/2025-540-booklet.html)** — the 2025 rate schedules (X and Y), the standard deduction chart, and the Behavioral Health Services Tax at line 62
- **[FTB 2025 California Tax Table](https://www.ftb.ca.gov/forms/2025/2025-540-taxtable.pdf)** — the published table for taxable income of $100,000 or less
- **[FTB 2026 Instructions for Form 540-ES](https://www.ftb.ca.gov/forms/2026/2026-540-es-instructions.html)** — the 2026 Behavioral Health Services Tax, and the direction to use 2025 figures that establishes the 2026 schedules are unpublished
- **[FTB Tax calculator, tables, rates](https://www.ftb.ca.gov/file/personal/tax-calculator-tables-rates.asp)** — the published rate schedules, which end at 2025
- **[EDD Tax-Rated Employers](https://edd.ca.gov/en/payroll_taxes/tax-rated-employers/)** — "The SDI withholding rate for 2026 is 1.3 percent. Effective January 1, 2024, all wages are subject to SDI contributions."

**New York**

- **[Form IT-2105-I (2026)](https://www.tax.ny.gov/pdf/2026/inc/it2105i_2026.pdf)** — the 2026 standard deduction table, the three tax rate schedules, the sixteen tax computation worksheets, and the dependent exemption
- **[Tax rates and tables](https://www.tax.ny.gov/pit/file/tax-tables/)** — establishes that New York's published return tax tables end at 2025, which is why no 2026 tax table is modelled

**Arizona**

- **A.R.S. § 43-1011 (Taxes and tax rates)**, subsection A paragraph 9 — the flat 2.5% of taxable income ([azleg.gov](https://www.azleg.gov/ars/43/01011.01.htm))
- **A.R.S. § 43-1041 (Optional standard deduction)** — subsection A amounts, subsection H inflation adjustment by the Department, and the new subsection I(2) charitable increase applying from tax year 2026 ([azleg.gov](https://www.azleg.gov/ars/43/01041.htm))
- **Arizona Joint Legislative Budget Committee, Tax Handbook 2025** (4 November 2025) — confirms the 2.5% rate is in force from TY 2023, the federal-AGI starting point, and that qualifying surviving spouses take the married-filing-jointly deduction *(official secondary)* ([azjlbc.gov](https://www.azjlbc.gov/revenues/25taxbk.pdf))

**Texas** (cited but not directly retrievable from this environment — see the caveat above)

- **Constitution of the State of Texas, Article VIII, Section 24-a** — the prohibition on a tax on the net incomes of individuals, added by Proposition 4 (H.J.R. 38, 86th Legislature), approved 5 November 2019, repealing the former Section 24 ([statutes.capitol.texas.gov](https://statutes.capitol.texas.gov/Docs/CN/htm/CN.8.htm))
- **Texas Comptroller of Public Accounts — Taxes** — the Comptroller's index of the taxes it administers ([comptroller.texas.gov](https://comptroller.texas.gov/taxes/))

**Florida** (cited but not directly retrievable from this environment — see the caveat above)

- **Florida Department of Revenue, Publication GT-800025, "Tax Information for New Residents"** — "Florida does not impose personal income tax, inheritance tax, gift taxes, or tax on intangible personal property." ([floridarevenue.com](https://floridarevenue.com/Forms_library/current/brochure/gt800025.pdf))
- **Constitution of the State of Florida, Article VII, Section 5** — the bar on a tax upon the income of natural persons, restated in the legislative intent of **Florida Statutes § 220.02**, which also confirms that chapter 220's income tax code applies to corporations rather than natural persons

The bracket tables are **self-checking**, and in two independent ways. Both
the IRS and FTB state each bracket twice — as a rate on the excess over a
threshold *and* as a cumulative base dollar amount — so the rule-set tests run
the real engine at every threshold and compare against the published base. All
sixteen California rows reconcile **to the cent**, which also confirms the
rounding method: FTB's printed bases carry accumulated per-row rounding, and
an exact-rational reconstruction misses the top Schedule X rows by 0.9 and 1.3
cents while the engine's round-each-bracket-then-sum matches exactly. On top
of that, R&TC § 17041 builds the joint schedule by doubling the single one, so
every Schedule Y threshold is checked against twice its Schedule X
counterpart — an oracle needing no external figure at all.

### Versioning and reproducibility

Rules live in versioned data (`src/domain/tax/rules/`), never inside
calculation code. A rule set is stamped `jurisdiction + tax year + version`
(`US_FEDERAL + 2026 + 2026.1`, `US_CA + 2025 + 2025.1`), and every stored
calculation records that stamp — plus the year that was *requested* and
whether the two matched, so a row can never later be read as an authoritative
calculation for a year whose rules had not been published. Federal and state results are stored as
separate rows under their own jurisdictions — they are two liabilities, not
two halves of one. When a figure is corrected the version increments, and an older stored
result keeps its own — a later correction can never silently restate history.

### The AI's role

The assistant supplies **inputs only**: tax year, filing status, income
figures. It cannot supply rates, thresholds or deduction amounts — there is no
parameter for them — and it cannot choose a **jurisdiction**: the country and
the state are read from the organization, so a workspace in Texas cannot be
given California's brackets by asking and one in California cannot escape
them. `tests/server/ai-tax-tool.test.ts` and
`tests/server/ai-california-tax-tool.test.ts` assert that attempts to smuggle
either change nothing. The engine calculates; the AI explains the trace it is
handed.

### Adding a state

A state engine is a new rule set in `src/domain/tax/rules/`, a new engine
module, one line in `register.ts`, and one line in `stateJurisdictionFor`.
The calculation core grows only when a state genuinely computes differently:
California reuses `applyProgressiveBrackets` unmodified, and New York needed
`applyPublishedRateSchedule` and `applyHighIncomeWorksheet` because its
schedule and its recapture are not expressible as a bracket sum. Both
resolvers share one implementation of the no-silent-fallback rule in
`resolve-rule-set.ts`, with a per-jurisdiction policy map.

A workspace is put into a state regime by setting its **State** in
organization settings. It is never inferred: a blank state means no state
engine applies, which is the correct answer for the nine states with no
individual income tax.

## Tax preparation

Tax preparation is the layer **above** the engines: it collects a tax year's
information, checks it, freezes it, hands it to the engines, and reports what
came back together with what is missing and what is not covered.

```
facts, dependents, documents  →  validation + completeness  →  immutable snapshot
                              →  deterministic engines (federal + primary state)
                              →  classified results, issues, not-modelled list  →  preparation package
```

**It is not filing.** There is no return, no e-file, no MeF/XML submission and
no signature anywhere in the product, and the page, the package and the AI
tools all say so. Page: **Tax preparation** in the sidebar
(`/app/[orgId]/tax-preparation`).

### The rules it runs on

- **Only confirmed facts are calculated.** Every figure is a fact with a
  `source` (`USER_ENTERED`, `DOCUMENT`, `AI_PROPOSED`, …) and a `state`
  (`PROPOSED`, `CONFIRMED`, `REJECTED`). A figure a person types is confirmed by
  entering it; anything from somewhere else — including the assistant — starts
  as a proposal and never reaches a snapshot until a person accepts it.
- **Facts are append-only.** Confirming, correcting or rejecting inserts a
  superseding row; nothing is updated or deleted. So an AI proposal and the
  person who accepted it stay separately attributable
  (`supabase/migrations/0042_tax_preparation.sql` has no UPDATE or DELETE
  policy on facts, and a unique index keeps the history a chain rather than a
  tree).
- **Snapshots are immutable, and carry their result.** Calculating freezes the
  confirmed inputs *and* the classified result in one row, and each supported
  jurisdiction result is also stored in `tax_calculations` pointing back at
  it. The page reads the frozen result — it never re-runs the engines on old
  inputs, so a later rule correction cannot restate what someone was shown.
  The database refuses to delete a snapshot a stored calculation depends on.
- **Few things block.** Only: no filing status, an unusable or unsupported tax
  year, no confirmed figures, a validation blocker (e.g. an AI value confirmed
  with no reviewer), or income reported with no figure. Everything else is a
  warning or a note, so the real blockers are not lost in noise.
- **Each state answers for itself.** California 2026 is shown as an
  **estimate** under 2025's published rules; Arizona 2026 as **unavailable**
  with the unpublished figure named (never $0); Florida and Texas as $0
  individual income tax with the caveat that other taxes exist; a state with no
  engine produces no state figure. Only the **primary** state is calculated —
  income is not allocated between states, and additional states are flagged
  for review instead.
- **No refund without payments.** A refund or balance due is stated only when
  withholding or estimated payments were entered; a missing figure is never
  treated as zero.
- **Collected is not calculated.** Rental income, dividends, itemized
  deductions and similar are recorded and listed under *not included*; no
  credits are modelled, and every figure is labelled as before credits.
- **Dependents are not adjudicated.** Their status describes how complete the
  information is, never whether they qualify for anything.

### What is deliberately not stored

There is no column anywhere in the preparation schema for a Social Security
number, ITIN or any other tax identifier — only *which kind* exists and
*whether* one is on file. Free-text fields (names, evidence notes) refuse
anything shaped like an SSN. Audit events carry fact keys, field names and
statuses, never names, notes, amounts' notes or document contents.

### The AI's role in preparation

Two tools, and no more:

- `getTaxPreparationStatus` (read) — where a year stands, what blocks it and
  how to resolve it, confirmed totals, and the frozen calculation. Names, dates
  of birth and evidence notes are withheld from the model; notes may contain
  text copied from documents, which is untrusted.
- `proposeTaxFact` (write, so it passes the human confirmation gate) — adds a
  single **suggestion**. It cannot set the state, source, author or case
  (strict arguments refuse the attempt), and the suggestion is still not
  calculated until confirmed on the page.

The assistant cannot confirm a figure, run a calculation, change a filing
status, or file anything. `tests/server/ai-tax-preparation-tools.test.ts`
covers these boundaries, including a document note that instructs the model to
mark a value confirmed and report the return filed.

### Tests

| Layer | File |
|---|---|
| Fact vocabulary, validation, completeness, snapshot, calculation, package, dependents | `src/domain/tax-preparation/*.test.ts` |
| Resolver dispatch (estimate vs. unavailable) | `src/domain/tax/rules/resolve.test.ts` |
| Form schemas, including the SSN guard | `src/validation/schemas/tax-preparation.test.ts` |
| RLS, immutability, tenant integrity, least privilege — real Postgres | `tests/rls/tax-preparation.test.ts` |
| AI tools and prompt injection | `tests/server/ai-tax-preparation-tools.test.ts` |

### Known limitations

No income questionnaire yet (so the "reported income with no figure" blocker
is implemented and tested but not fed from the UI) · no document extraction —
figures are typed or suggested, never read out of an upload · no archive
button in the UI (the server action exists) · no multi-state allocation · no
credits · no itemized deduction calculation · no entity (corporate or
partnership) returns · no export of the package.
