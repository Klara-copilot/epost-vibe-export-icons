# Plan: Immersive "Mission Control" Web UI (n8n / React Flow, reimagined)

> Status: **v2 — creative refinement, in implementation** · Target: `web/` (React 19 + Vite + TS)
> Direction chosen: **A) Holographic Mission Control** + **real icon-glyph packets**.
> Goal: the **canvas IS the app** — a full-bleed holographic pipeline where the
> icons you pick become luminous packets that travel the machine and materialize
> as shipped PRs. (v1 only boxed a graph inside the old card shell → still felt old.)

---

## 0. Creative Direction — "Holographic Mission Control"

Full-viewport dark canvas: animated **aurora/nebula gradient mesh** + grain,
faint hex/dot grid, subtle parallax. The pipeline floats as glowing **machine
nodes** wired by light.

**Signature moments**
1. **Packet flight** — each selected icon becomes a luminous chip that rides the
   active edges stage→stage with a light trail. *The product's identity.*
2. **Machine nodes** — live breathing "core" while running, activity read-out,
   emissive ports that light as a packet passes.
3. **Materialize on ship** — packets land in a "Shipped" node that blooms into
   theme_icons + luz_next PR cards with a particle burst.
4. **Reactive accent** — tint the accent gradient from a selected icon's hue.
5. **Kinetic type** — oversized display headings that mask/slide in.

**Art-direction tokens** (`--nebula-*`, `--grain`, `--glow-*`, reactive
`--accent-from/--accent-to`, status neons, depth layers).

**Gap v2 closes (keep v1 code, re-house it):** full-bleed canvas (not a 420px
card) · floating HUD instead of header+cards · machine nodes with a core ·
icon packets on edges · Mission Control background/depth. Reuse intact:
`api/client.ts` streaming, event model, `AutoWorkflowPage` state machine,
`WorkflowCanvas` event→graph mapping.

**Roadmap:** 1.5 Immersion (full-bleed + nebula bg + HUD) · 1.6 Packets +
machine cores + bloom-to-PR · 2 Screens reimagined (Ready hero, Selecting
inventory, Done bloom) · 3 Reactive accent, kinetic type, reduced-motion parity.

---

## 1. Vision & Principles

Turn the icon-export workflow from a "steps + log" page into an **immersive,
full-viewport living pipeline**. The run is spatial storytelling: pick icons →
watch them travel the machine → they ship.

**Design principles**
1. **The canvas is the app.** Full-bleed; no card-stack shell around a small graph.
2. **Spatial storytelling.** The user's *real selected icons* are the moving subject.
3. **Motion with meaning.** Packets = data in flight, breathing core = working, bloom = shipped.
4. **Cinematic but legible.** Depth, glow, grain — never at the cost of reading status.
5. **Accessible & fast.** Keyboard-first, `prefers-reduced-motion` swaps cinematics for fades, 60fps.

**Non-goals**
- No backend/API changes (the NDJSON `stage|log|result|session|push-retry|push-complete` stream carries everything).
- No change to workflow behavior; **Wizard mode stays as the plain advanced/fallback UI.**

---

## 2. Current State (what we're evolving)

- Stack: React 19, Vite 8, TypeScript, `framer-motion@12`, **plain CSS** with
  CSS-variable tokens (`web/src/index.css`, ~1500 lines).
- Two modes in `web/src/App.tsx`: **Auto** (`pages/AutoWorkflowPage.tsx`) and **Wizard**.
- Auto flow phases: `ready → preparing → selecting → running → done`.
- Key components (`web/src/components/auto/`): `PipelineTimeline` (vertical stage
  cards), `LiveConsole`, `SelectionSearch`, `SelectionTray`, `LaunchBar`,
  `WorkflowResultCard`, `SvgPreview`.
- Server streams typed events: `{type:'stage'|'log'|'result'|'session'|'push-retry'|'push-complete'}`.

**The redesign reuses all data plumbing** — `api/client.ts` streaming, the event
model, and `AutoWorkflowPage`'s state machine stay; only the *presentation* changes.

---

## 3. Design System Foundation (Phase 0)

Establish tokens & primitives so every later screen is consistent.

- **Tokens** (`web/src/styles/tokens.css`): formalize color scales (bg, surface,
  border, text, accent gradient, semantic success/warn/error/info), spacing
  scale, radii, elevation/shadow, blur, motion durations & easings, z-index layers.
  Dark-first with a light theme via `data-theme`.
- **Typography**: adopt a modern variable font (e.g. Inter or Geist via
  `@fontsource-variable/*`) + a mono for logs (JetBrains Mono / Geist Mono).
  Establish a type scale (display/h1/h2/body/caption/mono).
- **Motion tokens**: standard durations (fast 120ms, base 220ms, slow 400ms) and
  spring presets; a `useReducedMotion()` guard everywhere.
