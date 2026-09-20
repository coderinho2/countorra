import { LogoCloud, type Logo } from "@/components/ui/logo-cloud-3";

/**
 * The infrastructure strip: what Countorra is built on.
 *
 * WHAT THIS SECTION CLAIMS, AND WHAT IT DOES NOT
 *
 * It says Countorra is built with these technologies, and nothing more. None
 * of these companies endorses, sponsors or partners with Countorra, so no
 * word here implies one: no "our partners", no "trusted by", no logos
 * presented as customers. Every one of them is a real dependency of this
 * codebase — Stripe for billing, Plaid for bank connections, Anthropic for
 * the assistant, AWS and Supabase for the database and storage underneath it,
 * and Vercel for the deployment this site runs on.
 *
 * The marks are the companies' own, monochrome and small, at the weight of a
 * caption rather than a headline. They are their respective owners'
 * trademarks, used only to identify the technology.
 */

/** `aspect` is width ÷ height from each asset's own viewBox, so nothing is
 *  stretched: Stripe 512×214, Anthropic 182×24, AWS 304×182, Supabase
 *  581×113, Vercel 262×52. */
const LOGOS: Logo[] = [
  { src: "/logos/stripe.svg", alt: "Stripe", aspect: 512 / 214, scale: 1.25 },
  // Plaid publishes no monochrome asset at a stable public URL, so its name is
  // set in the product's own typeface rather than shipping an unofficial or
  // low-quality trace of its logo.
  { alt: "Plaid", wordmark: true },
  { src: "/logos/anthropic.svg", alt: "Anthropic", aspect: 182 / 24, scale: 0.72 },
  { src: "/logos/aws.svg", alt: "Amazon Web Services", aspect: 304 / 182, scale: 1.4 },
  { src: "/logos/supabase.svg", alt: "Supabase", aspect: 581 / 113 },
  { src: "/logos/vercel.svg", alt: "Vercel", aspect: 262 / 52 },
];

export function TechnologyStrip() {
  return (
    <div className="flex flex-col items-center">
      <h2 className="text-ink text-center text-[20px] leading-7 font-semibold tracking-[-0.005em]">Built with trusted technology</h2>
      <p className="text-text-secondary mt-2 max-w-[46ch] text-center text-[14px]">
        Countorra is powered by trusted infrastructure and technology.
      </p>

      {/* One rule, not two: a pair of short rules above and below read as a
          stray box drawn around the logos rather than as a divider. */}
      <div className="border-border-subtle mx-auto mt-8 h-px w-full max-w-sm border-t [mask-image:linear-gradient(to_right,transparent,black,transparent)]" />

      <LogoCloud className="w-full" logos={LOGOS} height={18} />
    </div>
  );
}
