"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  motion,
  useAnimation,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import Image from "next/image";
import { X } from "@phosphor-icons/react/dist/ssr/X";
import { cn } from "@/lib/utils";

/**
 * A draggable cylinder of product cards, with click-to-expand.
 *
 * ADAPTED, NOT COPIED. The reference version shipped fourteen random
 * `picsum.photos` city photographs, a `console.log` on every render, `any` on
 * the animation controls, and a modal with no way out but a click. What is
 * kept is the mechanism — a CSS 3D cylinder whose rotation is a motion value,
 * drag to spin, velocity handed to a spring, and a shared-element transition
 * into an expanded view. What changed is everything around it:
 *
 *   - Content is passed in, and is local (`public/showcase/*.svg`). No
 *     external image host, and every card carries real alt text.
 *   - `prefers-reduced-motion` gets a different component, not a slower one:
 *     a plain horizontally scrollable row. A 3D cylinder that spins under a
 *     drag is exactly the motion that setting exists to switch off, and
 *     DESIGN.md §22 requires honouring it.
 *   - The expanded card is a real dialog: Escape closes it, focus moves into
 *     it and returns to the card that opened it, the page behind is inert to
 *     scroll, and the scrim is `--color-ink` rather than pure black (§26).
 *   - Cards are buttons, so the carousel is operable without a pointer;
 *     arrow keys rotate it.
 *
 * DESIGN.md note: §26 bans animation without purpose, and this is the one
 * place in the product where motion IS the content — a product showcase the
 * visitor drives. Nothing loops on its own, nothing autoplays, and the whole
 * thing is inert under reduced motion.
 */

export interface CarouselCard {
  /** Local asset path, e.g. `/showcase/dashboard.svg`. */
  src: string;
  /** What the card shows, for assistive technology. Never decorative. */
  alt: string;
  /** Short caption shown under the expanded card. */
  caption: string;
}

/** `useAnimation`'s handle. Taken from the hook rather than imported: the
 *  exported name for it has changed between motion versions, and this cannot
 *  drift. */
type Controls = ReturnType<typeof useAnimation>;

const SPIN = {
  type: "spring",
  stiffness: 100,
  damping: 30,
  mass: 0.1,
} as const;
const FACE_TRANSITION = { duration: 0.15, ease: [0.32, 0.72, 0, 1] } as const;
const OVERLAY_TRANSITION = { duration: 0.22, ease: [0.16, 1, 0.3, 1] } as const;

function useIsSmallScreen(): boolean {
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 640px)");
    const update = () => setSmall(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return small;
}