- **Icon set**: replace emoji glyphs with `lucide-react` for crisp, consistent chrome icons.
- **Primitives** (accessible, headless): add `@radix-ui/react-*` (Tooltip,
  Dialog, DropdownMenu, Tabs, Switch, Popover) + `sonner` for toasts.

**Styling approach decision (see §9):** keep authored CSS + tokens, OR adopt
Tailwind. Recommend **Tailwind v4 + CVA** for new components (coexists with
existing CSS during migration).

---

## 4. The Hero: React Flow Workflow Canvas (Phase 1)

Replace `PipelineTimeline` with a **`WorkflowCanvas`** built on
**`@xyflow/react`** (React Flow v12).

**Graph model** — map the stage event ids to a static node layout (auto-laid-out
left→right), lit up progressively as events arrive:

```
[ Selections ] → [ Clone theme_icons ] → [ Clone luz_next ]
                                              │
        ┌─────────────────────────────────────┤ (per selected pipeline)
        ▼                                      ▼
   [ Audit icon ] → [ Export icon ] ─┐
   [ Audit duotone ] → …            ─┼→ [ Commit theme_icons ] → [ Commit luz_next ]
   [ Audit illustration ] → …       ─┘            │
                                                  ▼
                                            [ Cleanup ] → [ ✅ Done + PR links ]
```

**Node design (`nodes/StageNode.tsx`)**
- Glass card with: icon, title, live status chip (pending / running / ok / warn / error),
  a mini progress shimmer while active, and an expandable "logs" affordance
  (click → side drawer streams that stage's lines).
- Status-driven styling: idle (muted), running (accent border + pulse glow),
  done (green check, subtle settle animation), error (red, shake-once).
- Detail line for the `detail` field (branch name, counts).

**Edge design (`edges/FlowEdge.tsx`)**
- Animated **flowing gradient / particle** along edges that are "active" (source
  done, target running) — the signature n8n/React Flow effect (SVG `stroke-dashoffset`
  or an animated marker following the path).
- Edges dim when upstream not reached; solidify + check when completed.

**Canvas chrome**
- MiniMap (bottom-right), zoom/fit controls, and "fit view" on new events.
- Auto-pan/zoom to the currently-active node.
- Background dot-grid (`<Background variant="dots" />`) with a subtle parallax.

**Run controls overlay**: floating glass toolbar (Cancel / Retry-push / Restart)
using the existing `cancelWorkflow` / `retryPushWorkflow` handlers.

**Data mapping**: a `useWorkflowGraph(events)` hook derives node/edge status from
the existing `runStages` + raw event stream — no new API needed. Only selected
pipelines' branches render (icon/duotone/illustration).

---

## 5. Screen-by-Screen Redesign (Phase 2)

Keep the phase machine in `AutoWorkflowPage.tsx`; restyle each phase.

1. **Ready / Landing** — a hero with animated gradient mesh background, product
   title, a single glowing **"Clone repositories & start"** CTA, and a small
   "how it works" 3-node mini-graph preview that animates on load.
2. **Preparing (cloning)** — the canvas appears with just the two clone nodes,
   edges pulsing; a compact retry-aware progress. Skeleton nodes for what's next.
3. **Selecting** — the star search UX:
   - `SelectionSearch` → command-palette-style search (fuzzy, already server-side),
     large legible `SvgPreview` tiles in a responsive grid, keyboard nav (↑/↓/Enter).
   - `SelectionTray` → animated chips docked in a "tray" that visually feeds into
     the graph's Selections node (shared-layout `framer-motion` transition).
   - `LaunchBar` → branch control + dry-run + **Run** as a sticky command bar.
4. **Running** — full `WorkflowCanvas` hero (Phase 1) + collapsible `LiveConsole`
   as a bottom drawer (terminal aesthetic, auto-scroll, copy button).
5. **Done / Result** — `WorkflowResultCard` reimagined: success **confetti burst**
   (reduced-motion aware), animated stat counters (exported / skipped / failed),
   prominent PR link buttons with repo glyphs, and a diff peek. Error state gets a
   clear recovery path (retry-push card already exists).

**Global chrome**
- Top bar: product mark, Auto/Wizard segmented control, bridge-status pill
  (`BridgeStatusBanner` → live dot + tooltip), theme toggle.
- Toasts (`sonner`) for transient events (copied token, cancelled, push retried).
- Command palette (`cmdk`, ⌘K): jump to actions (start, cancel, focus search,
  toggle theme, open PR).

---

## 6. Motion & Micro-interaction Catalog (Phase 3)

- **Edge flow**: animated dashes/particles on active edges (the hero effect).
- **Node state transitions**: spring pop on complete, single shake on error,
  breathing glow while running.
- **Shared-layout**: search result → tray chip → Selections node (`layoutId`).
- **Number counters**: result stats count up.
- **Confetti** on full success (`canvas-confetti`), suppressed by `prefers-reduced-motion`.
- **Skeletons & shimmer** for loading (preview grid, upcoming nodes).
- **Hover/press affordances**: subtle scale + glow on interactive elements.
- **Page/phase transitions**: `AnimatePresence` cross-fades with directional slide.
- **Reduced-motion**: a single `useReducedMotion()` gate that swaps springs for fades.

---

## 7. Accessibility & Performance

- Keyboard: full tab order, ⌘K palette, ↑/↓/Enter in search, Esc to close drawers.
- ARIA: Radix primitives for dialogs/tooltips/menus; live-region announcements for
  stage status changes; canvas nodes get `role`/`aria-label` with status.
- Contrast: verify AA on all status colors in both themes (recall the icon-preview
  stroke/fill contrast lesson — keep currentColor recoloring).
- Reduced motion honored everywhere.
- Performance: memoize nodes/edges, throttle high-frequency log appends, virtualize
  the console, keep canvas at 60fps (React Flow handles virtualization of off-screen nodes).
- Bundle: React Flow + fonts add weight — lazy-load the canvas & confetti; code-split
  Wizard mode.

---

## 8. Phased Roadmap (each phase independently shippable)

| Phase | Scope | Outcome |
|------|-------|---------|
| **0. Foundations** | Tokens, typography, motion tokens, lucide, Radix, sonner, theme toggle | Consistent base; no visual regressions |
| **1. Flow Canvas** | `@xyflow/react` `WorkflowCanvas` replacing `PipelineTimeline` in the running phase | The signature n8n-style hero |
| **2. Screen redesign** | Ready/Selecting/Done restyle, top bar, command bar, toasts | Cohesive premium flow end-to-end |
| **3. Motion polish** | Edge particles, shared-layout, confetti, counters, skeletons | "Delight" pass |
| **4. A11y & perf** | Keyboard, ARIA, reduced-motion, lazy-loading, profiling | Best-practice hardening |
| **5. (optional) Command palette + power-user** | ⌘K, shortcuts, saved presets | Pro-tool feel |

---

## 9. Dependencies & Decisions

**Proposed additions** (all popular, well-maintained):
- `@xyflow/react` — node/edge canvas (the core ask). *Required.*
- `lucide-react` — icon set. *Recommended.*
- `@radix-ui/react-{tooltip,dialog,dropdown-menu,tabs,switch,popover}` — a11y primitives. *Recommended.*
- `sonner` — toasts. *Recommended.*
- `canvas-confetti` (+ types) — success moment. *Optional.*
- `cmdk` — command palette. *Optional (Phase 5).*
- `@fontsource-variable/inter` (+ mono) — self-hosted variable fonts. *Recommended.*

**Open decisions (need a call):**
1. **Styling system** — *A)* keep authored CSS + strengthened tokens (lowest churn,
   coexists), or *B)* adopt **Tailwind v4 + CVA + tailwind-merge** for new components
   (trending, pairs with shadcn-style, but a migration). **Recommendation: B for new
   components, leave existing CSS until replaced.**
