/**
 * The one declaration of how large an uploaded document may be (DEP-02).
 *
 * THE MISMATCH THIS ORIGINALLY EXISTED TO REMOVE
 *
 * Three places described the limit and they did not agree:
 *
 *   * `uploadDocumentSchema` rejected anything over 20 MB — a server-side
 *     check, and the product's actual stated intent.
 *   * The upload dialog told the user "up to 20MB".
 *   * Next.js silently rejected the request at **1 MB**, because
 *     `experimental.serverActions.bodySizeLimit` was never set and its default
 *     is `1024 * 1024` (verified in next/dist/server/app-render/action-handler:
 *     `bodySizeLimitBytes ... : 1024 * 1024 // 1 MB`, throwing a 413).
 *
 * So every upload between 1 MB and 20 MB — most scanned receipts, nearly every
 * PDF bank statement — failed with an opaque framework error before the action
 * ran, while two server-side declarations said it was allowed.
 *
 * HOW IT WAS RESOLVED, AND WHY THAT CHANGED AGAIN
 *
 * The first fix raised `bodySizeLimit` to 20 MB. That worked, and it cost
 * something real and global: `bodySizeLimit` cannot be scoped to one action,
 * so **every** authenticated Server Action in the product had to accept a
 * 20 MB body before its own Zod schema could reject it. This file said so
 * plainly at the time, and named the architecture that removes the trade
 * rather than tuning it — a direct-to-Storage signed upload, where the bytes
 * never traverse a Server Action at all.
 *
 * That architecture now exists (src/server/documents/actions.ts). The browser
 * PUTs directly to Storage; the Server Actions on the upload path carry a
 * filename and a UUID and nothing else. So the widening is no longer paying
 * for anything, and `bodySizeLimit` is back down to the framework default in
 * `next.config.ts` — deliberately, and stated there.
 *
 * WHAT `MAX_UPLOAD_BYTES` MEANS NOW
 *
 * It is no longer a framework setting at all. It is enforced twice, in the two
 * places that can actually observe a size:
 *
 *   * `uploadDocumentSchema`, against the size the browser *claims*, so an
 *     obviously-oversized upload never gets a signed URL. A claim, refused
 *     cheaply.
 *   * `evaluateUpload`, against the size Storage *reports* for the object that
 *     actually landed. Evidence, and the only one of the two an uploader
 *     cannot choose — declaring 1 MB and PUTting 500 MB fails here.
 */

/** 20 MB. The product's stated per-file ceiling. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Server Action request bodies, which no longer carry file content.
 *
 * Left explicit rather than deleted so that the value is a decision someone
 * made and can find, not a default that happens to apply. Raising this again
 * should require a reason that survives reading the paragraphs above.
 */
export const SERVER_ACTION_BODY_LIMIT = "1mb" as const;

/** Human-readable, for UI copy that must not contradict the limit above. */
export const MAX_UPLOAD_LABEL = `${MAX_UPLOAD_BYTES / (1024 * 1024)}MB`;
