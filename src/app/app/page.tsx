import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { listMyOrganizations } from "@/server/db/repositories/organizations";

/** /app has no UI of its own — it routes to onboarding (no organizations
 *  yet) or straight into the first organization's dashboard. Organization
 *  context lives in the URL (/app/[orgId]/...) rather than a cookie or
 *  session field, so every page is shareable/bookmarkable and a
 *  Server Component can authorize it from the URL alone. */
export default async function AppRootPage() {
  const supabase = await createClient();
  const organizations = await listMyOrganizations(supabase);

  if (organizations.length === 0) redirect("/onboarding");
  redirect(`/app/${organizations[0].id}/dashboard`);
}