2. **Layout engine** — hand-authored static node positions vs. auto-layout
   (`@dagrejs/dagre` / `elkjs`). **Recommendation: dagre auto-layout** so adding
   pipelines/stages doesn't require manual coordinates.
3. **Scope of Wizard mode** — keep as-is (advanced) vs. also restyle. **Recommendation:
   keep functional, light token refresh only.**
4. **Confetti / heavy motion** — ship on by default (reduced-motion aware) vs. opt-in.
   **Recommendation: on, gated by `prefers-reduced-motion`.**

---

## 10. Success Criteria

- The running workflow is shown as an **animated node graph** with live status and
  flowing edges (n8n/React-Flow feel), driven entirely by existing events.
- Cohesive dark-first design system with light theme; consistent spacing/type/color.
- Delightful, meaningful motion at 60fps; fully reduced-motion & keyboard accessible.
- No regression in functionality (Auto + Wizard), no backend changes.
- New user path: `npm run setup-web-ui` → `npm run dev` → visibly premium tool.

---

## 11. Risks & Mitigations

- **Scope creep / big-bang rewrite** → strict phasing; each phase ships behind the
  same `AutoWorkflowPage` state machine; canvas replaces one component at a time.
- **Bundle bloat** → lazy-load canvas/confetti/fonts; code-split Wizard.
- **Motion overload** → motion tokens + reduced-motion gate; "calm by default".
- **Tailwind migration friction** → adopt only for new components; don't rip out
  working CSS until replaced.
- **React Flow learning curve** → start with a static graph + status coloring, add
  custom edges/particles incrementally.

---

## 12. First Concrete Steps (when approved)

1. Phase 0: add tokens file, fonts, lucide, Radix Tooltip, sonner, theme toggle.
2. Spike `WorkflowCanvas` with `@xyflow/react`: static 8-node graph + status colors
   wired to `runStages`, no custom edges yet.
3. Swap `PipelineTimeline` → `WorkflowCanvas` in the `running` phase behind a flag.
4. Iterate edges (flow animation) → screens → polish, per the roadmap.
