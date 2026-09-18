import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership, requireUser } from "@/server/auth/session";
import { getOrganization } from "@/server/db/repositories/organizations";
import { getProfile } from "@/server/db/repositories/profiles";
import { listCategories } from "@/server/db/repositories/categories";
import { listMembersWithEmail } from "@/server/db/repositories/memberships";
import { getSubscription, listPlans } from "@/server/db/repositories/subscriptions";
import { countUserMessagesSince } from "@/server/db/repositories/ai-conversations";
import { can } from "@/domain/organizations/permissions";
import { formatAiMessageLimit, last24HoursIso } from "@/domain/billing/limits";
import { entitlementsFor } from "@/domain/billing/entitlements";
import { isRecoverableStatus } from "@/domain/billing/stripe-subscription";
import { ManageBillingButton } from "@/components/billing/manage-billing-button";
import { isBillingConfigured } from "@/server/billing/stripe-config";
import { ProfileForm } from "@/components/settings/profile-form";
import { OrganizationForm } from "@/components/settings/organization-form";
import { CategoriesManager } from "@/components/settings/categories-manager";
import { MembersManager } from "@/components/settings/members-manager";
import { SettingsNav } from "@/components/settings/settings-nav";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader, PageShell } from "@/components/ui/page-header";
import { Amount } from "@/components/amount";
import { money } from "@/domain/money/money";
import { isSupportedCurrency } from "@/domain/money/currency";
import { cn } from "@/lib/utils";
import type { PlanTier } from "@/types/database";

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "organization", label: "Organization" },
  { id: "categories", label: "Categories" },
  { id: "members", label: "Members" },
  { id: "plan", label: "Plan & usage" },
  { id: "security", label: "Security" },
];

/**
 * Settings.
 *
 * Five identical cards stacked in a narrow column became a two-pane layout:
 * an anchor rail that tracks where you are, and sections separated by rules
 * rather than by boxes. Each section states what it governs before showing
 * the controls, because a settings page that only shows fields makes the user
 * guess what changing one will do.
 *
 * There is no "delete workspace" here. No such action exists in the codebase,
 * and a button that looks destructive but does nothing is worse than an
 * absent one.
 */
