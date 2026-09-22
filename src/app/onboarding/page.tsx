"use client";

import { useActionState } from "react";
import { completeOnboarding } from "@/server/onboarding/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorState } from "@/components/ui/error-state";
import { BrandMark } from "@/components/marketing/brand-mark";
import { SUPPORTED_STATES } from "@/domain/tax/supported-states";

/**
 * Onboarding: one screen — what to call your workspace, and where you live.
 *
 * Countorra launches for personal finances only
 * (src/domain/organizations/launch-scope.ts), so there is no workspace type to
 * choose; the server sets it, and the form does not send one.
 *
 * The state is required and has no default. It selects the workspace's state
 * tax rules (src/domain/tax/supported-states.ts), and the server validates it
 * against the supported list — the radios are a convenience, not the check.
 * Nothing sensitive is asked: no SSN, no tax ID, no bank details.
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

          <fieldset className="flex flex-col gap-2">
            <legend className="text-[14px] font-medium text-text-primary">What state do you live in?</legend>
            <p id="state-help" className="text-[13px] leading-5 text-text-secondary">
              Your state helps Countorra personalize your tax calculations and financial guidance — the state tax rules we use, your tax
              organization, and state-specific insights. You can change it later in Settings.
            </p>
            <input type="hidden" name="country" value="US" />
            <div role="radiogroup" aria-describedby="state-help" className="mt-1 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {SUPPORTED_STATES.map((option) => (
                <label
                  key={option.code}
                  className="border-border bg-surface has-checked:border-accent has-checked:bg-accent-subtle hover:border-border-strong has-focus-visible:outline-accent flex cursor-pointer items-center gap-3 rounded-sm border px-3 py-2.5 text-[14px] text-text-primary transition-colors duration-[var(--duration-fast)] ease-out has-focus-visible:outline-2 has-focus-visible:outline-offset-2"
                >
                  <input type="radio" name="stateRegion" value={option.code} required className="accent-(--color-gold) size-4 shrink-0" />
                  <span className="flex-1">{option.name}</span>
                  <span className="font-numeric text-[12px] text-text-tertiary">{option.code}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="baseCurrency">Currency</Label>
            <Input id="baseCurrency" name="baseCurrency" defaultValue="USD" maxLength={3} className="uppercase" />
          </div>

          <p className="text-[13px] text-text-secondary">
            Countorra supports residents of California, Texas, Arizona, Florida and New York. Categories and tax details can be added later in
            Settings.
          </p>

          <Button type="submit" size="lg" disabled={pending} className="mt-2 w-full justify-center">
            {pending ? "Setting up…" : "Create my workspace"}
          </Button>
        </form>
      </div>
    </div>
  );
}
