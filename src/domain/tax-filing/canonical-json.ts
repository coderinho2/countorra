/**
 * Deterministic JSON.
 *
 * A filing package is fingerprinted, stored, re-derived and compared, and all
 * three depend on the same object always serializing to the same bytes. Plain
 * `JSON.stringify` does not promise that: key order follows insertion order,
 * and an object read back from `jsonb` comes back in Postgres's order, not the
 * one it was written in.
 *
 * So keys are sorted at every level. Arrays keep their order, because order
 * is meaningful in them and callers sort where it is not. `undefined`
 * properties are dropped — the same thing `jsonb` does — so an object and its
 * database round trip compare equal. Anything that cannot survive that round
 * trip exactly (a function, a non-finite number, a bigint) is refused rather
 * than silently coerced.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : normalize(item)));

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite numbers are not representable.");
      return value;
    case "object": {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const entry = (value as Record<string, unknown>)[key];
        if (entry === undefined) continue;
        out[key] = normalize(entry);
      }
      return out;
    }
    default:
      throw new TypeError(`canonicalJson: a ${typeof value} is not representable.`);
  }
}