const Cylinder = memo(function Cylinder({
  cards,
  controls,
  active,
  onSelect,
}: {
  cards: CarouselCard[];
  controls: Controls;
  active: boolean;
  onSelect: (card: CarouselCard) => void;
}) {
  const isSmall = useIsSmallScreen();
  // Wider cylinder, same ten faces: each face is proportionally larger, so a
  // card reads as a product surface rather than a thumbnail.
  const cylinderWidth = isSmall ? 1500 : 2600;
  const faceCount = cards.length;
  const faceWidth = cylinderWidth / faceCount;
  const radius = cylinderWidth / (2 * Math.PI);
  const rotation = useMotionValue(0);
  const transform = useTransform(
    rotation,
    (value) => `rotate3d(0, 1, 0, ${value}deg)`,
  );

  const nudge = useCallback(
    (direction: 1 | -1) => {
      controls.start({
        rotateY: rotation.get() + direction * (360 / faceCount),
        transition: SPIN,
      });
      rotation.set(rotation.get() + direction * (360 / faceCount));
    },
    [controls, faceCount, rotation],
  );

  return (
    <div
      className="flex h-full items-center justify-center"
      style={{
        perspective: "1000px",
        transformStyle: "preserve-3d",
        willChange: "transform",
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          nudge(-1);
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          nudge(1);
        }
      }}
    >
      <motion.div
        drag={active ? "x" : false}
        className="relative flex h-full origin-center cursor-grab justify-center active:cursor-grabbing"
        style={{
          transform,
          rotateY: rotation,
          width: cylinderWidth,
          transformStyle: "preserve-3d",
        }}
        onDrag={(_, info) =>
          active && rotation.set(rotation.get() + info.offset.x * 0.05)
        }
        onDragEnd={(_, info) =>
          active &&
          controls.start({
            rotateY: rotation.get() + info.velocity.x * 0.05,
            transition: SPIN,
          })
        }
        animate={controls}
      >
        {cards.map((card, index) => (
          <motion.div
            key={card.src}
            className="absolute flex h-full origin-center items-center justify-center p-2"
            style={{
              width: `${faceWidth}px`,
              transform: `rotateY(${index * (360 / faceCount)}deg) translateZ(${radius}px)`,
              // Without this the far side of the cylinder is still painted and,
              // worse, still clickable: the card facing AWAY from the viewer sits
              // over the front one in DOM order and swallowed the click, so
              // selecting a card could open the card opposite it.
              backfaceVisibility: "hidden",
            }}
          >
            <button
              type="button"
              onClick={() => onSelect(card)}
              aria-label={`Enlarge: ${card.alt}`}
              className={cn(
                "border-border-subtle bg-surface group w-full overflow-hidden rounded-lg border shadow-[var(--shadow-level-2)]",
                "transition-[box-shadow,transform] duration-[var(--duration-fast)] ease-out",
                "hover:shadow-[var(--shadow-level-3)] active:scale-[0.98]",
                "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent",
                "motion-reduce:transition-none motion-reduce:active:scale-100",
              )}
            >
              <motion.img
                src={card.src}
                alt={card.alt}
                layoutId={`showcase-${card.src}`}
                width={640}
                height={640}
                draggable={false}
                className="pointer-events-none aspect-square w-full object-cover"
                transition={FACE_TRANSITION}
              />
            </button>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
});

/** Reduced motion, or no JavaScript story at all: the same cards, in a row
 *  you scroll. Everything is still reachable and still expandable. */
function StaticRow({
  cards,
  onSelect,
}: {
  cards: CarouselCard[];
  onSelect: (card: CarouselCard) => void;
}) {
  return (
    <ul className="flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-4 max-sm:px-6">
      {cards.map((card) => (
        <li key={card.src} className="w-[min(72vw,320px)] shrink-0 snap-center">
          <button
            type="button"
            onClick={() => onSelect(card)}
            aria-label={`Enlarge: ${card.alt}`}
            className="border-border-subtle bg-surface block w-full overflow-hidden rounded-lg border shadow-[var(--shadow-level-2)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
          >
            {/* `unoptimized`: these are SVGs, which Next's optimizer declines
                to process anyway, and they are already a few kilobytes each. */}
            <Image
              src={card.src}
              alt={card.alt}
              width={640}
              height={640}
              unoptimized
              className="aspect-square w-full object-cover"
            />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ThreeDPhotoCarousel({
  cards,
  className,
}: {
  cards: CarouselCard[];
  className?: string;
}) {
  const [expanded, setExpanded] = useState<CarouselCard | null>(null);
  const controls = useAnimation();
  const prefersReducedMotion = useReducedMotion();
  /* The reduced-motion layout may only replace the cylinder AFTER hydration:
     the server cannot know the preference, so switching on it during the
     first render makes the client disagree with the server's HTML and React
     regenerates the tree. The same flag also gates the portal below, which
     needs a DOM to portal into. */
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const staticMode = mounted && prefersReducedMotion;
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  const select = useCallback(
    (card: CarouselCard) => {
      openerRef.current = document.activeElement as HTMLElement | null;
      setExpanded(card);
      controls.stop();
    },
    [controls],
  );

  const close = useCallback(() => {
    setExpanded(null);
    // Back to the card that opened it, so a keyboard user does not land at
    // the top of the document.
    openerRef.current?.focus?.();
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded, close]);

  const body = useMemo(
    () =>
      staticMode ? (
        <StaticRow cards={cards} onSelect={select} />
      ) : (
        <div className="relative h-[300px] w-full overflow-hidden sm:h-[420px]">
          <Cylinder
            cards={cards}
            controls={controls}
            active={expanded === null}
            onSelect={select}
          />
        </div>
      ),
    [cards, controls, expanded, staticMode, select],
  );

  // The dialog is portalled to <body>. `position: fixed` resolves against the
  // nearest transformed ancestor, and this carousel is full of them (the
  // cylinder, and the section's own entrance transform), so an in-place scrim
  // covered only the carousel band instead of the page behind it.
  // False while rendering on the server, true once hydrated — without writing
  // state from an effect, which this project's lint rules (correctly) refuse.

  const overlay = (
    <AnimatePresence>
      {expanded && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={OVERLAY_TRANSITION}
          onClick={close}
          className="bg-ink/40 fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-10"
        >
          <motion.div
            onClick={(event) => event.stopPropagation()}
            initial={{ scale: 0.97, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={OVERLAY_TRANSITION}
            className="border-border-subtle bg-surface relative w-full max-w-[560px] overflow-hidden rounded-lg border shadow-[var(--shadow-level-3)]"
          >
            <motion.img
              layoutId={`showcase-${expanded.src}`}
              src={expanded.src}
              alt={expanded.alt}
              width={640}
              height={640}
              className="aspect-square w-full object-cover"
              transition={FACE_TRANSITION}
            />
            <div className="border-border-subtle flex items-start justify-between gap-4 border-t px-4 py-3">
              <p
                id={titleId}
                className="text-text-secondary max-w-[46ch] text-[13px]"
              >
                {expanded.caption}
              </p>
              <button
                ref={closeRef}
                type="button"
                onClick={close}
                aria-label="Close"
                className="text-text-tertiary hover:bg-surface-sunken hover:text-text-primary rounded-sm p-1 transition-colors duration-[var(--duration-fast)] ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <X size={16} weight="bold" aria-hidden="true" />
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className={cn("relative", className)}>
      {body}
      {mounted ? createPortal(overlay, document.body) : null}
    </div>
  );
}
