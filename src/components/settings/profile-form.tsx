"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateProfileAction } from "@/server/settings/actions";

export function ProfileForm({ fullName, email }: { fullName: string | null; email: string }) {
  const [state, formAction, pending] = useActionState(updateProfileAction, {});

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fullName">Full name</Label>
        <Input id="fullName" name="fullName" defaultValue={fullName ?? ""} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Email</Label>
        <p className="text-[15px] text-text-secondary">{email}</p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending} className="w-fit">
          {pending ? "Saving…" : "Save"}
        </Button>
        {state.success && <span className="text-[13px] text-positive">Saved.</span>}
      </div>
    </form>
  );
}
