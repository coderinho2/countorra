import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `.env.example` is the one file in this repository that is *supposed* to
 * look like a real environment, and `.gitignore` deliberately un-ignores it
 * (`.env*` followed by `!.env.example`). That combination is why a real
 * value pasted here reaches a public remote unnoticed: the diff looks
 * exactly like the file's normal content.
 *
 * This has now happened twice — the original red-team audit found a live
 * `SUPABASE_SERVICE_ROLE_KEY` here, and the *rotated* replacement key was
 * pasted back into the same line afterwards. A service-role key bypasses
 * RLS entirely (src/server/supabase/admin.ts), so it is unrestricted
 * read/write over every organization's financial data.
 *
 * A comment in the file asking people not to do this demonstrably does not
 * hold. This test does: `npm test` fails before the value can be committed.
 *
 * It asserts on the SHAPE of known credential formats, never on any
 * specific value, so nothing secret is encoded here.
 */

const SECRET_SHAPES: { name: string; pattern: RegExp }[] = [
  { name: "Supabase secret/service-role key", pattern: /\bsb_secret_[A-Za-z0-9_-]{8,}/ },
  { name: "Supabase publishable key", pattern: /\bsb_publishable_[A-Za-z0-9_-]{8,}/ },
  { name: "JWT (legacy Supabase anon/service key)", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9]{32,}/ },
  { name: "Postgres connection string with a password", pattern: /\bpostgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/ },
];

/** A real Supabase project ref is 20 lowercase letters; the placeholder is
 *  `your-project-ref`, which this deliberately does not match. */
const REAL_SUPABASE_HOST = /\bhttps:\/\/[a-z]{20}\.supabase\.co/;

function readEnvExample(): string {
  return readFileSync(path.resolve(process.cwd(), ".env.example"), "utf8");
}

function assignments(contents: string): { key: string; value: string }[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const [key, ...rest] = line.split("=");
      return { key: key!.trim(), value: rest.join("=").trim() };
    });
}

describe(".env.example contains no real credentials", () => {
  it("has no value matching a known secret format", () => {
    const contents = readEnvExample();
    const found = SECRET_SHAPES.filter((shape) => shape.pattern.test(contents)).map((shape) => shape.name);
    // Names only — never the matched text.
    expect(found).toEqual([]);
  });

  it("does not name a real Supabase project", () => {
    expect(REAL_SUPABASE_HOST.test(readEnvExample())).toBe(false);
  });

  it("gives every secret-bearing variable a placeholder value", () => {
    const secretish = /(KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)$/;
    const offenders = assignments(readEnvExample())
      .filter(({ key }) => secretish.test(key))
      .filter(({ value }) => value.length > 0 && !value.startsWith("your-"))
      .map(({ key }) => key);

    expect(offenders).toEqual([]);
  });

  it("still documents every variable src/lib/env.ts requires", () => {
    const declared = new Set(assignments(readEnvExample()).map(({ key }) => key));
    for (const required of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "NEXT_PUBLIC_APP_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(declared).toContain(required);
    }
  });
});
