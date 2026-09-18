"use client";

import { useActionState, useState } from "react";
import { CaretLeft } from "@phosphor-icons/react/dist/ssr/CaretLeft";
import { completeOnboarding } from "@/server/onboarding/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorState } from "@/components/ui/error-state";
import { BrandMark } from "@/components/marketing/brand-mark";
import { EntityTypeStep } from "@/components/onboarding/entity-type-step";
import type { UserEntityType } from "@/domain/organizations/types";

const STEP_COPY: Record<UserEntityType, string> = {
  personal: "Set up your finances",
  freelancer: "Set up your workspace",
  business: "Set up your business",
};

export default function OnboardingPage() {
  const [entityType, setEntityType] = useState<UserEntityType | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [state, formAction, pending] = useActionState(completeOnboarding, {});

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <BrandMark size={24} className="text-ink" />
          <p className="text-[11px] font-semibold tracking-wide text-text-tertiary uppercase">Step {step} of 2</p>
        </div>

        <div key={step} className="page-enter">
          {step === 1 || entityType === null ? (
            <>
              <h1 className="mb-6 text-center text-[22px] leading-8 font-semibold tracking-[-0.005em] text-ink">
                What are you using Countorra for?
              </h1>
              <EntityTypeStep value={entityType} onSelect={setEntityType} onContinue={() => setStep(2)} />
            </>
          ) : (
            <form action={formAction} className="flex flex-col gap-4">
              <input type="hidden" name="entityType" value={entityType} />

              <button
                type="button"
                onClick={() => setStep(1)}
                className="mb-1 flex w-fit items-center gap-1 text-[13px] text-text-secondary transition-colors duration-100 ease-out hover:text-text-primary"
              >
                <CaretLeft size={14} />
                Back
              </button>

              <h1 className="text-[20px] leading-7 font-semibold tracking-[-0.005em] text-ink">{STEP_COPY[entityType]}</h1>

              {state.error && <ErrorState title="Couldn't set up your workspace" description={state.error} />}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">{entityType === "business" ? "Business name" : "What should we call this?"}</Label>
                <Input id="name" name="name" required autoFocus placeholder={entityType === "personal" ? "e.g. My Finances" : "e.g. Acme LLC"} />
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
                You can add tax details, categories, and more later in Settings — nothing else is required to get started.
              </p>

              <Button type="submit" size="lg" disabled={pending} className="mt-2 w-full justify-center">
                {pending ? "Setting up…" : "Continue"}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
