import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Reveal } from "@/components/marketing/reveal";

export const metadata: Metadata = {
  title: "Terms — Countorra",
  description: "The terms governing your use of Countorra.",
};

const LAST_UPDATED = "September 5, 2026";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-3 border-t border-border-subtle pt-8">
      <h2 className="text-2xl font-semibold tracking-[-0.01em] text-ink sm:text-[28px]">{title}</h2>
      <div className="flex max-w-[70ch] flex-col gap-3 text-[15px] leading-[1.7] text-text-secondary">{children}</div>
    </section>
  );
}

/**
 * Real terms of service (DESIGN brief §2) — scoped to what Countorra
 * actually is today: a financial-tracking and AI-assistant tool for
 * self-reported data, on a Free plan only (src/domain/billing has no
 * payment provider wired in). No absolute liability disclaimers, no
 * invented company/legal details — see the configuration notice.
 */
export default function TermsPage() {
  return (
    <MarketingShell>
      <section className="mx-auto max-w-[760px] px-6 py-16 lg:px-10 lg:py-24">
        <Reveal>
          <p className="text-[13px] text-text-tertiary">Last updated {LAST_UPDATED}</p>
          <h1 className="font-serif font-normal tracking-[0] mt-2 text-[32px] leading-[40px] text-ink">Terms of Service</h1>
          <p className="mt-5 max-w-[70ch] text-[15px] leading-[1.7] text-text-secondary">
            These terms govern your use of Countorra. By creating an account, you agree to them. Please read the AI
            disclaimer in §8 carefully — it&apos;s the most important section in this document.
          </p>

          <div className="mt-6 rounded-md border border-border-subtle bg-surface-sunken p-4">
            <p className="text-[13px] leading-[1.6] text-text-secondary">
              <strong className="text-text-primary">Configuration notice.</strong> Bracketed fields below (legal entity
              name, governing jurisdiction, contact address) are placeholders. Replace them with real business details in{" "}
              <code className="rounded-[4px] bg-surface px-1 py-0.5 font-numeric text-[12px]">src/app/terms/page.tsx</code>{" "}
              before this document is presented as binding to real users.
            </p>
          </div>
        </Reveal>

        <div className="mt-10 flex flex-col gap-8">
          <Section id="acceptance" title="1. Acceptance of these terms">
            <p>
              Countorra is provided by <strong className="text-text-primary">[Company Legal Name]</strong>. By
              creating an account or using the product, you agree to these terms. If you&apos;re using Countorra on
              behalf of an organization, you&apos;re confirming you have the authority to bind that organization to these
              terms.
            </p>
          </Section>

          <Section id="the-service" title="2. What Countorra is">
            <p>
              Countorra is a financial tracking, invoicing, and AI-assisted analysis tool for information you and your
              organization&apos;s members enter yourselves. Countorra is <strong className="text-text-primary">not</strong> a
              bank, a money transmitter, or a payment processor — it does not hold, move, or transmit funds, and it does
              not currently connect to external bank accounts.
            </p>
          </Section>

          <Section id="accounts" title="3. Your account">
            <ul className="list-disc pl-5">
              <li>You must provide accurate information when creating an account and keep it up to date.</li>
              <li>You&apos;re responsible for safeguarding your password and for all activity under your account.</li>
              <li>You must be at least 18 years old to use Countorra.</li>
              <li>Notify us immediately if you suspect unauthorized access to your account.</li>
            </ul>
          </Section>

          <Section id="acceptable-use" title="4. Acceptable use">
            <p>You agree not to:</p>
            <ul className="list-disc pl-5">
              <li>Use Countorra for any unlawful purpose, or to enter fraudulent financial records.</li>
              <li>Attempt to bypass, disable, or probe the product&apos;s access controls, tenant isolation, or authorization checks.</li>
              <li>Upload malicious files, or content you don&apos;t have the right to upload.</li>
              <li>Use automated means to scrape or extract data from the product outside its intended interfaces.</li>
              <li>Attempt to reverse-engineer the product beyond what applicable law expressly permits.</li>
              <li>Resell or provide access to the product to third parties without our written permission.</li>
              <li>Use the AI assistant to attempt to generate illegal content or to circumvent the write/delete confirmation step described in §9.</li>
            </ul>
          </Section>

          <Section id="plans-and-payments" title="5. Plans, payments, and cancellation">
            <p>
              Countorra currently offers a Free plan with no charge. Premium and Business plans are described on our{" "}
              <a href="/pricing" className="text-accent hover:underline">Pricing</a> page but are not yet purchasable —
              payment processing is not integrated into the product yet. No fees are currently charged for any part of the
              product. When paid plans become available, these terms will be updated to describe billing, cancellation,
              and refund terms before any payment is collected, and you will be asked to agree to them separately.
            </p>
          </Section>

          <Section id="ai-disclaimer" title="6. AI limitations and disclaimer">
            <p>
              The AI assistant is powered by a third-party large language model. Its answers are generated based on the
              financial data in your organization, but AI-generated content can be incomplete, out of date, or wrong.{" "}
              <strong className="text-text-primary">
                AI-generated content is not professional financial, tax, legal, or accounting advice, and must not be
                treated as such.
              </strong>{" "}
              You are responsible for independently reviewing and verifying any figure, insight, or suggestion the
              assistant provides before relying on it for a real decision. Any AI-suggested action that would create,
              modify, or delete a financial record requires your explicit confirmation before it takes effect — the
              assistant cannot make those changes on its own.
            </p>
          </Section>

          <Section id="tax-disclaimer" title="7. Tax and accounting disclaimer">
            <p>
              Countorra is a tool to help you organize and understand your own financial data. It does not replace a
              licensed accountant, bookkeeper, enrolled agent, or tax professional. Consult a qualified professional before
              making tax filings, regulatory submissions, or other compliance decisions.
            </p>
          </Section>

          <Section id="write-delete-gate" title="8. Confirmation required for changes">
            <p>
              Any action the AI assistant proposes that would write or delete a financial record is held in a
              pending-confirmation state and is never executed automatically. A member of your organization with
              appropriate permissions must explicitly approve it first. This is a structural safeguard, not merely a
              setting — treat every such prompt as a real decision, not a formality.
            </p>
          </Section>

          <Section id="your-content" title="9. Your content">
            <p>
              You retain ownership of the financial data, documents, and other content you or your organization&apos;s
              members upload or enter (&ldquo;your content&rdquo;). You represent that you have the right to upload and use it in
              Countorra. We use your content only to provide the product to you, as described in our{" "}
              <a href="/privacy" className="text-accent hover:underline">Privacy Policy</a>.
            </p>
          </Section>

          <Section id="ip" title="10. Our intellectual property">
            <p>
              Countorra&apos;s software, design, and branding are owned by{" "}
              <strong className="text-text-primary">[Company Legal Name]</strong>. These terms don&apos;t grant you any
              rights to our trademarks, logos, or brand assets.
            </p>
          </Section>

          <Section id="availability" title="11. Service availability">
            <p>
              Countorra is early-stage software, provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis. We don&apos;t
              guarantee uninterrupted availability, and features may change, be added, or be removed as the product
              develops.
            </p>
          </Section>

          <Section id="liability" title="12. Limitation of liability">
            <p>
              To the maximum extent permitted by applicable law, Countorra and{" "}
              <strong className="text-text-primary">[Company Legal Name]</strong> are not liable for indirect, incidental,
              or consequential damages, or for financial decisions made in reliance on data you entered or on
              AI-generated content, except where such liability cannot be excluded by law. Nothing in these terms limits
              liability for fraud or for anything else the law does not permit us to limit.
            </p>
          </Section>

          <Section id="termination" title="13. Termination">
            <p>
              You may stop using Countorra and request account deletion at any time (see the Privacy Policy). We may
              suspend or terminate an account that violates these terms, with notice where reasonably possible.
            </p>
          </Section>

          <Section id="governing-law" title="14. Governing law">
            <p>These terms are governed by the laws of <strong className="text-text-primary">[Governing Jurisdiction]</strong>, without regard to conflict-of-law principles.</p>
          </Section>

          <Section id="changes" title="15. Changes to these terms">
            <p>
              If we make a material change to these terms, we&apos;ll update the date at the top of this page and, where
              appropriate, notify you directly before the change takes effect.
            </p>
          </Section>

          <Section id="contact" title="16. Contact">
            <p>
              Questions about these terms: <strong className="text-text-primary">[legal@yourdomain.example]</strong>.
            </p>
          </Section>
        </div>
      </section>
    </MarketingShell>
  );
}