export default async function SettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { membership } = await requireOrgMembership(orgId);
  const user = await requireUser();

  const client = await createClient();
  const [organization, profile, categories, members, subscription, plans] = await Promise.all([
    getOrganization(client, orgId),
    getProfile(client, user.id),
    listCategories(client, orgId),
    listMembersWithEmail(client, orgId),
    getSubscription(client, orgId),
    listPlans(client),
  ]);
  if (!organization) notFound();

  // Through `entitlementsFor`, not `subscription.planId`. Reading the tier
  // directly ignored the STATUS, so a cancelled or past-due Premium row
  // displayed Premium's allowance in Settings while the AI action enforced
  // Free — the meter and the number beside it disagreeing about the same
  // workspace. One resolver, one answer.
  const entitlements = entitlementsFor(subscription);
  const planTier: PlanTier = entitlements.tier;
  const currentPlan = plans.find((p) => p.id === planTier);
  const aiDailyLimit = entitlements.aiMessagesPerDay;
  const aiMessagesUsedToday = await countUserMessagesSince(client, orgId, last24HoursIso());
  const usageShare = Math.min(100, Math.round((aiMessagesUsedToday / aiDailyLimit) * 100));

  const canManageBilling = can(membership.role, "billing:manage");
  const billingConfigured = isBillingConfigured();

  // Status as the customer experiences it, not as Stripe names it. "incomplete"
  // and "past_due" mean nothing to someone looking at their own workspace.
  const billingBadge: { label: string; variant: "positive" | "neutral" | "warning" } = !subscription
    ? { label: "Active", variant: "neutral" }
    : subscription.status === "active" || subscription.status === "trialing"
      ? subscription.cancelAtPeriodEnd
        ? { label: "Ending", variant: "warning" }
        : { label: subscription.status === "trialing" ? "Trial" : "Active", variant: "positive" }
      : isRecoverableStatus(subscription.status)
        ? { label: "Payment issue", variant: "warning" }
        : { label: "Inactive", variant: "neutral" };

  const periodEnd = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  const periodEndLabel = !periodEnd
    ? null
    : subscription?.cancelAtPeriodEnd
      ? `Access ends ${periodEnd.toLocaleDateString()}`
      : subscription?.status === "active" || subscription?.status === "trialing"
        ? `Renews ${periodEnd.toLocaleDateString()}`
        : null;

  return (
    <PageShell className="max-w-5xl gap-8">
      <PageHeader eyebrow="Workspace" title="Settings" description="Your account, this workspace, and who else can see it." />

      <div className="flex gap-10">
        <SettingsNav sections={SECTIONS} />

        <div className="flex min-w-0 flex-1 flex-col gap-12">
          <SettingsSection id="profile" title="Profile" description="How you appear to other people in this workspace.">
            <ProfileForm fullName={profile?.fullName ?? null} email={user.email ?? ""} />
          </SettingsSection>

          <SettingsSection
            id="organization"
            title="Organization"
            description={`Legal and financial details for this ${organization.entityType} workspace. Currency and country affect every figure in the product.`}
          >
            <OrganizationForm organization={organization} canEdit={can(membership.role, "org:update")} />
          </SettingsSection>

          <SettingsSection id="categories" title="Categories" description="How transactions are grouped in reports and in the spending breakdown.">
            <CategoriesManager organizationId={orgId} categories={categories} />
          </SettingsSection>

          <SettingsSection id="members" title="Members" description="Everyone with access to this workspace's financial data.">
            <MembersManager
              organizationId={orgId}
              members={members}
              currentUserId={user.id}
              currentUserRole={membership.role}
              canManage={can(membership.role, "org:manage_members")}
            />
          </SettingsSection>

          <SettingsSection id="plan" title="Plan &amp; usage" description="What this workspace is on, and what it has used.">
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <p className="flex items-center gap-2 text-[15px] font-medium text-text-primary">
                    {entitlements.name}
                    <Badge variant={billingBadge.variant}>{billingBadge.label}</Badge>
                  </p>
                  <p className="text-[13px] text-text-secondary">
                    {currentPlan?.priceMinor != null && isSupportedCurrency(currentPlan.currency) ? (
                      <>
                        <Amount value={money(currentPlan.priceMinor, currentPlan.currency)} size="small" tone="muted" /> per month
                      </>
                    ) : (
                      "No charge"
                    )}
                  </p>
                  {/* The date is stated with its MEANING attached. "Renews on"
                      and "ends on" are the same timestamp and opposite facts,
                      and a bare date beside a cancelled subscription is the
                      kind of thing people read the wrong way round. */}
                  {periodEndLabel && <p className="text-[13px] text-text-tertiary">{periodEndLabel}</p>}
                  {subscription && isRecoverableStatus(subscription.status) && (
                    <p className="text-[13px] text-warning">
                      There is a problem with the payment method for this workspace. Paid features are paused until it is resolved.
                    </p>
                  )}
                </div>

                <div className="flex flex-col items-end gap-2">
                  {/* Manage billing only once Stripe actually has a customer
                      for this workspace — a portal session for a workspace
                      that never checked out opens an empty page that looks
                      broken. */}
                  {canManageBilling && billingConfigured && subscription?.stripeCustomerId && (
                    <ManageBillingButton organizationId={orgId} />
                  )}
                  {planTier !== "business" && (
                    <Button asChild size="sm" variant={subscription?.stripeCustomerId ? "ghost" : "secondary"}>
                      <Link href="/pricing">{planTier === "free" ? "See plans" : "Change plan"}</Link>
                    </Button>
                  )}
                </div>
              </div>

              {/* Usage as a bar, not just a fraction: "18 / 25" needs to be
                  read and divided; a bar is understood at a glance, and the
                  fraction stays beside it for the exact figure. */}
              <div className="flex flex-col gap-2 border-t border-border-subtle pt-4">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-[13px] text-text-secondary">Ask your money, last 24 hours</span>
                  <span className="font-numeric text-[13px] text-text-primary">
                    {`${aiMessagesUsedToday} / ${aiDailyLimit}`}
                  </span>
                </div>
                <span aria-hidden="true" className="h-1 w-full overflow-hidden rounded-pill bg-surface-sunken">
                  <span className={cn("block h-full rounded-pill", usageShare >= 90 ? "bg-warning" : "bg-accent")} style={{ width: `${usageShare}%` }} />
                </span>
                <p className="text-[13px] text-text-tertiary">
                  {`${entitlements.name} includes ${formatAiMessageLimit(planTier)} of AI messages. Compare what each plan includes on `}
                  <Link href="/pricing" className="text-accent hover:underline">
                    Pricing
                  </Link>
                  .
                </p>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="security" title="Security" description="Credentials for this account.">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-col gap-0.5">
                <p className="text-[15px] text-text-primary">Password</p>
                <p className="max-w-[60ch] text-[13px] text-text-secondary">
                  Changing your password sends a confirmation link to <span className="text-text-primary">{user.email}</span>. It never changes without that
                  link being opened.
                </p>
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link href="/forgot-password">Change password</Link>
              </Button>
            </div>
          </SettingsSection>
        </div>
      </div>
    </PageShell>
  );
}

/**
 * A settings section: a ruled heading, a sentence saying what it governs, and
 * the controls. `scroll-mt` keeps the heading clear of the top bar when the
 * anchor rail jumps to it.
 */
function SettingsSection({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6">
      <div className="flex flex-col gap-1 border-b border-border-subtle pb-3">
        <h2 className="text-[20px] leading-7 font-semibold tracking-[-0.005em] text-ink">{title}</h2>
        <p className="max-w-[70ch] text-[13px] text-text-secondary">{description}</p>
      </div>
      <div className="pt-5">{children}</div>
    </section>
  );
}
