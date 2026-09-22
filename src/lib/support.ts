/**
 * The one address people can write to.
 *
 * It was stated only in the Help Centre, so every other place that told a
 * reader to "contact support" — both error boundaries, the footer, the legal
 * pages — left them with no way to do it. One constant, because an address
 * spelled slightly differently in two places is an address that stops being
 * monitored in one of them.
 *
 * This is also the value behind `contactEmail` in src/domain/legal/facts.ts.
 * It is a fact about the business, not a claim about the software, which is
 * why it is stated here and nowhere invented.
 */
export const SUPPORT_EMAIL = "support@countorra.com";
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;
