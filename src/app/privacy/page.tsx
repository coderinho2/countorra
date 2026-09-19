import type { Metadata } from "next";
import Link from "next/link";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Reveal } from "@/components/marketing/reveal";
import { LegalFact, LegalPlaceholderNotice } from "@/components/legal/legal-fact";
import { LEGAL_LAST_UPDATED, PLAID_END_USER_PRIVACY_POLICY_URL, STRIPE_PRIVACY_POLICY_URL } from "@/domain/legal/facts";

export const metadata: Metadata = {
  title: "Privacy",
  description: "How Countorra collects, uses, stores, shares and deletes your data — including bank data from Plaid and payments through Stripe.",
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
const External = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
    {children}
  </a>
);

/**
 * The privacy policy, checked claim by claim against the codebase (revised in
 * Task 16). Where a statement depends on the code, the code is named here so
 * the next revision can re-check it:
 *
 *   Supabase — auth, database, storage, account email (src/server/supabase)
 *   Anthropic — the AI assistant only (src/domain/ai/providers/anthropic.ts)
 *   Plaid — bank connections; products: transactions only
 *     (src/server/bank-connections/providers/plaid/config.ts)
 *   access tokens — AES-256-GCM, key only in the server environment
 *     (src/server/bank-connections/credential-crypto.ts, migration 0048)
 *   Stripe — Checkout and the Customer Portal; the app stores customer id,
 *     price, plan, status and period only (migration 0035)
 *   Resend — invoice email, only when EMAIL_PROVIDER=resend
 *   no OCR provider — PDF text layer only (src/server/documents)
 *   no browser storage, no analytics, no error-tracking vendor
 *   account deletion — src/server/account/actions.ts#deleteAccountAction
 *   audit logs survive deletion, detached (migrations 0009, 0025)
 *
 * Business facts that cannot be derived from code come from
 * src/domain/legal/facts.ts and render as visible placeholders until set.
 */
