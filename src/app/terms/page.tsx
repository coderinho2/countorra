import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Reveal } from "@/components/marketing/reveal";
import { LegalFact, LegalPlaceholderNotice } from "@/components/legal/legal-fact";
import { PLAN_ENTITLEMENTS, PLAN_TIERS } from "@/domain/billing/entitlements";
import { LEGAL_LAST_UPDATED, PLAID_END_USER_PRIVACY_POLICY_URL } from "@/domain/legal/facts";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms governing your use of Countorra, including subscriptions, bank connections through Plaid, and the limits of its tax figures.",
};

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-24 flex-col gap-3 border-t border-border-subtle pt-8">
      <h2 className="text-2xl font-semibold tracking-[-0.01em] text-ink sm:text-[28px]">{title}</h2>
      <div className="flex max-w-[70ch] flex-col gap-3 text-[15px] leading-[1.7] text-text-secondary">{children}</div>
    </section>
  );
}

const Strong = ({ children }: { children: React.ReactNode }) => <strong className="text-text-primary">{children}</strong>;

const dollars = (minor: number) => `$${(minor / 100).toFixed(minor % 100 === 0 ? 0 : 2)}`;

/**
 * The terms of service, revised in Task 16 against what the product does.
 *
 * Prices and limits come from PLAN_ENTITLEMENTS — the same model that decides
 * what each plan gets — so this page cannot quote a price the product does
 * not charge. Tax coverage is stated from the engines' own `notModelled`
 * lists (src/domain/tax/rules). Subscription behaviour follows the webhook and
 * entitlement code: only `active` and `trialing` subscriptions are entitled,
 * so a failed payment suspends paid features at once. Business facts come from
 * src/domain/legal/facts.ts and render as placeholders until provided.
 */
