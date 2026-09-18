"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * CTA dependency for the Hero 08 reference component (21st.dev).
 *
 * PROVENANCE — read before editing. The upstream `hero-08-utils/cta.tsx`
 * source could not be retrieved: no 21st.dev MCP is configured in this
 * workspace and the public registry page for hero-08 does not expose the
 * file. Rather than invent an API, this implementation is derived strictly
 * from the contract the supplied Hero 08 source and its demo already fix:
 *
 *   - named exports `Cta` and `CtaProps`         (hero-08.tsx import)
 *   - `<Cta cta={card.cta} invert={card.invert} />`  (FeatureCard call site)
 *   - `card.cta?.ctaEnabled` gates rendering      (FeatureCard guard)
 *   - `{ ctaEnabled, text, link, size: 'default' }` must satisfy the type
 *                                                 (demo `satisfies Hero08Props`)
 *
 * Nothing beyond that contract is added — no extra props, no variants the
 * call site cannot reach. If the real upstream file is obtained later, it can
 * replace this one as long as those four points still hold.
 *
 * The button itself is this project's existing `@/components/ui/button`, per
 * the install brief's instruction to reuse the production Button rather than
 * ship the reference implementation.
 */
export interface CtaProps {
  /** When false or absent, Hero 08's FeatureCard renders no CTA at all. */
  ctaEnabled?: boolean;
  text: string;
  /** Empty string means "no destination yet" — rendered as a plain button. */
  link?: string;
  /** 21st.dev's size vocabulary; mapped onto the project Button's own scale. */
  size?: "default" | "sm" | "lg";
}

/** 21st.dev calls the default size "default"; this project's Button calls it "md". */
const SIZE_MAP = { default: "md", sm: "sm", lg: "lg" } as const;

export function Cta({ cta, invert }: Readonly<{ cta: CtaProps; invert?: boolean }>) {
  if (!cta?.ctaEnabled) return null;

  const size = SIZE_MAP[cta.size ?? "default"];

  // `invert` means the card sits on a dark image, so the CTA needs to read
  // against that rather than against the page surface.
  const className = cn(invert && "bg-white text-black hover:bg-white/90");

  // A CTA with no link is not a link. Rendering an <a href=""> would navigate
  // to the current URL on click, which looks like a broken page rather than
  // an unconfigured one.
  if (!cta.link) {
    return (
      <Button type="button" size={size} className={className}>
        {cta.text}
      </Button>
    );
  }

  return (
    <Button asChild size={size} className={className}>
      <a href={cta.link}>{cta.text}</a>
    </Button>
  );
}

export default Cta;
