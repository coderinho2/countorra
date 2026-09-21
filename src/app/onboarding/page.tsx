"use client";

import { useActionState } from "react";
import { completeOnboarding } from "@/server/onboarding/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorState } from "@/components/ui/error-state";
import { BrandMark } from "@/components/marketing/brand-mark";

/**
 * Onboarding: one step, one decision — what to call your workspace.
 *
 * Countorra launches for personal finances only
 * (src/domain/organizations/launch-scope.ts), so there is nothing to choose
 * between. The workspace is personal; the server sets that, and the form
 * does not send an entity type at all.
 */
export default function OnboardingPage() {
  const [state, formAction, pending] = useActionState(completeOnboarding, {});

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <BrandMark size={24} className="text-ink" />
          <p className="text-[11px] font-semibold tracking-wide text-text-tertiary uppercase">Your personal workspace</p>
        </div>

        <form action={formAction} className="page-enter flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h1 className="text-[22px] leading-8 font-semibold tracking-[-0.005em] text-ink">Set up your finances</h1>
            <p className="text-[15px] leading-[1.6] text-text-secondary">
              Your accounts, spending, documents and taxes, kept together in one private workspace.
            </p>
          </div>

          {state.error && <ErrorState title="Couldn't set up your workspace" description={state.error} />}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">What should we call it?</Label>
            <Input id="name" name="name" required autoFocus placeholder="e.g. My Finances" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="country">Country</Label>
              <Input id="country" name="country" defaultValue="US" maxLength={2} className="uppercase" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="baseCurrency">Currency</Label>
              <Input id="baseCurrency" name="baseCurrency" defaultValue="USD" maxLength={3} className="uppercase" />
            </div>
          </div>

          <p className="text-[13px] text-text-secondary">
            You can add your state, categories and tax details later in Settings — nothing else is needed to get started.
          </p>

          <Button type="submit" size="lg" disabled={pending} className="mt-2 w-full justify-center">
            {pending ? "Setting up…" : "Create my workspace"}
          </Button>
        </form>
      </div>
    </div>
  );
}
