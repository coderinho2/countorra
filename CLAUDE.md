# Countorra — Design Conventions

## Visual source of truth

[DESIGN.md](DESIGN.md) (repo root) is the primary visual source of truth for
this project. Read it before writing any frontend/UI code. Match its tokens,
type scale, spacing, and component patterns exactly. Nothing below overrides
it — the design skills exist to help *implement* DESIGN.md well, not to
compete with it.

## Design system precedence

Four things govern design work in this project. They are layered, not
interchangeable, and **must be used together on every piece of UI work** —
never independently:

1. **[DESIGN.md](DESIGN.md) — primary source of truth.** The concrete spec:
   colors, typography, spacing, component definitions, and the explicit
   design rules / things-to-avoid list. This is what gets built. Any
   conflict between DESIGN.md and anything below is resolved in favor of
   DESIGN.md, no exceptions.
2. **[design-taste-frontend](.claude/skills/design-taste-frontend/SKILL.md)
   — composition and layout.** Used where DESIGN.md is silent: page
   composition, layout structure, brief inference, and avoiding generic,
   templated, AI-generated-looking UI. It fills gaps; it does not fill
   spaces DESIGN.md already specifies.
3. **[emil-design-eng](.claude/skills/emil-design-eng/SKILL.md) —
   interaction quality.** Used for *how* motion and interaction specified in
   DESIGN.md get implemented: easing curves, transform origins, `:active`
   states, transition property selection, and general micro-interaction
   polish. It supplies craft and technique, not new motion rules — DESIGN.md
   §22 sets the durations, easings, and boundaries; emil-design-eng makes
   sure the implementation matches that spec well.
4. **[getdesign](.claude/skills/getdesign/SKILL.md) — supporting /
   re-grounding tool only.** Used only if we deliberately regenerate or
   re-ground part of DESIGN.md against a new reference site. It must
   **never** be invoked to justify a design decision during implementation,
   and it must never override DESIGN.md.

In practice: when building any screen, consult DESIGN.md first for the
spec, design-taste-frontend for anything DESIGN.md doesn't dictate about
composition, and emil-design-eng for the execution quality of any motion or
interaction involved. Using only one of these in isolation is not
sufficient — a screen that is DESIGN.md-compliant but composed generically,
or animated without craft, has not met the bar.

## Hard rules

- Never introduce a design pattern that conflicts with DESIGN.md.
- Never use animation merely for decoration — motion must serve a
  functional purpose (state change, feedback, hierarchy).
- Prefer restrained, purposeful motion over expressive or attention-seeking
  motion.
- Preserve the "quiet, paper-and-ledger trustworthy" identity (DESIGN.md
  §1–2) in every screen, not just the landing page.
- Do not fall back to generic SaaS/AI dashboard patterns — see DESIGN.md
  §26 for the explicit ban list, and re-read DESIGN.md §1 whenever a screen
  starts to feel like a generic template.
