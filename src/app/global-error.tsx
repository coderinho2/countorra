"use client";

import { useEffect } from "react";

/**
 * The last resort: an error thrown by the ROOT layout itself.
 *
 * When this renders, the root layout has failed — so it replaces `<html>` and
 * `<body>` entirely, and none of the app's fonts, tokens or components can be
 * relied on to have loaded. Everything here is therefore inline and
 * dependency-free by necessity, not by preference. Importing `Button` or the
 * design tokens would risk the error page failing for the same reason the
 * layout did.
 *
 * Colours are hardcoded to the paper/ink values from DESIGN.md §5 so it still
 * looks like this product rather than a browser default, without depending on
 * the stylesheet having loaded.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[route] global boundary", error.digest ?? "(no digest)");
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
          background: "#F5F2EA",
          color: "#171715",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
        }}
      >
        <div style={{ maxWidth: "28rem", textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: "#6F6B62" }}>
            Countorra
          </p>
          <h1 style={{ margin: "1rem 0 0", fontSize: 28, lineHeight: 1.2, fontWeight: 500 }}>Something went wrong</h1>
          <p style={{ margin: "1rem 0 0", fontSize: 15, lineHeight: 1.6, color: "#6F6B62" }}>
            The application failed to start. Your data hasn&apos;t been changed — nothing was saved or modified.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              height: 44,
              padding: "0 1.25rem",
              borderRadius: 6,
              border: "none",
              background: "#B88932",
              color: "#171715",
              fontSize: 15,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p style={{ margin: "1rem 0 0", fontSize: 13, color: "#6F6B62" }}>
              Reference <span style={{ fontFamily: "ui-monospace, monospace" }}>{error.digest}</span>
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
