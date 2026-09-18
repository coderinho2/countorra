import type { MetadataRoute } from "next";
import { publicEnv } from "@/lib/env";

/**
 * There was no robots.txt at all, so crawlers had no statement of intent —
 * including about `/app`, which redirects unauthenticated visitors to login
 * and therefore has nothing to index but every reason to be excluded
 * explicitly rather than by accident.
 *
 * `/auth` and the credential pages are excluded for the same reason: they are
 * functional endpoints, not content, and a search result pointing at a
 * password-reset form is a phishing surface nobody needs.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/app/", "/auth/", "/onboarding", "/login", "/signup", "/reset-password", "/forgot-password", "/verify-email"],
    },
    sitemap: `${publicEnv.NEXT_PUBLIC_APP_URL}/sitemap.xml`,
  };
}
