import { isIdentityDocument, type DocumentType } from "./intelligence/types";

/**
 * HOW LONG AN IDENTITY DOCUMENT'S ORIGINAL IS KEPT.
 *
 * THE GAP THIS CLOSES
 *
 * `identity.ts` is careful about what an identity document may leave behind:
 * a class, an issuing state, two dates, and a masked tail. The name, the date
 * of birth, the address, the document number and the MRZ are discarded before
 * anything is written.
 *
 * None of that touched the FILE. A photograph of a driver's licence contains
 * every field the normalizer threw away, and it sat in Storage with no expiry
 * — the reclaim sweep covers abandoned uploads only, so a CONFIRMED identity
 * document was kept until somebody deleted it by hand. The extracted data was
 * minimal and the original was permanent, which made the care taken over the
 * extraction largely beside the point.
 *
 * WHY SEVEN DAYS, AND WHY THAT IS A PRODUCT DECISION RATHER THAN A LEGAL ONE
 *
 * No law is being cited here. This is an operational window, chosen from what
 * the product actually does with the file:
 *
 *   - Countorra reads an identity document ONCE. Nothing downstream consumes
 *     the image again: it cannot become a transaction, it maps to no tax
 *     fact, and the assistant is never shown it.
 *   - After that read, the image's only remaining use is human — "is this the
 *     right licence?" — which is something a person does when they upload it,
 *     or shortly after.
 *   - A processing job may still need the bytes. Jobs get three attempts, and
 *     a person who hits a transient failure may reasonably come back to it the
 *     next day.
 *
 * Seven days covers a retry, a weekend and a second look, and is the shortest
 * window that does all three. It is ONE CONSTANT: shortening it later is a
 * one-line change plus a migration for the interval in the trigger.
 *
 * WHAT IS NOT DELETED
 *
 * Only the stored bytes. The `documents` row survives, with its filename, its
 * type and its extraction — so the person still sees that they uploaded a
 * licence on a date, and what was read from it. A document that vanished
 * entirely would look like data loss; one whose original has expired looks
 * like what it is.
 *
 * FINANCIAL DOCUMENTS ARE NOT AFFECTED. A receipt is evidence for a figure in
 * somebody's tax return and may be needed years later. Expiring it would be a
 * different, worse bug, so nothing here applies to a document that was not
 * classified as identity.
 */

/** Days a confirmed identity document's ORIGINAL FILE is kept after it is read. */
export const IDENTITY_ORIGINAL_RETENTION_DAYS = 7;

/**
 * When an identity document read at `readAt` stops keeping its original.
 *
 * Mirrors the interval in migration 0058's trigger. Both exist: the database
 * sets the expiry so that no code path can forget to, and this one is what the
 * product explains and what the tests compare against. A test asserts the two
 * agree.
 */
export function identityOriginalExpiry(readAt: Date): Date {
  return new Date(readAt.getTime() + IDENTITY_ORIGINAL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/** Whether reading this class of document starts the retention clock. */
export function originalExpiresAfterReading(documentType: DocumentType): boolean {
  return isIdentityDocument(documentType);
}

/**
 * How many originals one sweep may remove.
 *
 * Bounded so an invocation cannot turn into an unbounded scan of a large
 * bucket, and small enough that a partial failure re-runs cheaply. The sweep
 * is idempotent, so the remainder is simply picked up next time; the caller
 * is told whether more is waiting.
 */
export const RETENTION_SWEEP_BATCH = 50;

/**
 * What a person is told about a document whose original has expired.
 *
 * Deliberately plain, and it names the reason: an unexplained missing file
 * reads as a fault, and this is the product working correctly.
 */
export const ORIGINAL_EXPIRED_MESSAGE = "The original of this identity document was deleted after its retention period. What was read from it is still here.";
