import type { MetadataRoute } from "next";
import { env } from "@/env";

export const dynamic = "force-dynamic";

/** Public, indexable pages. Add entries (or query the database) as pages are created. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  return [{ url: `${base}/`, changeFrequency: "weekly", priority: 1 }];
}
