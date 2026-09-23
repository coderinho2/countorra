import "server-only";
import { TextractClient } from "@aws-sdk/client-textract";
import { serverEnv } from "@/lib/server-env";

/**
 * The Amazon Textract client, and the one place that decides whether this
 * deployment has OCR at all.
 *
 * CREDENTIALS
 *
 * Two supported shapes, and the better one is the default:
 *
 *   1. AWS_REGION alone — the SDK's default provider chain supplies the
 *      credentials. That is an instance/task role, or OIDC web identity. No
 *      long-lived secret exists anywhere, so none can leak or need rotating.
 *      Prefer this wherever the platform offers it.
 *   2. AWS_REGION + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY — a long-lived
 *      key pair, for platforms that provide no role. Vercel is one of these,
 *      which is why the pair is supported at all.
 *
 * `server-only` makes an accidental client import a build error rather than a
 * credential in a bundle, on the same terms as src/lib/server-env.ts. There is
 * deliberately no NEXT_PUBLIC_ variable in this file's reach.
 *
 * LEAST PRIVILEGE
 *
 * The bytes are sent in the request body, never through S3. So the IAM policy
 * this needs is three Textract actions and NOTHING else — no s3:GetObject, no
 * bucket, no KMS key, no role to assume. See DEPLOYMENT.md for the policy.
 *
 * ONE CLIENT PER PROCESS
 *
 * Cached because the client holds a connection pool and a credential provider
 * that refreshes on its own; constructing one per document would re-resolve
 * credentials on every upload.
 */

/** Sync Textract operations accept at most 10 MB (AWS hard limit). The
 *  product's own upload ceiling is 20 MB, so a file can be legitimately
 *  stored and still be too large to read. */
export const TEXTRACT_MAX_BYTES = 10 * 1024 * 1024;

/** Sync operations read one page of a PDF. Multi-page scans need the async
 *  API, which requires an S3 bucket this deployment does not have. */
export const TEXTRACT_MAX_PDF_PAGES = 1;

let cached: TextractClient | null = null;

export interface TextractConfiguration {
  region: string;
  /** False when the SDK's own provider chain supplies credentials. */
  usesStaticKeys: boolean;
}

/**
 * The configuration, or null when this deployment has no OCR.
 *
 * Never throws: an unconfigured deployment is a supported state, and the
 * product says "no reader is configured" rather than failing an upload.
 */
export function textractConfiguration(): TextractConfiguration | null {
  let env: ReturnType<typeof serverEnv>;
  try {
    env = serverEnv();
  } catch {
    return null;
  }
  if (!env.AWS_REGION) return null;
  return { region: env.AWS_REGION, usesStaticKeys: Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) };
}

export function textractConfigured(): boolean {
  return textractConfiguration() !== null;
}

export function textractClient(): TextractClient {
  if (cached) return cached;
  const configuration = textractConfiguration();
  if (!configuration) throw new Error("Textract is not configured for this deployment.");
  const env = serverEnv();

  cached = new TextractClient({
    region: configuration.region,
    // Omitted entirely when no static keys are set, which is what makes the
    // SDK fall back to the instance role rather than to nothing.
    ...(configuration.usesStaticKeys
      ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! } }
      : {}),
    // One attempt inside the SDK. Retries are the processing layer's job
    // (document_processing_jobs.attempts), which is bounded, recorded and
    // visible; a second, invisible retry budget here would multiply both the
    // latency and the bill.
    maxAttempts: 1,
  });
  return cached;
}

/** Test seam: the client caches a credential provider, so a test that changes
 *  the environment has to be able to drop it. */
export function __resetTextractClientForTests(): void {
  cached = null;
}

/**
 * Which Countorra failure an AWS error maps to, without letting the AWS
 * message through.
 *
 * A Textract error can carry the request id, the account id and occasionally
 * a fragment of the document. None of that reaches a user or a log line — the
 * caller gets a category, and the category picks a fixed sentence.
 */
export type TextractErrorKind = "THROTTLED" | "AUTH" | "BAD_DOCUMENT" | "TOO_LARGE" | "UNSUPPORTED" | "SERVICE" | "UNKNOWN";

export function classifyTextractError(error: unknown): TextractErrorKind {
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  switch (name) {
    case "ThrottlingException":
    case "ProvisionedThroughputExceededException":
    case "LimitExceededException":
      return "THROTTLED";
    case "AccessDeniedException":
    case "UnrecognizedClientException":
    case "InvalidSignatureException":
    case "ExpiredTokenException":
    case "CredentialsProviderError":
      return "AUTH";
    case "BadDocumentException":
      return "BAD_DOCUMENT";
    case "DocumentTooLargeException":
      return "TOO_LARGE";
    case "UnsupportedDocumentException":
      return "UNSUPPORTED";
    case "InternalServerError":
    case "ServiceUnavailableException":
      return "SERVICE";
    default:
      return "UNKNOWN";
  }
}