export default function PrivacyPage() {
  return (
    <MarketingShell>
      <section className="mx-auto max-w-[760px] px-6 py-16 lg:px-10 lg:py-24">
        <Reveal>
          <p className="text-[13px] text-text-tertiary">Last updated {LEGAL_LAST_UPDATED}</p>
          <h1 className="font-serif font-normal tracking-[0] mt-2 text-[32px] leading-[40px] text-ink">Privacy Policy</h1>
          <p className="mt-5 max-w-[70ch] text-[15px] leading-[1.7] text-text-secondary">
            This policy explains what information Countorra collects, how it&apos;s used, who it&apos;s shared with, how long it&apos;s kept, and what control you have
            over it. It describes the product as it actually works today, not a roadmap.
          </p>
          <LegalPlaceholderNotice file="src/app/privacy/page.tsx" />
        </Reveal>

        <div className="mt-10 flex flex-col gap-8">
          <Section id="who-we-are" title="1. Who this policy covers">
            <p>
              This policy applies to Countorra, provided by <LegalFact name="legalEntityName" />, <LegalFact name="registeredAddress" />. Questions about this policy
              or your data: <LegalFact name="contactEmail" />.
            </p>
          </Section>

          <Section id="information-we-collect" title="2. Information we collect">
            <ul className="list-disc pl-5">
              <li>
                <Strong>Account information</Strong> — your name and email address. Accounts use an email address and password, managed by Supabase Auth. Your
                password is hashed by Supabase; we never see or store it in plain text.
              </li>
              <li>
                <Strong>Financial information you enter</Strong> — accounts, transactions, invoices, customers and the details you record about them.
              </li>
              <li>
                <Strong>Bank connection data, if you choose to connect a bank</Strong> — see <a href="#bank-connections" className="text-accent hover:underline">§6</a>.
              </li>
              <li>
                <Strong>Tax preparation details you enter</Strong> — for example your filing status, and your dependents&apos; names, relationship to you and dates of
                birth. Countorra does not ask for and has nowhere to store a Social Security number or ITIN; it records only whether one exists.
              </li>
              <li>
                <Strong>Uploaded documents</Strong> — files you upload, stored in private storage isolated to your organization. For PDFs that contain text, that
                text is read on our servers so you can review the figures it contains. We do not currently send documents to an OCR or document-extraction service.
              </li>
              <li>
                <Strong>AI conversations</Strong> — your messages to the AI assistant and its responses, so your conversation history persists.
              </li>
              <li>
                <Strong>Billing information, if you subscribe</Strong> — see <a href="#payments" className="text-accent hover:underline">§7</a>. Card details are
                entered with Stripe, not with Countorra.
              </li>
              <li>
                <Strong>Security and operational information</Strong> — an append-only audit log of sensitive actions in your organization, and server logs of
                errors and operational events. Logs are filtered before they are written so that passwords, tokens, email addresses, amounts and the content of
                your AI questions are not recorded in them. To limit abuse (for example repeated sign-in attempts), we process IP addresses and sign-in
                identifiers, and store them only as keyed hashes.
              </li>
            </ul>
          </Section>

          <Section id="cookies" title="3. Cookies and browser storage">
            <ul className="list-disc pl-5">
              <li>
                <Strong>Sign-in cookies</Strong>, set by Supabase Auth so you stay signed in.
              </li>
              <li>
                <Strong>A short-lived bank sign-in cookie</Strong>, only while you are connecting a bank. It is encrypted, cannot be read by scripts on the page,
                lasts at most 30 minutes, and lets your bank send you back to Countorra and finish connecting. It is removed when the connection finishes.
              </li>
            </ul>
            <p>
              We do not use advertising cookies, tracking pixels or analytics cookies, and Countorra does not store personal data in your browser&apos;s local or
              session storage. When you use Plaid&apos;s window to connect a bank, or Stripe&apos;s pages to pay, those services operate under their own policies,
              linked below.
            </p>
          </Section>

          <Section id="how-we-use-it" title="4. How we use your information">
            <ul className="list-disc pl-5">
              <li>To operate the product: sign you in, keep your data within your organization, and show your records, reports and tax figures.</li>
              <li>To import bank transactions you have chosen to connect, into the accounts you choose.</li>
              <li>To answer questions you ask the AI assistant, using the records needed to answer them (see §5).</li>
              <li>To take payment for a subscription, if you choose one.</li>
              <li>To secure the product: detect and investigate misuse, enforce rate limits, and keep an audit trail of sensitive actions.</li>
              <li>To contact you about your account, its security, or your subscription.</li>
            </ul>
            <p>We do not sell your data, and we do not use your financial data to train AI models.</p>
          </Section>

          <Section id="third-parties" title="5. Service providers">
            <p>We share the minimum data needed with these providers, each for one purpose:</p>
            <ul className="list-disc pl-5">
              <li>
                <Strong>Supabase</Strong> — database, authentication, file storage, and the emails that verify your address and reset your password. The account,
                financial, document and conversation data described in §2 is stored with Supabase.
              </li>
              <li>
                <Strong>Vercel</Strong> — hosting. Your requests pass through Vercel&apos;s servers, which process information such as your IP address and keep
                server logs.
              </li>
              <li>
                <Strong>Anthropic</Strong> — when you use the AI assistant, your message and the financial records needed to answer it are sent to Anthropic to
                generate a response, and for no other purpose.
              </li>
              <li>
                <Strong>Plaid</Strong> — only if you connect a bank. See §6 and{" "}
                <External href={PLAID_END_USER_PRIVACY_POLICY_URL}>Plaid&apos;s End User Privacy Policy</External>.
              </li>
              <li>
                <Strong>Stripe</Strong> — only if you subscribe to a paid plan. See §7 and <External href={STRIPE_PRIVACY_POLICY_URL}>Stripe&apos;s privacy policy</External>.
              </li>
              <li>
                <Strong>Resend</Strong> — only if invoice emailing is enabled: when you send an invoice by email, the recipient&apos;s address and the invoice
                message are sent through Resend for delivery.
              </li>
            </ul>
            <p>
              We do not currently use a document-extraction or OCR service (such as Amazon Textract), a social or single sign-on provider, an analytics or
              advertising platform, or an error-tracking service. If we add one, we will update this policy before it receives your data.
            </p>
          </Section>

          <Section id="bank-connections" title="6. Bank connections through Plaid">
            <p>
              Connecting a bank is optional, and happens only when you choose it. Countorra uses Plaid to connect to your financial institution. You sign in to
              your bank in Plaid&apos;s window; <Strong>Countorra never receives or stores your bank username or password.</Strong>
            </p>
            <p>With your permission, Plaid provides Countorra with:</p>
            <ul className="list-disc pl-5">
              <li>your institution&apos;s name and identifier;</li>
              <li>each account&apos;s name, type and subtype, currency and last four digits — never the full account number;</li>
              <li>each account&apos;s current and available balances;</li>
              <li>
                transactions: amount, currency, date, whether the transaction is pending or posted, the merchant name and description, and the category label
                Plaid assigns.
              </li>
            </ul>
            <p>
              Plaid also gives Countorra an access key for your connection. Countorra encrypts it (AES-256-GCM) before storing it, with a key kept only in our
              server environment and separate from the database. It is never sent to your browser. It is used only to fetch updates from Plaid for your
              connection, on our servers.
            </p>
            <p>
              Nothing enters your books until you choose which Countorra account each bank account feeds. Pending transactions are kept but not added to your
              books until they post. Changes you make to an imported transaction are not overwritten by later updates from your bank.
            </p>
            <p>
              <Strong>Disconnecting.</Strong> You can disconnect a bank at any time from Bank connections. Countorra asks Plaid to end its access and destroys the
              stored access key. Transactions already imported stay in your books until you delete them, and the record of the connection and the transactions
              it reported stays with your organization&apos;s history until the organization is deleted. Plaid&apos;s own policy explains what Plaid keeps and how to
              manage it.
            </p>
          </Section>

          <Section id="payments" title="7. Payments through Stripe">
            <p>
              If you subscribe to a paid plan, payment is handled by Stripe. You enter your card details on Stripe&apos;s pages, and manage your subscription in
              Stripe&apos;s billing portal. <Strong>Countorra never receives or stores your full card number or security code.</Strong> Countorra stores the Stripe
              identifiers for your customer record and subscription, your plan, its status and the current billing period — what it needs to know which plan
              your organization is on.
            </p>
          </Section>

          <Section id="how-we-store-it" title="8. How your data is protected">
            <ul className="list-disc pl-5">
              <li>
                Every table containing your data enforces row-level security scoped to your organization, in the database itself — another organization&apos;s
                members cannot read or change your records, whatever the application asks for.
              </li>
              <li>Connections to Countorra are encrypted in transit (HTTPS), and the site instructs browsers to refuse unencrypted connections.</li>
              <li>Bank access keys are additionally encrypted by Countorra before storage, as described in §6, in a table no user can read.</li>
              <li>Credentials for our providers are held only on our servers, never sent to your browser.</li>
              <li>Messages from Plaid and Stripe to Countorra are accepted only after their signatures are verified.</li>
              <li>Uploaded documents are private; a download link is issued only to a member of your organization and expires within minutes.</li>
              <li>Sensitive account actions, such as deleting your account, require you to enter your password again.</li>
            </ul>
            <p>
              See <Link href="/security" className="text-accent hover:underline">Security</Link> for more detail. No system is perfectly secure, and we cannot
              guarantee that it is.
            </p>
          </Section>

          <Section id="retention" title="9. Retention and deletion">
            <p>
              We keep your data for as long as your account and organization exist. You can delete individual records at any time.
            </p>
            <p>
              <Strong>Deleting your account</Strong> is self-serve, in Settings, and requires your password. It permanently deletes every workspace you are the
              only member of — with all of its financial records, documents, tax information and bank connections (Countorra first asks Plaid to end its access,
              and destroys the stored access keys) — removes you from workspaces you share with others, deletes your AI conversations, and deletes your sign-in. If you
              own a workspace that other people use, you are asked to transfer it first, so their data is not deleted with yours. Records you created in a shared
              workspace stay there for its other members, no longer linked to you.
            </p>
            <p>
              <Strong>Subscriptions:</Strong> deleting your account cancels the paid subscription of every workspace being deleted, before anything else is
              deleted, and Countorra confirms with Stripe that it will not be charged again. If that cannot be confirmed, nothing is deleted. Stripe retains
              records of payments made, under its own obligations.
            </p>
            <p>
              <Strong>Security audit log</Strong> entries are append-only and are kept after a workspace or account is deleted, no longer linked to it or to you.
              Some entries record the name you gave a workspace. Deleted data may also remain in our database provider&apos;s backups until those backups expire.
            </p>
          </Section>

          <Section id="limits" title="10. Tax and financial figures">
            <p>
              Tax figures in Countorra are estimates from the information you provide, with the limitations described in our{" "}
              <Link href="/terms#tax" className="text-accent hover:underline">Terms of Service</Link>. They are not tax returns, and Countorra does not file
              anything with a tax authority on your behalf.
            </p>
          </Section>

          <Section id="your-rights" title="11. Your rights">
            <p>You can, at any time:</p>
            <ul className="list-disc pl-5">
              <li>view and correct your profile, organization and records in the product;</li>
              <li>disconnect any bank connection;</li>
              <li>delete your account, as described in §9;</li>
              <li>ask us for a copy of your data, or what we hold about you, by contacting us.</li>
            </ul>
            <p>
              Depending on where you live, you may have additional rights under laws such as the GDPR or the CCPA. Contact <LegalFact name="contactEmail" /> to
              exercise them.
            </p>
          </Section>

          <Section id="international" title="12. International processing">
            <p>
              Our service providers may process data in countries other than your own. Where that involves transferring data out of the European Economic Area,
              the UK or other regions with transfer requirements, we rely on the safeguards those providers make available. Governing law:{" "}
              <LegalFact name="governingLaw" />.
            </p>
          </Section>

          <Section id="children" title="13. Children">
            <p>Countorra is not directed at children and is not intended for anyone under 18.</p>
          </Section>

          <Section id="changes" title="14. Changes to this policy">
            <p>
              If we make a material change, we will update the date at the top of this page and, where appropriate, tell you directly before it takes effect.
            </p>
          </Section>

          <Section id="contact" title="15. Contact">
            <p>
              <LegalFact name="contactEmail" />, <LegalFact name="registeredAddress" />.
            </p>
          </Section>
        </div>
      </section>
    </MarketingShell>
  );
}
