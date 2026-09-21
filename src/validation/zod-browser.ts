import { z } from "zod";

/**
 * No `eval` in the browser.
 *
 * Zod 4 compiles object schemas into faster validators with `new Function`,
 * and probes whether it may do so the moment a schema is constructed. The
 * Content-Security-Policy (src/lib/security/content-security-policy.ts)
 * forbids evaluating strings as code, so the probe was refused on every page
 * that validates in the browser — harmless, since Zod catches the refusal and
 * falls back, but each one is a CSP violation report and exactly the kind of
 * noise that hides a real one. `'unsafe-eval'` is not the answer.
 *
 * This must run before any schema is built, so it is a side-effect import
 * that every schema module used by a client component imports FIRST (see
 * tests/security/content-security-policy.test.ts, which enforces that). The
 * server keeps the compiled fast path; it has no CSP to trip.
 */
if (typeof window !== "undefined") z.config({ jitless: true });
