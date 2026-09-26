# Punch design system - Bauhaus + Bento + Utilitarian

This is the visual contract for every Punch surface: the public website (landing, watch board, console) and any future UI. `tokens.css` is the single source of values, `components.css` the reference implementation, `mockups.html` the rendered example of all three pages (`mockups-body.html` is the fragment it wraps; edit the fragment, then rebuild). Read this file first; copy from the CSS; do not restyle by hand.

## 1. The three influences and what each contributes

| Influence | What we take | What we refuse |
| --- | --- | --- |
| **Bauhaus** | Three primaries with one meaning each. Geometry carries state (circle, square, triangle). Heavy geometric grotesk type, tight tracking. Thick ink borders. Asymmetric but gridded composition. | Decorative use of the primaries. Gradients. Ornament. |
| **Bento** | A 12-column grid of tiles with unequal spans and a single gutter. Each tile owns one job and one label. Rounded tile corners. | Nested cards. Tiles without a label. Shadows or elevation. |
| **Utilitarian** | Monospace uppercase labels. Dense, honest numbers. Every state has a word next to its glyph. No hover-only information. One motion duration. | Skeleton shimmer, spinners as decoration, marketing gloss, hidden controls. |

The result should read like an instrument panel printed on paper: warm off-white canvas, ink lines, and three colors that only appear when they mean something.

## 2. Tokens (from `tokens.css`)

**Surfaces.** `--bz-paper #F3EFE6` canvas. `--bz-paper-2 #E8E2D4` alternate tile. `--bz-ink #121212` text, borders, dark tiles. `--bz-ink-2 #5B5750` secondary text. `--bz-ink-3 #A39E93` hairlines and disabled.

**Primaries, one meaning each. Never swap them.**

| Token | Hex | Means | Appears on |
| --- | --- | --- | --- |
| `--bz-blue` | `#1F48C5` | running, active, the primary action | running glyph and chip, budget fill, primary button, active tab underline, user chat bubble |
| `--bz-red` | `#E4321B` | failed, stop, irreversible, deny | failed glyph and chip, Kill and Deny buttons, Stop, failed tile tint |
| `--bz-yellow` | `#F5C518` | attention: stalled, takeover, a human is needed | takeover banner tile, stalled glyph, approval tile border, budget fill past 80 percent |

Done is ink. Pending is ink-3. Nothing else is colored.

**Structure.** Border `2px` ink everywhere, including tiles, buttons, inputs, and bars. Tile radius `10px`; every inner control is square. Gutter `10px`. Tile padding `14px`. No shadows at any level.

**Type.** Display and body: Space Grotesk (fallback Futura, Helvetica Neue, Arial). Labels, numbers, code, chips, inputs: JetBrains Mono. Scale: label 10, body 13, lead 16, h3 18, h2 28, h1 44 px. Display tracking `-0.02em`; label tracking `0.08em` uppercase. Numbers are tabular.

**Motion.** One duration `180ms`, one curve `cubic-bezier(.2,.7,.2,1)`. Used for tile state changes and button press. Nothing bounces, nothing fades in on load.

## 3. Layout rules

- The page is a `.bz-grid` of 12 columns. Tiles span 3, 4, 5, 6, 8, or 12 columns; rows may span 2. Choose spans by information weight, not symmetry: the thing the viewer must see first gets the widest tile in the first row.
- Every tile starts with a `.bz-label` (mono, uppercase) naming its one job. A tile with two jobs is two tiles.
- Under 900px every tile spans 12 and stacks in DOM order. Put the most important tile first in the DOM.
- Text wraps; it never truncates silently. If a value can be long (model ids, repo names) it is mono and allowed to break anywhere.

## 4. Components

**Status glyph `.bz-glyph`.** Shape is the state; color repeats it; a word always follows.

| State | Shape | Color | Class |
| --- | --- | --- | --- |
| running | circle | blue | `run` |
| done | square | ink | `done` |
| pending / waiting | triangle outline | ink-3 | `wait` |
| stalled, takeover, needs human | triangle filled | yellow | `warn` |
| failed | rotated square | red | `fail` |
| replaced | outline square | ink-3 | `replaced` |

**Agent tile `.bz-agent`.** Role name bold, agent id and provider in mono, one meta line, standby list in mono ink-3. State modifiers: `running` (blue inset ring), `failed` (red tint), `replaced` (dashed ink-3, muted), `done` (paper-2). A replaced agent stays visible under its successor, indented, never deleted.

