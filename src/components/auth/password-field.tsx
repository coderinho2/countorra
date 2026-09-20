"use client";

import { useId, useState } from "react";
import { Eye } from "@phosphor-icons/react/dist/ssr/Eye";
import { EyeSlash } from "@phosphor-icons/react/dist/ssr/EyeSlash";
import { Input } from "@/components/ui/input";

/**
 * A password input with a reveal toggle.
 *
 * The toggle's accessible name is deliberately "Show characters" rather than
 * "Show password". `getByLabel("Password")` — which the E2E suite and any
 * assistive-technology user's "find the password box" both rely on — matches
 * accessible names by substring, so a button named "Show password" becomes a
 * second, ambiguous match for the field itself. Inside the field, "Show
 * characters" says exactly what the control does with no ambiguity about
 * which of the two things on screen it is.
 *
 * It is a `type="button"`, so it can never submit the form, and it stays out
 * of the tab order of nothing — it is focusable and operable by keyboard,
 * with `aria-pressed` reporting the current state.
 */
export function PasswordField({
  id,
  name,
  autoComplete,
  invalid,
  describedBy,
  minLength,
  onBlur,
  required = true,
}: {
  id: string;
  name: string;
  autoComplete: "current-password" | "new-password";
  invalid?: boolean;
  describedBy?: string;
  minLength?: number;
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;
  required?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const hintId = useId();

  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        minLength={minLength}
        invalid={invalid}
        aria-describedby={describedBy}
        onBlur={onBlur}
        required={required}
        className="pr-11"
      />
      <button
        type="button"
        id={hintId}
        onClick={() => setVisible((shown) => !shown)}
        aria-label={visible ? "Hide characters" : "Show characters"}
        aria-pressed={visible}
        aria-controls={id}
        className="text-text-tertiary hover:text-text-primary absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-sm transition-colors duration-100 ease-out"
      >
        {visible ? <EyeSlash size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}
