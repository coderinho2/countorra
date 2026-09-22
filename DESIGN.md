# DESIGN.md — Countorra

This is the visual source of truth for Countorra. It governs every screen,
component, and interaction in the product. When this document and the
[design-taste-frontend](.claude/skills/design-taste-frontend/SKILL.md) skill
disagree, **this document wins** — the skill fills gaps this document doesn't
cover (see [27. Agent Implementation Guidelines](#27-agent-implementation-guidelines)).

**Methodology.** Built with the [getdesign](.claude/skills/getdesign/SKILL.md)
skill's grounding discipline: concrete values below that are marked *(grounded)*
were read directly from computed styles on the live reference sites on
2026-09-04. Everything else — the palette, the type scale, every component
spec, and all domain-specific screens (invoices, AI chat, dashboards) — is
**original to Countorra**, synthesized from those references, not copied
from them. No layout, no component structure, and no proprietary asset from
Apple, Stripe, Ramp, or Vercel appears here.

**References and what each contributes:**

| Site | URL | Contributes |
|---|---|---|
| Apple | apple.com | Typographic restraint, frosted-glass navigation, generous whitespace, near-black-not-pure-black ink |
| Stripe | stripe.com | Trustworthy presentation of complex financial data, SaaS information density, confident restraint |
| Ramp | ramp.com | Finance-workflow patterns, hairline-border-first surfaces (not shadow-first), dashboard/table density |
| Vercel | vercel.com | Precision typography (tight tracking), consistent UI systems, Geist typeface family |

---

## 1. Design Philosophy

Countorra should feel like software a business owner trusts with their
real financial data on day one — closer to a private bank's back office or a
well-built ledger than to a consumer AI toy. The product's job is to make
serious financial information legible, not to perform "innovation" at the
user.

Three commitments drive every decision below:

1. **Clarity over decoration.** Every visual choice must make financial
   information easier to read, scan, or trust. If a gradient, shadow, or
   animation doesn't serve legibility or hierarchy, it doesn't ship.
2. **Precision over flourish.** Numbers align. Grids are respected. Spacing
   is systematic, not eyeballed. This is the Vercel/Ramp influence: a
   consistent, almost engineering-grade UI system.
3. **Quiet confidence over hype.** Apple's restraint and Stripe's polish are
   the north star — premium through craft (typography, whitespace,
   hierarchy), never through purple gradients, mascots, or "AI-ness."

If a screen could be mistaken for a generic AI SaaS template, it has failed
this document.

---

## 2. Visual Theme

**Mood:** premium, quiet, paper-and-ledger trustworthy, engineered rather than
decorated. **Audience:** business owners, bookkeepers, and finance teams
managing real money — not consumer/prosumer, not playful.

**Dominant language:** light-first, warm-neutral "paper" surfaces with a
single restrained gold accent (Graphite + Gold, §3); hairline borders instead of shadows as the
primary way surfaces separate from each other (grounded in Ramp's
`1px solid rgba(33,33,33,0.1)` card treatment); tight negative letter-spacing
on large type (a pattern present, at different intensities, on all four
references); financial figures always set in a monospaced numeral face so
columns of numbers align — a detail none of the four marketing sites need,
but which is non-negotiable for an accounting product.

### Key Characteristics
- Warm off-white "paper" background, never pure `#FFFFFF` or pure `#000000`
- Hairline 1px borders as the default separator; shadows reserved for truly floating layers (dropdowns, modals, toasts)
- One accent color (gold), used sparingly as a precision detail and never as a gradient or glow
- Financial figures always in tabular monospace, right-aligned
- Sidebar-driven app shell (not top-nav-only) once inside the product
- Status communicated by icon + text + color together, never color alone
- Motion is short and functional (120–240ms), never decorative or looping
- Radius stays modest (6–14px) — never the bubbly 20px+ "AI app" look

---

## 3. Color Palette

**Revision (2026-09-21): Graphite + Gold.** The palette was replaced
wholesale — structure, type, spacing and motion unchanged. The token names
below are the same ones the code has always used; only their values moved.

**Philosophy.** A warm-neutral base (graphite in dark mode, ledger paper in
light — never cold gray, never pure black/white) carries almost the entire
UI. A single accent — **gold** — is a precision detail, not a surface:
primary actions, active navigation, selected and focus states, key links,
small financial/AI highlights. Never a background larger than a button or
badge, never a glow, never a gradient. Financial meaning (positive /
negative / warning) keeps dedicated semantic hues that are deliberately
*not* gold, so a user never has to wonder "is this colored number a link,
or is it a dollar amount?"

### Neutrals
| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-paper` | `#F5F2EA` | `#0C0C0B` | Page background |
| `--color-surface` | `#FAF8F2` | `#191917` | Card / panel / raised surface / input fill |
| `--color-surface-sunken` | `#EEEAE0` | `#22221F` | Section bands (at 40%), recessed areas, hover fill |
| `--color-border-subtle` | `#D8D3C8` | `#2A2925` | Default hairline dividers, card borders |
| `--color-border` | `#CBC5B8` | `#36342F` | Input borders, table borders |
| `--color-border-strong` | `#ABA496` | `#4A4841` | Hover/active borders |
| `--color-text-tertiary` | `#857F73` | `#7C7970` | Placeholder, disabled, meta timestamps |
| `--color-text-secondary` | `#6F6B62` | `#A6A39A` | Labels, captions, secondary body text |
| `--color-text-primary` | `#171715` | `#F5F2EA` | Body text, default ink |
| `--color-ink` | `#0C0C0B` | `#FAF8F2` | Headings, highest-emphasis text |

### Accent — Gold
| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-gold` | `#B88932` | `#D6A84F` | FILL: primary buttons, active indicators, checked states |
| `--color-gold-hover` | `#9F7428` | `#E4BB67` | Fill hover |
| `--color-accent` | `#8A6420` | `#D6A84F` | TEXT, borders, focus rings: links, active labels |
| `--color-accent-hover` | `#6E4F17` | `#E4BB67` | Text/border hover |
| `--color-accent-subtle` | `#F1E6CC` | `rgba(214,168,79,0.12)` | Selected rows, active backgrounds |
| `--color-accent-contrast` | `#171715` | `#0C0C0B` | Text/icons on a gold fill |

Why two gold tokens in light mode: `#B88932` on paper is ~2.6:1 — right for
a button fill carrying graphite text (~6.6:1), wrong for gold *text*, which
needs 4.5:1. `--color-accent` is the deeper `#8A6420` (~4.7:1) for text,
borders and focus. In dark mode both are the brand `#D6A84F` (~8.9:1).

### AI accent — Amber (secondary)
| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-ai` | `#A35A22` | `#D98E4A` | The assistant's signal: thinking dot, insight Sparkle marks, the assistant's name label, AI-suggestion hover/selected states |
| `--color-ai-subtle` | `#F5E6D8` | `rgba(217,142,74,0.12)` | Selected AI state background |

Gold is brand and action; amber means "the assistant made or is making
this". Amber is a mark, never a surface: no amber panels, backgrounds,
gradients, glows or buttons — the send button stays gold. Roughly nine
parts graphite/gold to one part amber. Light mode is deepened to keep 4.5:1
as text (`#D98E4A` on paper is ~2.4:1).

### Semantic (financial meaning — independent of accent hue)
| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-positive` | `#3B7550` | `#6FAF82` | Income, gains, positive deltas, "paid" status |
| `--color-negative` | `#B04A3F` | `#D66A5F` | Expenses, losses, destructive actions, "overdue" |
| `--color-warning` | `#9A5B1E` | `#D98E4A` | Warnings, "draft"/"pending" — amber, kept clear of gold |
| `--color-info` | `#5E6470` | `#9AA0AA` | Informational — a quiet slate, no blue |

Each has a `-subtle` badge/cell background (light: solid tints; dark: the
hue at 14% opacity). Charts use `--color-chart-1…6`: gold, green, amber,
terracotta, warm gray, slate — distinguishable in both modes.

### Notes
Accent is used only for primary CTAs, links, active/selected states, and
focus rings — never for body copy, never as a background fill larger than a
button or badge, and never in a gradient. Semantic colors are reserved
strictly for their financial meaning and are always paired with an icon or
`+`/`−` sign, never color alone (see [24. Accessibility](#24-accessibility)).
Every color pair below meets WCAG AA (4.5:1 for text, 3:1 for large
text/icons) against its intended background.

---

## 4. Typography

**Family.** UI and body text: **Geist** (variable). Financial figures, table
numerals, invoice line items, account/reference numbers, and code-like data:
**Geist Mono**, set with tabular figures so digits align in columns.
Marketing display headlines only: **Playfair Display** (see the Display
revision below). Three faces, each with one job — no face is ever used
outside its role.

Geist is used deliberately over the LLM-default `Inter` *(the taste-skill's
own anti-default rule bans defaulting to Inter)*. It's also grounded: Vercel
serves its entire site in `GeistSans` *(grounded — `fontFamily: "GeistSans,
\"GeistSans Fallback\""` on body and h1)*. Geist and Geist Mono share the
same metrics and are free/self-hostable, which matters for a real production
app. Pairing a sans with a metric-matched mono for numerals is the single
most important typographic decision in this document — it's what makes
tables of dollar amounts actually easy to audit at a glance.

### Hierarchy
| Role | Font | Size / Line height | Weight | Letter spacing |
|---|---|---|---|---|
| Display (marketing headings) | Playfair Display | 56px / 60px | 400 | 0 |
| Display — sans alternate | Geist | 56px / 60px | 400 | −0.025em |
| H1 | Geist | 40px / 48px | 600 | −0.015em |
| H2 | Geist | 28px / 36px | 600 | −0.01em |
| H3 | Geist | 20px / 28px | 600 | −0.005em |
| H4 | Geist | 16px / 24px | 600 | 0 |
| Body Large | Geist | 17px / 26px | 400 | 0 |
| Body (default UI) | Geist | 15px / 22px | 400 | 0 |
| Small (labels, table headers) | Geist | 13px / 18px | 500 | 0.01em |
| Micro (eyebrow, badges) | Geist | 11px / 14px | 600 | 0.02em, uppercase |
| Numeric — figure | Geist Mono | 15px / 22px | 400 | 0 |
| Numeric — prominent total | Geist Mono | 22px / 28px | 500 | −0.01em |

*Grounding for the tracking pattern:* Apple runs `-0.374px` letter-spacing on
17px body text *(grounded, ≈ −0.022em)*; Stripe runs `-0.864px` on a 43.2px
heading *(grounded, ≈ −0.02em)*; Vercel runs an aggressive `-3.84px` on a
64px heading *(grounded, ≈ −0.06em)*. All three tighten tracking as size
increases. Countorra follows the same curve at a calmer intensity —
tight enough to feel precise, never so tight it feels like a marketing
stunt.

### Principles
- Body text (default UI size 15px) never exceeds a 70ch measure.
- Every dollar amount, percentage, date, and reference/account number is set
  in Geist Mono with tabular figures — no exceptions, even in prose.
- Headings use 600 weight, never 700+ — restraint over boldness.
- **Display is set in a serif, and only on marketing pages.** Revision
  (2026-09-06): the Display role moves from Geist to **Playfair Display** at
  weight 400 and **zero tracking**. A high-contrast serif at display size
  against a sans UI is the oldest device in editorial finance — it is what
  makes a page read as published rather than as shipped — and it costs
  nothing structurally because this face sets headlines only. Every figure,
  label, table and control stays Geist / Geist Mono.
  **Tracking is deliberately not negative here.** The tightening curve in
  this section was grounded in three *sans* references (Apple, Stripe,
  Vercel); a didone's thin strokes and generous sidebearings collapse under
  the same treatment, so Display sits at 0 while every Geist role keeps its
  negative tracking.
  Scope: marketing headlines. **In-app screens are unchanged** — a serif over
  a dense financial table trades legibility for flavour, which is the wrong
  trade in a ledger. The sans Display row above remains available for any
  marketing surface where the serif is not wanted.
- **The earlier weight revision still applies.** Revision
  (2026-09-06): Display drops from weight 500 to **400** at −0.025em. Both
  reference systems this document is grounded in set their largest type
  markedly lighter than their headings — Stripe runs weight 300 across its
  display scale, Vercel runs 400–450 and never bolder *(grounded)* — because
  at 56px a heavier weight stops reading as confident and starts reading as
  loud. The lighter cut buys authority through scale and tracking instead of
  through mass.
  This applies to Display only. H1–H4 stay at 600, and **in-app screens are
  unchanged**: a 400-weight heading over a dense financial table loses the
  contrast that separates a heading from its data, and §24's contrast floor
  is harder to hold at light weights on small type.
- Uppercase is reserved for Micro-scale labels only (11px), never for
  headings or buttons.
- Marketing/landing pages may use Display (56px), for hero *and* section
  headings; in-app screens never
  exceed H1 (40px) — dashboards need working density, not hero moments.

---

## 5. Spacing System

4px base unit, applied consistently everywhere — no off-grid padding.

| Token | Value |
|---|---|
| `space-1` | 4px |
| `space-2` | 8px |
| `space-3` | 12px |
| `space-4` | 16px |
| `space-6` | 24px |
| `space-8` | 32px |
| `space-12` | 48px |
| `space-16` | 64px |
| `space-24` | 96px |
| `space-32` | 128px |

Component-internal spacing (padding inside buttons, inputs, badges) uses
`space-1`–`space-4`. Layout spacing (gaps between sections, card padding)
uses `space-4`–`space-12`. Page-level rhythm (marketing sections) uses
`space-16`–`space-32`.

---

## 6. Layout and Grid

**Marketing pages:** single-column content, max-width `1200px`, centered,
`space-6` (24px) side padding on mobile, `space-10` (40px) on desktop.

**Application shell:** fixed left sidebar (`264px`, collapses to a `72px`
icon rail at `lg` and below — see [23. Responsive Behavior](#23-responsive-behavior)),
fluid content area with a `1440px` inner max-width, `space-6` gutter. Inside
the content area, a 12-column fluid grid with `24px` gutters governs
dashboard widget placement.

**Whitespace philosophy.** Marketing pages breathe — generous vertical
rhythm (`space-16`+ between sections), Apple-influenced. In-app screens are
denser by necessity (a finance workflow needs working information density,
not airy hero spacing) but never cramped: `space-4`–`space-6` between
related elements, `space-8`+ between distinct sections, always enough to let
hairline borders (not proximity alone) do the work of separating groups.

### Radius Scale
| Token | Value | Use |
|---|---|---|
| `radius-sm` | 6px | Buttons, inputs, badges |
| `radius-md` | 10px | Cards, panels |
| `radius-lg` | 14px | Modals, large containers |
| `radius-pill` | 999px | Status pills, tags only |

Kept modest on purpose — nothing above 14px except true pills. Apple's
buttons run `8px` *(grounded)*, Vercel's `6px` *(grounded)*, Ramp's cards
`12px` *(grounded)*: Countorra's scale sits in that same restrained
band, not the 20–24px "bubbly AI app" range this document explicitly bans.

---

## 7. Navigation

Two distinct navigation systems, used in different contexts:

**Marketing header** (logged-out pages): sticky, `64px` tall, frosted —
`background: rgba(250, 250, 248, 0.85)` with `backdrop-filter:
saturate(1.6) blur(16px)`, echoing Apple's frosted global nav
(`rgba(255,255,255,0.8)`, `saturate(1.8) blur(20px)`, *grounded*) at a
slightly warmer tint to match the paper background. Bottom hairline border
(`--color-border-subtle`) appears only after the page scrolls past `8px`.

**Application shell** (logged-in product): persistent left sidebar,
`264px` wide, `--color-surface` background, `1px` right border
(`--color-border-subtle`). Nav items are icon (20px) + label, `space-2`
vertical padding, `radius-sm` on the row. Active state: `--color-accent-subtle`
background fill on the row plus a `2px` solid `--color-accent` rail on the
row's left edge — not a filled pill, not a bold color shift. Hover state:
`--color-surface-sunken` background only. Section groups (e.g. "Workspace",
"Reports") are separated by an `11px` Micro-scale uppercase label in
`--color-text-tertiary`, `space-6` above each group.

Top bar within the app shell (`56px`) holds breadcrumb/page title on the
left and account/workspace switcher + notifications on the right — no
duplicate primary nav there.

---

## 8. Buttons

| Variant | Background | Text | Border | Hover |
|---|---|---|---|---|
| Primary | `--color-accent` | `--color-accent-contrast` | none | `--color-accent-hover` |
| Secondary | transparent | `--color-text-primary` | `1px --color-border` | `--color-surface-sunken` fill |
| Ghost | transparent | `--color-text-primary` | none | `--color-surface-sunken` fill |
| Destructive | transparent | `--color-negative` | `1px --color-negative` at 40% opacity | `--color-negative-subtle` fill |
| Destructive (solid) | `--color-negative` | `#FFFFFF` | none | darken 8% | 

All variants: `radius-sm` (6px), weight 500, no box-shadow at rest. Sizes —
sm: `6px 12px` / 13px text; md (default): `8px 16px` / 15px text; lg:
`12px 20px` / 15px text. Hover transitions are a `140ms ease-out` background
change only — no scale, no shadow pop (that reads as "playful startup,"
which this document bans). Disabled state: `--color-text-tertiary` text,
`--color-surface-sunken` background (primary) or `--color-border` outline
(secondary), `not-allowed` cursor, no hover response.

---

## 9. Inputs and Forms

Background `--color-surface`, `1px solid --color-border` at rest,
`radius-sm` (6px), `10px 12px` padding, 15px Geist body text. Placeholder
text uses `--color-text-tertiary`.

**Focus:** border becomes `1px solid --color-accent` plus a `2px` outer ring
in `--color-accent` at 20% opacity, `2px` offset — a calmer descendant of
Apple's dedicated focus color (`#0071E3`, *grounded*) adapted to the
gold (`--color-accent`). Focus is always visible; `outline: none` without a replacement ring is
never acceptable (see [24. Accessibility](#24-accessibility)).

**Error state:** border `--color-negative`, helper text below in
`--color-negative` at 13px, small error icon leading the helper text.

**Labels:** 13px Small weight 500, `--color-text-secondary`, `space-2` above
the field. Numeric fields (amount, quantity) right-align text and use Geist
Mono. Currency fields show the currency symbol as a fixed, non-editable
prefix inside the field, `--color-text-tertiary`.

Grouped forms (e.g. invoice line items) use `space-4` between fields within
a row and `space-6` between rows, with `--color-border-subtle` hairlines
separating repeated row groups rather than individual card wrappers per row.

---

## 10. Cards

Background `--color-surface`, `1px solid --color-border-subtle`,
`radius-md` (10px), `24px` padding, **no shadow at rest** — elevation comes
from the hairline border, directly following Ramp's card treatment
(`1px solid rgba(33,33,33,0.1)`, `radius 12px`, `boxShadow: none`,
*grounded*). Cards never nest inside cards. A card's header (if present) is
an H4 with `space-1` of secondary-text subtitle beneath it, `space-4` below
before body content.

Interactive/clickable cards (e.g. a report card) get a `--color-border`
(darker hairline) on hover — never a shadow, never a scale transform, never
a background color shift. This is a deliberate, repeated stance in this
document: **elevation is a border property here, not a shadow property**,
except at true floating layers (see [21](#21-borders-radius-and-elevation)).

Dashboards must **not** default to three identical equal-width cards in a
row — this document explicitly bans that pattern (see
[26. Design Rules](#26-design-rules--things-to-avoid)). Vary card width and
visual weight by information priority instead.

---

## 11. Tables

Tables are a first-class citizen — this is an accounting product. Header
row: `--color-surface-sunken` background, Small-scale (13px/500) labels in
`--color-text-secondary`, sticky on scroll, sortable columns show a small
caret on hover/active only (not on every column at rest). Row height `44px`
minimum (touch-friendly, matches the [24px + 2×10px padding] rhythm).
Row divider: `1px solid --color-border-subtle` — no zebra striping by
default (zebra striping is available as a density option but is off by
default; hairline dividers alone read cleaner and more Stripe/Ramp-like at
this data density).

Row hover: `--color-surface-sunken` fill, no border change. Selected row:
`--color-accent-subtle` fill plus checkbox checked. All numeric columns
(amount, balance, quantity) are **right-aligned, Geist Mono, tabular
figures** — this is the load-bearing detail for financial trust; misaligned
digits read as unprofessional in an accounting tool. Text columns
left-align. Status columns render a small pill (see
[3. Color Palette](#3-color-palette) semantic tokens): subtle-tint
background, solid-tone text, no bold fill.

Dense mode (opt-in, for power users): row height drops to `36px`, cell
padding drops to `space-2`. Empty table state follows
[16. Empty States](#16-empty-states).

---

## 12. Charts and Financial Data Visualization

A dedicated categorical palette, distinct from UI accent/semantic tokens so
charts never get mistaken for status indicators: gold, green, amber,
terracotta, warm gray and slate (`--color-chart-1…6`; light and dark values
in §3) — six muted, desaturated hues that hold up
in small multiples and stay legible in dark mode.

**Line/area charts** (cash flow, revenue trend): `1.5px` stroke, no
gradient fills except a single flat accent fill at **8–12% opacity** under
the primary series — never a rainbow gradient, never a glow. Gridlines
`--color-border-subtle`, horizontal only, no vertical gridlines. Axis labels
13px Small, `--color-text-tertiary`. Data points render on hover only (a
small filled circle + tooltip), not persistently.

**Bar charts** (category spend, monthly comparison): flat fill, `radius-sm`
top corners only, `4px` gap between bars, no 3D, no gradient.

**Tooltips:** `--color-ink` background, `--color-paper` text, `radius-sm`,
figures in Geist Mono. No shadow beyond Level 2 (see
[21](#21-borders-radius-and-elevation)).

**Sparklines** (inline in tables/cards for trend-at-a-glance): `1px`
stroke, no fill, no axes, sized to text line-height, colored `--color-positive`
or `--color-negative` based on trend direction only when the direction is
the point of the visual — otherwise neutral `--color-text-tertiary`.

No pie/donut charts as a default choice for financial breakdowns — bar or
stacked-bar reads faster for comparing amounts and avoids the "generic
SaaS dashboard" cliché.

---

## 13. Invoice UI

The invoice document itself reads like an actual paper document, not an app
panel: `--color-surface` background on `--color-paper`, generous `48px`
internal margin (print-document proportions, not app-card proportions),
`radius-md`, `1px --color-border-subtle` border, subtle Level-1 shadow only
when shown in a preview/modal context (not when embedded inline in a page).

**Header:** business logo/name top-left, invoice metadata (number, issue
date, due date) top-right, right-aligned, Geist Mono for the invoice number
and dates. A status pill (`Draft` / `Sent` / `Paid` / `Overdue`) sits beside
the invoice number using the semantic tokens from
[3](#3-color-palette): Paid → positive, Overdue → negative, Draft → warning,
Sent → info.

**Line items:** a table per [11. Tables](#11-tables) — description
left-aligned, quantity/rate/amount right-aligned in Geist Mono. Row divider
hairlines only, no borders between description and amount columns.

**Totals block:** bottom-right, `1px solid --color-border` top rule above
subtotal, tax, and total rows; the final "Total Due" row uses the
Numeric-prominent scale (22px Geist Mono, weight 500) and sits directly
against `--color-ink`, not the accent color — the total is the most
important number on the page and shouldn't compete with a link-colored
accent.

**Footer:** payment instructions / notes in Body-small, `--color-text-secondary`,
separated from the totals block by `space-8`.

Print/PDF export uses the identical type scale and spacing — the on-screen
invoice and the exported PDF must be visually identical.

---

## 14. AI Assistant / Chat UI

This is the section where "generic AI chatbot aesthetics" are most tempting
and most explicitly banned in this document. No gradient avatar blobs, no
rounded speech bubbles with drop shadows, no bouncing three-dot typing
loader, no "sparkle" iconography.

**Structure:** a panel styled consistently with the rest of the app —
`--color-surface` background, `1px --color-border-subtle` divider between
turns (not enclosing bubbles). Each turn is a flush-left text block, not a
floating bubble: a small Micro-label (`Countorra` or the user's name,
11px uppercase, `--color-text-tertiary`) above the message, then body text
at standard Body scale. Any figures, account references, or line items the
assistant cites are rendered in Geist Mono, exactly as they'd appear in a
table — the assistant's numbers must look like *the app's* numbers, not
like plain chat text.

**Assistant identity:** a small solid-color initial mark (not an avatar
illustration, not a gradient orb) — a `24px` square, `radius-sm`,
`--color-ink` background, single-letter or minimal glyph in
`--color-paper`. Understated, financial-instrument-adjacent, not
character-driven.

**Composer:** matches [9. Inputs and Forms](#9-inputs-and-forms) exactly —
same border, radius, and focus ring as every other input in the product.
No pill-shaped floating input, no shadow. Send action is a Ghost or Primary
button per [8. Buttons](#8-buttons), not a circular icon-only FAB.

**Streaming/thinking state:** a single static `4px` dot in `--color-accent`
with a slow, restrained opacity pulse (`1.4s ease-in-out infinite`,
respects `prefers-reduced-motion` by becoming static) — not three bouncing
dots, not a spinner. When text streams in, it appears as plain text
appending, no cursor-block flourish beyond a thin `1px` blinking caret at
the end of the in-progress line.

**Grounding to data:** whenever the assistant references a specific
transaction, invoice, or report, that reference renders as an inline
chip — `--color-surface-sunken` background, `radius-sm`, `1px
--color-border` — that links to the underlying record. This keeps the
assistant feeling like an analyst pointing at your books, not a chatbot
making claims in a vacuum.

---

## 15. Dashboard Design

The dashboard is the product's most important screen and the one most at
risk of defaulting to generic SaaS patterns. Explicit structure, top to
bottom:

1. **Summary row** — one large hero metric (e.g. "Net cash position," 40px
   H1 numeric scale) with its trend sparkline, alongside 2–3 smaller
   secondary metrics (22px Numeric-prominent scale) in the same row. This
   is deliberately **asymmetric**, not three-equal-cards — the hero metric
   should visually outweigh the others, matching how a business owner
   actually prioritizes "how much money do I have" over secondary figures.
2. **Primary chart** — one full-width cash-flow/revenue trend chart per
   [12](#12-charts-and-financial-data-visualization), with a lightweight
   period selector (This month / Quarter / Year / Custom) top-right of the
   chart, styled as a Ghost-button segmented control, not a dropdown.
3. **Activity table** — recent transactions or invoices, per
   [11. Tables](#11-tables), with a "View all" link (accent color, no
   button chrome) top-right of the section.
4. **Secondary widgets** (upcoming invoices, top expense categories) may
   appear below in a 2-column layout at `lg`+ — never more than 2 columns
   of widgets, to avoid the cluttered "cockpit" look this document's
   `VISUAL_DENSITY` target explicitly sits low (see
   [27](#27-agent-implementation-guidelines)).

No widget is decorative — every element on the dashboard answers a specific
financial question. If a widget can't be named as answering a question, it
doesn't belong on the dashboard.

---

## 16. Empty States

Quiet and functional: centered block, max-width `360px`, one small
`24px` line icon in `--color-text-tertiary` (never a large illustration or
mascot — illustrations read as "playful startup," which this document
bans), an H4 headline, one line of Body-small explanatory text in
`--color-text-secondary`, and exactly one primary action button. No
secondary/tertiary actions cluttering an empty state.

Table empty states render inline within the table's body area (not a
full-page takeover), same content pattern at a smaller scale (`20px` icon,
Body-small text only, action as a Ghost button).

---

## 17. Loading States

Skeleton screens that match the exact shape of the content they precede —
never a generic spinner for anything beyond initial app boot. Skeleton
fill: `--color-surface-sunken`, with a slow (`1.6s`) opacity shimmer
between `--color-surface-sunken` and `--color-border-subtle`, respecting
`prefers-reduced-motion` (falls back to a static fill, no shimmer).

Numeric skeletons are sized to plausible digit counts (e.g. a currency
total skeleton is a short mono-width bar, not a full-width bar) so the
layout doesn't jump when real data arrives. Table skeletons render 5–8
skeleton rows matching real row height. Charts show a flat skeleton
baseline, not a fake animated chart.

Full-page spinners are reserved strictly for initial authentication/app
boot, centered, `--color-accent`, no logo animation.

---

## 18. Error States

Calm, not alarming. Inline field/form errors follow
[9. Inputs and Forms](#9-inputs-and-forms). Page/section-level errors use a
bordered panel (`1px --color-negative` at 30% opacity, `--color-negative-subtle`
background, `radius-md`), a small error icon, a one-sentence plain-language
explanation, and a single recovery action (Retry / Contact support) — never
a full-bleed red screen, never a stack trace by default (available behind a
"Technical details" disclosure for support purposes).

Destructive-action confirmations (e.g. deleting a transaction) use a modal
per [21](#21-borders-radius-and-elevation) with a Destructive (solid) button
per [8. Buttons](#8-buttons) — the modal itself is never tinted red; only
the confirm button carries the warning weight.

---

## 19. Notifications

Toasts stack top-right, max 3 visible at once, each `--color-surface`
background with `1px --color-border-subtle`, `radius-md`, Level 2 shadow
(see [21](#21-borders-radius-and-elevation)), and a `4px` solid semantic-color
rail on the left edge (positive/negative/warning/info) instead of a tinted
background fill — this keeps the toast legible and calm rather than a
loud colored banner. Success/info toasts auto-dismiss after `5s` with a
thin progress underline; error toasts persist until dismissed. Icon +
message text, one optional inline action (e.g. "Undo"), no more than one
line of body text before truncating with a "view details" link.

In-app persistent banners (e.g. "Your bank connection needs attention")
use the same rail treatment, full-width within the content area, dismissible
only if the underlying issue is resolved or explicitly deferrable.

---

## 20. Icons

Single icon family throughout, `1.5px` stroke weight, line-only —
**never filled, duotone, or 3D**, monochrome inheriting `currentColor`
(so icons match surrounding text color automatically), except semantic
status icons which use their semantic token color directly. Standard
sizes: `16px` (inline with Body/Small text), `20px` (buttons, nav items),
`24px` (empty states, standalone). Icon-only buttons always carry an
accessible label (`aria-label`) and a `4px` minimum padding beyond the
icon's bounding box to maintain the `24px`+ effective hit area.

---

## 21. Borders, Radius and Elevation

Radius scale is defined in [6. Layout and Grid](#6-layout-and-grid).
Elevation is **border-first**, following Ramp's hairline-border card
treatment rather than Apple's or Stripe's occasional soft product shadows —
appropriate for a data-dense financial tool where shadows quickly turn
"cluttered."

### Levels
| Level | Use | Treatment |
|---|---|---|
| 0 | Flat surfaces, page background | none |
| 1 | Resting cards, panels, table containers | `1px solid --color-border-subtle`, no shadow |
| 2 | Dropdowns, popovers, toasts | `1px solid --color-border-subtle` + `0 4px 16px rgba(20,19,15,0.08)` |
| 3 | Modals, dialogs | `1px solid --color-border-subtle` + `0 16px 40px rgba(20,19,15,0.14)` |

### Philosophy
Depth is communicated with a `1px` hairline border at rest for every
surface up through cards and panels. Shadow is introduced only when a
layer is genuinely floating above the page (dropdown, popover, toast,
modal) — and even then it stays soft, neutral-tinted (never colored,
never using the accent hue), and modest in spread. This document
explicitly rejects "excessive shadows" and stacked/nested elevation as a
default styling choice.

---

## 22. Motion and Animation

Motion exists to clarify state changes, not to entertain. Every animation
below has a functional purpose; nothing loops indefinitely, nothing plays
on page load beyond a single subtle content entrance.

### Hover States
Buttons/links: background or text-color change only, `140ms ease-out`, no
scale/transform. Cards: border-color darken only, same timing. Table rows:
background fill, `100ms ease-out`. Nav items: background fill, `120ms
ease-out`.

### Focus States
`2px` ring in `--color-accent` at 20–30% opacity, `2px` offset from the
element, always visible on keyboard focus — never removed without a
replacement (see [24. Accessibility](#24-accessibility)).

### Transitions
| Interaction | Duration | Easing |
|---|---|---|
| Hover (color/background) | 100–140ms | `ease-out` |
| Focus ring appear | 100ms | `ease-out` |
| Dropdown/popover open | 160ms | `cubic-bezier(0.4, 0, 0.2, 1)` |
| Modal open | 220ms | `cubic-bezier(0.16, 1, 0.3, 1)` |
| Page content entrance | 240ms | `ease-out`, 8px rise + fade, once per view |
| Toast enter/exit | 200ms | `cubic-bezier(0.4, 0, 0.2, 1)` |

Animatable properties are restricted to `opacity`, `transform`, and
`background-color`/`border-color` — never `width`/`height`/`top`/`left`
(layout-triggering properties), for performance. All motion respects
`prefers-reduced-motion: reduce` by dropping to instant or near-instant
(≤50ms) transitions. No scroll-jacking, no parallax, no infinite
loop animations, no confetti/celebration effects anywhere in the product.

---

## 23. Responsive Behavior

### Breakpoints
| Name | Min width | Primary changes |
|---|---|---|
| sm | 640px | Tables collapse to stacked card-per-row |
| md | 768px | Sidebar collapses to overlay drawer (hamburger trigger) |
| lg | 1024px | Sidebar becomes persistent `72px` icon rail |
| xl | 1280px | Sidebar expands to full `264px` with labels |
| 2xl | 1440px | Content area max-width locks at `1440px`, extra space becomes page margin |

### Touch Targets
Minimum `44px` tappable size on touch devices (grounded in Apple's own
Human Interface Guidelines standard, consistent with the `44px` height of
Apple's global nav bar, *grounded*), even where the visual element (e.g. an
icon) is smaller — hit area padding makes up the difference.

### Collapsing Strategy
Below `md`, the app shell becomes single-column: sidebar → overlay drawer,
dashboard summary row → stacked (hero metric full-width, secondary metrics
2-up), charts → full-width with horizontal scroll for dense multi-series
data, tables → card-per-row with the row's primary field (description) as
the card title and remaining fields as label/value pairs.

### Image/Icon Behavior
Logos and icons use SVG at fixed sizes (no responsive scaling that
distorts stroke weight). Any illustrative imagery (marketing pages only)
uses `object-fit: cover` with defined aspect ratios per breakpoint — no
art-directed crops needed given the product's restrained, largely
photography-free visual language.

---

## 24. Accessibility

Non-negotiable for a product handling real financial data:

- **Contrast:** WCAG 2.1 AA minimum (4.5:1 body text, 3:1 large
  text/UI icons) for every token pairing defined in
  [3. Color Palette](#3-color-palette), in both light and dark mode.
- **Color is never the sole indicator.** Positive/negative amounts always
  carry a `+`/`−` sign or label in addition to color; status pills always
  carry text, not just a colored dot.
- **Focus is always visible.** No `outline: none` without the replacement
  ring defined in [22. Motion](#22-motion-and-animation); full keyboard
  navigation through every interactive element, including tables (arrow-key
  cell navigation for dense grids) and the AI assistant composer.
- **Semantic HTML.** Real `<table>` markup with `<th scope>` for financial
  tables (not `<div>` grids) so screen readers can navigate rows/columns
  correctly; real `<button>`/`<a>` elements, never `<div onClick>`.
- **Motion safety.** Every animation respects `prefers-reduced-motion`
  per [22](#22-motion-and-animation).
- **Form errors** are announced via `aria-live` regions and associated to
  their field with `aria-describedby`, not conveyed by border color alone.
- **Minimum touch target** `44px` per [23](#23-responsive-behavior),
  applied equally to mouse and touch to keep target sizing consistent.

---

## 25. Dark Mode

Light ("paper") mode is the default and the primary design target — a
financial ledger reads as a light, paper-like surface, and three of the
four references (Apple, Stripe, Ramp) present their core product in light
mode *(grounded)*. Dark mode is a fully supported, equally polished
alternate, not an inverted afterthought — informed by Vercel's dark-first
execution *(grounded: `background: rgb(0,0,0)`, text `rgb(237,237,237)`)*.

**Revision (2026-09-04):** dark mode was retuned from an earlier warmer
charcoal palette (`#121212` paper) to a true near-black foundation,
following Vercel's own grounded value more directly — a deliberate
product decision that a financial-infrastructure brand should read as
genuinely black, not dark gray, with depth coming from typography,
spacing, and hairline borders rather than a lifted page background.

**Revision (2026-09-21):** Graphite + Gold. Dark mode is the brand's
primary expression — graphite `#0C0C0B` with gold `#D6A84F` — and light
mode is its warm-paper counterpart. Both follow the operating system, as
before. Full values in [3. Color Palette](#3-color-palette).

Dark surfaces stay near `#0C0C0B`–`#22221F` — deliberately not literal
`#000000` (a truly zero-luminance fill crushes hairline borders and
prevents any surface from reading as "lifted" above it), but close enough
that the page reads as black at a glance. Depth between paper, surface,
and surface-sunken is now a ~3–7% luminance step instead of the wider
gray-on-gray range the earlier palette used — hierarchy is carried by
that subtle lift plus hairline borders and typography, not by a visibly
gray page background. Accent and semantic hues are lightened and
slightly desaturated in dark mode to hold AA contrast against dark
surfaces without turning neon — contrast against the `#0C0C0B` graphite
paper holds AA throughout. Shadows in dark mode use
higher opacity, lower blur (`rgba(0,0,0,0.4)` at Level 2/3) since ambient
dark-surface shadows read poorly with the light-mode blur values. Charts
reuse the same six categorical hues at the dark-mode-adjusted lightness
shown above.

---

## 26. Design Rules / Things to Avoid

Hard constraints. A screen violating any of these is not shippable,
regardless of how the rest of this document might be read:

- No purple/blue gradient backgrounds or "AI glow" effects, anywhere
- No excessive rounded corners — radius never exceeds `14px` except true pills
- No glassmorphism beyond the single, functional frosted marketing header in [7](#7-navigation)
- No decorative blobs, mesh gradients, or abstract shapes
- No repetitive three-equal-card layouts — vary width/weight by information priority
- No generic AI chatbot bubble UI — follow [14](#14-ai-assistant--chat-ui) exactly
- No animation without functional purpose — no looping, parallax, or scroll-jacking
- No shadows beyond Level 2/3 floating layers defined in [21](#21-borders-radius-and-elevation)
- No playful/startup tone — no mascots, no illustrated empty states, no confetti
- No pure black (`#000000`) or pure white (`#FFFFFF`) as a dominant surface color
- No color-only status indicators — always pair with text/icon
- No `Inter` as a default typeface choice, no unstyled system-font fallback shipped as final
- No misaligned or proportionally-set financial figures — always Geist Mono, tabular, aligned
- No full-page spinners outside initial app boot
- No dropdown-only chart period selectors where a segmented control fits

---

## 27. Agent Implementation Guidelines

**Precedence.** `DESIGN.md` (this file) → `.claude/skills/design-taste-frontend/SKILL.md`
(fills gaps this file doesn't address — e.g. general anti-slop layout
discipline for pages this document doesn't specifically cover) → ad hoc
judgment, in that order. Never let the skill's default `DESIGN_VARIANCE /
MOTION_INTENSITY / VISUAL_DENSITY` dials override an explicit spec above;
where this document is silent, use these dials as a starting point:
`VARIANCE: 4`, `MOTION_INTENSITY: 3`, `VISUAL_DENSITY: 5` — calmer and
denser than the skill's own `8/6/4` baseline, appropriate for a trust-first
financial product rather than a marketing-led landing page.

### Quick Token Reference
```text
            light     dark
paper       #F5F2EA   #0C0C0B   // page background
surface     #FAF8F2   #191917   // cards, panels, inputs
sunken      #EEEAE0   #22221F   // bands, recessed, hover fill
border      #D8D3C8   #2A2925   // hairlines (border-subtle)
text        #171715   #F5F2EA   // text-primary
muted       #6F6B62   #A6A39A   // text-secondary
gold        #B88932   #D6A84F   // fills: primary buttons, active bars
gold hover  #9F7428   #E4BB67
accent      #8A6420   #D6A84F   // gold for text, borders, focus
positive    #3B7550   #6FAF82
negative    #B04A3F   #D66A5F
warning     #9A5B1E   #D98E4A
```

### CSS Custom Properties
Implement the tokens in sections 3, 5, 6, and 25 as CSS custom properties
on `:root` (light) and `:root[data-theme="dark"]` / `prefers-color-scheme`
(dark), exactly as documented — do not invent parallel token names.
Component code should reference `var(--color-*)`, `var(--space-*)`, and
`var(--radius-*)` exclusively; no hardcoded hex values or pixel spacing in
component files.

### Fonts
Self-host Geist and Geist Mono (both open-source, free for commercial use).
Load via `@font-face` / framework font loader (e.g. `next/font/local` if
the stack is Next.js) — do not pull from a third-party CDN. Apply
`font-variant-numeric: tabular-nums` globally to any element carrying
Geist Mono financial figures.

### Example Prompts
- *"Build the transactions table per DESIGN.md §11: header row
  `--color-surface-sunken`, 44px rows, hairline dividers, amount column
  right-aligned Geist Mono tabular figures, status pills using the
  semantic tokens from §3."*
- *"Build the AI assistant panel per DESIGN.md §14: no chat bubbles, flush
  left-aligned turns with a Micro-label, `--color-ink` square identity
  mark, composer matching the standard input spec in §9."*
- *"Build the dashboard summary row per DESIGN.md §15: one large hero
  metric with sparkline, 2–3 smaller secondary metrics beside it —
  explicitly not three equal cards."*

### Pre-Ship Checklist (run before marking any UI work done)
1. Every color pairing meets WCAG AA contrast (§24).
2. All spacing uses the 4px scale (§5) — no arbitrary pixel values.
3. All financial figures are Geist Mono, tabular, right-aligned in tables.
4. No item from the ban list in §26 appears on the screen.
5. Focus states are visible and keyboard navigation works end-to-end.
6. Motion respects `prefers-reduced-motion` and uses only the durations/easings in §22.
7. The screen would not be mistaken for a generic AI SaaS template — if in doubt, re-read §1.

### Iteration Guide
- To adjust the accent without breaking the system: stay within a few
  degrees of gold (`#D6A84F`) and keep it a detail — gold on a large
  surface, in a gradient or as a glow reads as crypto/gaming, not finance.
  Light-mode gold used as text must keep 4.5:1 on paper (`--color-accent`).
- Semantic hues (positive/negative/warning) are fixed by financial
  convention — do not repurpose them for anything non-financial (e.g.
  don't use `--color-positive` green as a generic "success" toast color
  for a non-financial action; use it only for money-positive contexts to
  keep the color vocabulary trustworthy).
- New component families must specify a Level 0 or Level 1 elevation
  (§21) by default; only promote to Level 2/3 if the component is a truly
  floating layer.
- When adding a new data-viz series beyond the six categorical hues in
  §12, desaturate further before adding new hue families — density should
  come from more series, not louder color.
- Dark mode is not optional per component — every new component must ship
  both token sets in §25 before merge.