export default function TermsPage() {
  const paid = PLAN_TIERS.filter((tier) => PLAN_ENTITLEMENTS[tier].priceMinorMonthly > 0);

  return (
    <MarketingShell>
      <section className="mx-auto max-w-[760px] px-6 py-16 lg:px-10 lg:py-24">
        <Reveal>
          <p className="text-[13px] text-text-tertiary">Last updated {LEGAL_LAST_UPDATED}</p>
          <h1 className="font-serif font-normal tracking-[0] mt-2 text-[32px] leading-[40px] text-ink">Terms of Service</h1>
          <p className="mt-5 max-w-[70ch] text-[15px] leading-[1.7] text-text-secondary">
            These terms govern your use of Countorra. By creating an account you agree to them. Please read §7 (tax figures) and §8 (the AI assistant)
            carefully — they describe what Countorra is not.
          </p>
          <LegalPlaceholderNotice file="src/app/terms/page.tsx" />
        </Reveal>

        <div className="mt-10 flex flex-col gap-8">
          <Section id="acceptance" title="1. Acceptance">
            <p>
              Countorra is provided by <LegalFact name="legalEntityName" />. By creating an account or using the product you agree to these terms. If you use
              Countorra for an organization, you confirm you have authority to bind it.
            </p>
          </Section>

          <Section id="the-service" title="2. What Countorra is">
            <p>
              Countorra is software for keeping your own financial records: accounts and transactions, invoices and customers, documents, reports, an AI assistant
              that answers from your records, estimates of certain US income taxes, and a workspace for organizing tax information. If you choose, it can import
              transactions from your bank through Plaid.
            </p>
            <p>
              Countorra is <Strong>not</Strong> a bank, a money transmitter or a payment processor — it does not hold or move money — and it is{" "}
              <Strong>not</Strong> a tax preparer, an accounting firm or a law firm.
            </p>
          </Section>

          <Section id="accounts" title="3. Your account">
            <ul className="list-disc pl-5">
              <li>You must be at least 18, and provide accurate information.</li>
              <li>You are responsible for keeping your password safe and for activity under your account. Tell us promptly if you suspect unauthorized access.</li>
              <li>Each workspace (organization) has its own members, roles, data and plan.</li>
            </ul>
          </Section>

          <Section id="plans" title="4. Plans, billing and cancellation">
            <p>Countorra offers these plans, per workspace:</p>
            <ul className="list-disc pl-5">
              <li>
                <Strong>{PLAN_ENTITLEMENTS.free.name}</Strong> — no charge.
              </li>
              {paid.map((tier) => (
                <li key={tier}>
                  <Strong>{PLAN_ENTITLEMENTS[tier].name}</Strong> — {dollars(PLAN_ENTITLEMENTS[tier].priceMinorMonthly)} {PLAN_ENTITLEMENTS[tier].currency} per
                  month.
                </li>
              ))}
            </ul>
            <p>
              What each plan includes is described on <Link href="/pricing" className="text-accent hover:underline">Pricing</Link>. Features marked there as coming
              soon are not part of what you pay for until they are available. Taxes on these prices: <LegalFact name="taxOnPrices" />.
            </p>
            <ul className="list-disc pl-5">
              <li>
                <Strong>Recurring billing.</Strong> Paid plans are monthly subscriptions, charged by Stripe to the payment method you provide, automatically each
                month until cancelled.
              </li>
              <li>
                <Strong>Starting.</Strong> A workspace moves to a paid plan once Stripe confirms the payment — not when you return from the checkout page.
              </li>
              <li>
                <Strong>Changing or cancelling.</Strong> An owner or admin can change plan, update the payment method or cancel at any time from Manage billing in
                Settings. What happens at cancellation — immediately or at the end of the period already paid for — is shown in that billing portal before you
                confirm.
              </li>
              <li>
                <Strong>Failed payments.</Strong> If a payment fails, the workspace&apos;s paid features are suspended until payment succeeds. Your data is not
                deleted.
              </li>
              <li>
                <Strong>Refunds.</Strong> <LegalFact name="refundPolicy" />
              </li>
              <li>
                <Strong>Deleting your account cancels your subscriptions.</Strong> Before anything is deleted, Countorra cancels the paid subscription of
                every workspace being deleted — immediately — and confirms with Stripe that it will not be charged again. If that cannot be confirmed, nothing
                is deleted and you are asked to try again. The unused part of a period already paid for is not credited automatically; refunds follow the
                policy above. A shared workspace you only leave keeps its plan for its remaining members.
              </li>
            </ul>
          </Section>

          <Section id="bank-connections" title="5. Bank connections through Plaid">
            <p>
              Connecting a bank is optional and available on plans that include it. Countorra uses Plaid to connect to your financial institution, and your use
              of Plaid is also subject to <a href={PLAID_END_USER_PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">Plaid&apos;s End User Privacy Policy</a>.
              What is shared and how it is stored is described in our <Link href="/privacy#bank-connections" className="text-accent hover:underline">Privacy Policy</Link>.
            </p>
            <ul className="list-disc pl-5">
              <li>You choose which institutions to connect and which accounts to import into which Countorra accounts. Connect only accounts you are authorized to access.</li>
              <li>
                Imported data comes from your bank through Plaid. We do not guarantee that it is complete, accurate or current, and imports depend on your bank and
                on Plaid being available. Check imported transactions against your bank statements.
              </li>
              <li>Pending transactions are not added to your books until they post, and changes you make to an imported transaction are not overwritten.</li>
              <li>Your bank may occasionally ask you to sign in again before imports continue.</li>
              <li>You can disconnect at any time. Transactions already imported stay in your books until you delete them.</li>
            </ul>
          </Section>

          <Section id="acceptable-use" title="6. Acceptable use">
            <p>You agree not to:</p>
            <ul className="list-disc pl-5">
              <li>use Countorra unlawfully, or to record fraudulent financial information;</li>
              <li>connect a bank account you are not authorized to access;</li>
              <li>attempt to bypass, disable or probe access controls, organization isolation, rate limits or authentication;</li>
              <li>upload malicious files, or content you do not have the right to upload;</li>
              <li>scrape or extract data other than through the product&apos;s own features;</li>
              <li>reverse-engineer the product beyond what applicable law expressly permits;</li>
              <li>resell or provide access to the product to third parties without our written permission;</li>
              <li>use the AI assistant to generate unlawful content or to get around the confirmation step in §9.</li>
            </ul>
          </Section>

          <Section id="tax" title="7. Tax figures and their limits">
            <p>
              Countorra estimates <Strong>2026</Strong> US individual income tax: federal tax, and state tax for <Strong>California, New York State, Arizona</Strong>,{" "}
              and <Strong>Florida and Texas</Strong> (which levy no individual income tax, so their figure is zero). Estimates use only the information you enter
              or confirm, and have real limits:
            </p>
            <ul className="list-disc pl-5">
              <li>The standard deduction is always used; itemized deductions are not modelled.</li>
              <li>
                Tax is calculated for the filing status you choose. Whether you actually qualify for that status is <Strong>not</Strong> determined.
              </li>
              <li>
                Not modelled, among others: tax credits (including the Child Tax Credit and Earned Income Tax Credit), the qualified business income deduction,
                preferential rates on capital gains and qualified dividends, the Alternative Minimum Tax, the Net Investment Income Tax, and withholding or
                estimated payments already made.
              </li>
              <li>New York figures cover New York State only — not New York City, Yonkers or the MCTMT. No other state, and no local tax, is covered.</li>
              <li>Each result lists what it does not include. Read that list before relying on a figure.</li>
            </ul>
            <p>
              Tax preparation and tax filing in Countorra organize your information and produce a summary you can export. <Strong>Countorra does not prepare or
              file tax returns, does not e-file, does not submit anything to the IRS or any state, and does not provide a tax professional&apos;s review.</Strong>{" "}
              Nothing in Countorra is tax, legal, accounting or financial advice. Consult a qualified professional before filing or making decisions that depend on
              a tax figure.
            </p>
          </Section>

          <Section id="ai" title="8. The AI assistant">
            <p>
              The AI assistant uses a third-party language model to answer from the records in your workspace. Its explanations and suggestions can be incomplete
              or wrong, and they are <Strong>not authoritative</Strong> and <Strong>not professional financial, tax, legal or accounting advice</Strong>. Tax and
              financial calculations it presents come from Countorra&apos;s own calculation code, not from the model, but the model chooses what to ask for and how to
              describe it. Verify anything before you rely on it.
            </p>
          </Section>

          <Section id="write-delete-gate" title="9. Confirmation required for changes">
            <p>
              Anything the AI assistant proposes that would create, change or delete a record waits for explicit approval from a member of your workspace with
              permission to make that change. It is never carried out automatically. Treat every such prompt as a real decision.
            </p>
          </Section>

          <Section id="your-content" title="10. Your content">
            <p>
              You keep ownership of the data, documents and other content you or your workspace&apos;s members enter, upload or import. You confirm you have the right
              to use it in Countorra. We use it only to provide the product to you, as described in our{" "}
              <Link href="/privacy" className="text-accent hover:underline">Privacy Policy</Link>.
            </p>
          </Section>

          <Section id="deletion" title="11. Deleting your account, and termination">
            <p>
              You can delete your account yourself in Settings; what is deleted and what is kept is described in the{" "}
              <Link href="/privacy#retention" className="text-accent hover:underline">Privacy Policy</Link>. We may suspend or terminate an account that violates these
              terms, with notice where reasonably possible.
            </p>
          </Section>

          <Section id="ip" title="12. Our intellectual property">
            <p>
              Countorra&apos;s software, design and branding belong to <LegalFact name="legalEntityName" />. These terms do not grant you rights to our trademarks,
              logos or brand assets.
            </p>
          </Section>

          <Section id="availability" title="13. Availability">
            <p>
              Countorra is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. We do not guarantee uninterrupted availability, and features may change as the
              product develops. Parts of the product depend on third parties — including your bank, Plaid, Stripe and our hosting and AI providers — whose
              availability we do not control.
            </p>
          </Section>

          <Section id="liability" title="14. Limitation of liability">
            <p>
              To the maximum extent permitted by law, <LegalFact name="legalEntityName" /> is not liable for indirect, incidental or consequential damages, or for
              decisions made in reliance on data you entered or imported, on tax estimates, or on AI-generated content. Nothing in these terms limits liability that
              cannot be limited by law, including for fraud.
            </p>
          </Section>

          <Section id="governing-law" title="15. Governing law">
            <p>
              These terms are governed by the laws of <LegalFact name="governingLaw" />, without regard to conflict-of-law principles.
            </p>
          </Section>

          <Section id="changes" title="16. Changes to these terms">
            <p>
              If we make a material change, we will update the date at the top of this page and, where appropriate, tell you directly before it takes effect.
            </p>
          </Section>

          <Section id="contact" title="17. Contact">
            <p>
              Questions about these terms: <LegalFact name="contactEmail" />.
            </p>
          </Section>
        </div>
      </section>
    </MarketingShell>
  );
}
