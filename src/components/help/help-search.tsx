"use client";

import { useDeferredValue, useId, useMemo, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { X } from "@phosphor-icons/react/dist/ssr/X";
import { SUPPORT_EMAIL, SUPPORT_MAILTO } from "./help-content";
import { searchHelp } from "./help-search-index";

const EXAMPLE_QUERY = "How do I connect my bank?";

/**
 * The Help Centre's search box. Results render in the page flow directly
 * under the field — not in a floating popover — so they never cover the
 * content and work the same at every width.
 *
 * Results are plain `<a href="#…">` rather than next/link: a native hash
 * change is what opens an FAQ answer (faqs-01.tsx listens for it), and a
 * client-side router push does not fire one.
 */
export function HelpSearch() {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const results = useMemo(() => searchHelp(deferred), [deferred]);
  const inputId = useId();
  const resultsId = useId();
  const searching = deferred.trim().length > 0;

  return (
    <div role="search" className="w-full">
      <label htmlFor={inputId} className="sr-only">
        Search the Help Centre
      </label>
      <div className="relative">
        <MagnifyingGlass size={18} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-text-tertiary" />
        <input
          id={inputId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
            if (event.key === "Enter" && results[0]) window.location.hash = results[0].anchor;
          }}
          placeholder="Search the Help Centre"
          autoComplete="off"
          aria-controls={resultsId}
          className="h-12 w-full rounded-sm border border-border bg-surface pr-11 pl-11 text-[15px] text-text-primary transition-[border-color] duration-[120ms] ease-out placeholder:text-text-tertiary hover:border-border-strong focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/25 [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-sm text-text-tertiary transition-colors duration-[120ms] ease-out hover:bg-surface-sunken hover:text-text-primary"
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      {!query && (
        <p className="mt-2.5 text-[13px] text-text-tertiary">
          Try{" "}
          <button
            type="button"
            onClick={() => setQuery(EXAMPLE_QUERY)}
            className="text-text-secondary underline decoration-border-strong underline-offset-4 transition-colors duration-[120ms] ease-out hover:text-accent hover:decoration-accent"
          >
            {EXAMPLE_QUERY}
          </button>
        </p>
      )}

      <div id={resultsId} aria-live="polite">
        {searching && (
          <div className="animate-disclose mt-3 overflow-hidden rounded-md border border-border-subtle bg-surface">
            <p className="font-numeric border-b border-border-subtle px-4 py-2.5 text-[11px] tracking-[0.1em] text-text-tertiary uppercase">
              {results.length === 0 ? "No matches" : `${results.length} ${results.length === 1 ? "result" : "results"}`}
            </p>
            {results.length === 0 ? (
              <p className="px-4 py-4 text-[14px] leading-[1.6] text-text-secondary">
                Nothing in the Help Centre matches that. Try different words, or write to{" "}
                <a href={SUPPORT_MAILTO} className="font-medium text-accent hover:underline">
                  {SUPPORT_EMAIL}
                </a>
                .
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {results.map((result) => (
                  <li key={result.anchor}>
                    <a
                      href={`#${result.anchor}`}
                      className="block px-4 py-3 transition-colors duration-100 ease-out hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent/40"
                    >
                      <span className="font-numeric block text-[11px] tracking-[0.08em] text-text-tertiary uppercase">{result.section}</span>
                      <span className="mt-0.5 block text-[15px] font-medium text-ink">{result.title}</span>
                      <span className="mt-0.5 line-clamp-2 block text-[13px] leading-[1.5] text-text-secondary">{result.snippet}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
