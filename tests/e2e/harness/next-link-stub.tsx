import type { AnchorHTMLAttributes, ReactNode } from "react";

/** TEST-ONLY: `next/link` outside a Next app is a plain anchor. */
export default function Link({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