**Chip `.bz-chip`.** Square, mono, uppercase. Fills follow the primaries table. Use for slot state and mode only, never for prose tags.

**Bar `.bz-bar`.** Square track with ink outline, a single fill. Blue by default; yellow past 80 percent of a budget; red when a cap has been hit. Probability rows `.bz-prob` are label, bar, number with the number in mono.

**Buttons `.bz-btn`.** Square, 2px ink border. `primary` blue, `danger` red, `ink` dark. Disabled is outline in ink-3. Segmented control `.bz-seg` for mode toggles. Kill, Deny, and Stop are always `danger`; Approve and Run are `primary`.

**Inputs `.bz-input`, `.bz-select`.** Square, mono value, ink border. Selects draw their own chevron with two ink triangles.

**Takeover banner `.bz-banner`.** Yellow tile, ink type. First line states who failed, why, when, and who is taking over. Then exactly three facts: why this replacement, what was handed over, detection-to-takeover time. This tile appears at the top of the grid whenever a slot is `replacing` and stays until the run ends.

**Log `.bz-log`.** Ink background, mono, 11px. Color only on status tokens: ok, info, warn, err, dim. Tool lines read `STATUS tool_name argument  latency`. Slot transitions are prefixed `x` (fail) or `>` (replacing) and colored.

**Plan graph.** Inline SVG. Nodes are rectangles with 2px ink stroke; fill follows state (done ink with paper text, running blue with paper text, pending paper with dashed stroke). Edges are 2px ink with arrowheads. A taken-over node gets a one-line mono caption beneath in ink-2.

**Timeline.** Inline SVG. One row per slot, bars follow state fill, the kill moment is a 6px red bar, the detection gap is a red hairline with a mono duration label, the "now" cursor is a dashed blue vertical line.

**Browser frame `.bz-frame`** is for mockups only, not product UI.

## 5. Page compositions

**Landing.** Row 1: hero tile spanning 8 (h1, lead, two buttons) beside an ink GitHub tile spanning 4 with the repo url in mono. Row 2: three tiles spanning 4 each for Plan (red circle), Delegate (blue square), Recover (yellow triangle). Row 3: six feature tiles spanning 4 each, every one ending with a mono link to the trace moment that proves it. Row 4: ink "run it locally" tile spanning 6 with commands, and an architecture note spanning 6.

**Watch board.** Row 1: run tile spanning 8 (run id, mode chip, repo, state chip, Stop) and budget tile spanning 4 (three bars with mono numerators). Row 2: takeover banner spanning 12 when active. Row 3: slots tile spanning 3 and two rows; plan graph spanning 5; logs tile spanning 4 and two rows. Row 4 under the graph: routing card spanning 5. Row 5: timeline spanning 12 with replay controls right-aligned in the label row. Live and replay are the same composition.

**Console.** Row 1: pairing strip spanning 12 (status glyph, engine url mono, config summary chip, two ink buttons). Row 2: controls tile spanning 7 (orchestrator select, mode segment, chaos select) and live slots tile spanning 5 with Kill buttons. Row 3: conversation tile spanning 7 (messages, input, Send) and approval tile spanning 5 with yellow border when a request is pending. Row 4: manual routing tile spanning 5 under approval.

## 6. Do and do not

- Do put a glyph and a word on every state. Do not rely on color alone.
- Do use the primaries only for their meaning. Do not use blue as a brand accent on a heading.
- Do keep borders 2px ink. Do not introduce 1px grey hairlines except `.bz-bar.thin`.
- Do let tiles differ in size. Do not pad a grid into equal squares.
- Do show numbers in mono with units. Do not round a cost to hide it.
- Do animate a state change once, 180ms. Do not add loading shimmer or celebratory motion.

## 7. Implementing in Next.js

- Load Space Grotesk 500/700 and JetBrains Mono 400/600 through `next/font/google` and map them to `--bz-font-display` and `--bz-font-mono` on `<html>`.
- Import `tokens.css` and `components.css` globally; keep them as plain CSS so the design stays framework-independent. Tailwind may be used for spacing and grid spans with a theme extension that maps colors to the `--bz-*` variables, but component looks come from `components.css`.
- The watch board renders from a trace reducer; every visual state above maps to a slot state or event kind in `plan.md` section 3.7. Never invent a visual state that has no event behind it.
