import type { MetadataRoute } from "next";
import { publicEnv } from "@/lib/env";

/**
 * Every public route, and only public routes.
 *
 * Listed explicitly rather than generated from the filesystem: the App Router
 * has no way to distinguish "public marketing page" from "authenticated
 * application route" by path shape alone, and a sitemap that accidentally
 * advertises `/app/[orgId]/transactions` is worse than no sitemap.
 */
const PUBLIC_ROUTES = [
  { path: "", priority: 1.0, changeFrequency: "weekly" as const },
  { path: "/product", priority: 0.9, changeFrequency: "monthly" as const },
  { path: "/solutions/personal", priority: 0.8, changeFrequency: "monthly" as const },
  { path: "/pricing", priority: 0.9, changeFrequency: "monthly" as const },
  { path: "/security", priority: 0.7, changeFrequency: "monthly" as const },
  { path: "/resources", priority: 0.6, changeFrequency: "monthly" as const },
  { path: "/help", priority: 0.6, changeFrequency: "monthly" as const },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" as const },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" as const },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = publicEnv.NEXT_PUBLIC_APP_URL;
  const lastModified = new Date();

  return PUBLIC_ROUTES.map((route) => ({
    url: `${base}${route.path}`,
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
