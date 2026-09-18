"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * In-page navigation for Settings.
 *
 * Settings was one long column of five identical cards, which meant finding
 * "members" required scrolling and reading every heading on the way. A rail
 * of anchors turns it into a place with rooms.
 *
 * The active section is tracked with an IntersectionObserver rather than by
 * listening to scroll and measuring offsets: it fires only when a section
 * actually crosses the threshold, costs nothing between those moments, and
 * never fights the browser's own smooth scrolling. The rail is progressive
 * enhancement — the links are plain in-page anchors and work with the
 * observer disabled or the JS never running.
 */
export function SettingsNav({ sections }: { sections: { id: string; label: string }[] }) {
  const [active, setActive] = useState(sections[0]?.id);

  useEffect(() => {
    const elements = sections.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      // A band across the upper third of the scroll container: a section
      // counts as current once its heading has reached comfortable reading
      // position, not when its last pixel leaves the viewport.
      { rootMargin: "-72px 0px -60% 0px", threshold: 0 },
    );

    for (const el of elements) observer.observe(el);
    return () => observer.disconnect();
  }, [sections]);

  return (
    <nav aria-label="Settings sections" className="sticky top-0 hidden w-44 shrink-0 flex-col gap-0.5 self-start lg:flex">
      {sections.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          aria-current={active === section.id ? "true" : undefined}
          className={cn(
            "relative rounded-sm px-3 py-1.5 text-[14px]",
            "transition-colors duration-[var(--duration-fast)] ease-out",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            active === section.id ? "bg-accent-subtle font-medium text-accent" : "text-text-secondary hover:bg-surface-sunken hover:text-text-primary",
          )}
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}
