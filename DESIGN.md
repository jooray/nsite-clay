---
name: nsite-clay
description: A notice board with flyers pinned to it, printed in one purple ink, for a page that edits itself.
colors:
  wall-concrete: "#d5d9dd"
  wall-concrete-deep: "#c9ced3"
  wall-ink: "#25202e"
  wall-ink-dim: "#4c4658"
  paper: "#f6f5f1"
  paper-shade: "#ebe9e3"
  paper-edge: "#d4d0c7"
  ink: "#1c1725"
  ink-dim: "#4f4960"
  riso-purple: "#5f35c7"
  riso-purple-bright: "#7a52de"
  purple-wash: "#e6defa"
  on-purple: "#fbf9ff"
  masking-tape: "rgba(222, 211, 168, 0.78)"
  pushpin-red: "#b3342f"
  ok-green: "#1f6b3a"
  bad-red: "#a3262a"
typography:
  display:
    fontFamily: "Bricolage Grotesque, Arial Narrow, system-ui, sans-serif"
    fontSize: "clamp(2.6rem, 7.2vw, 5.1rem)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Bricolage Grotesque, Arial Narrow, system-ui, sans-serif"
    fontSize: "clamp(1.8rem, 4vw, 2.7rem)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Bricolage Grotesque, Arial Narrow, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.62
  label:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.98rem"
    fontWeight: 700
    lineHeight: 1.1
  stamp:
    fontFamily: "Bricolage Grotesque, Arial Narrow, system-ui, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0.1em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.88em"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: "3px"
  chip: "4px"
  round: "50%"
spacing:
  xs: "0.4rem"
  sm: "0.7rem"
  md: "1.1rem"
  lg: "2rem"
  xl: "3.2rem"
components:
  flyer:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    padding: "clamp(1.4rem, 4vw, 2.8rem)"
  button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.8rem 1.2rem"
  button-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  button-primary:
    backgroundColor: "{colors.riso-purple}"
    textColor: "{colors.on-purple}"
    rounded: "{rounded.control}"
    padding: "0.8rem 1.2rem"
  button-primary-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-purple}"
  tear-off-tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "1rem 0.8rem 1.1rem"
    height: "9.4rem"
  tear-off-tab-go:
    backgroundColor: "{colors.riso-purple}"
    textColor: "{colors.on-purple}"
  tear-off-tab-hover:
    backgroundColor: "{colors.purple-wash}"
  progress-tab:
    textColor: "{colors.ink-dim}"
    padding: "0.95rem 0.9rem"
  progress-tab-current:
    backgroundColor: "{colors.purple-wash}"
    textColor: "{colors.ink}"
  progress-tab-done:
    textColor: "{colors.riso-purple}"
  stamp:
    textColor: "{colors.riso-purple}"
    typography: "{typography.stamp}"
    rounded: "{rounded.control}"
    padding: "0.25rem 0.6rem"
  key-ticket:
    backgroundColor: "{colors.purple-wash}"
    textColor: "{colors.ink}"
    padding: "1.4rem 1.3rem 1.3rem"
  input:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0.65rem 0.75rem"
  topbar-link:
    textColor: "{colors.wall-ink}"
    typography: "{typography.label}"
    padding: "0.5rem 0"
  language-switch-current:
    backgroundColor: "{colors.wall-ink}"
    textColor: "{colors.wall-concrete}"
    rounded: "{rounded.chip}"
  theme-toggle:
    textColor: "{colors.wall-ink}"
    rounded: "{rounded.round}"
    size: "2.4rem"
  template-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    padding: "0.7rem 0.7rem 1rem"
---

# Design System: nsite-clay

## Overview

**Creative North Star: "The Notice Board"**

The site is a wall and everything on it is a sheet of paper somebody pinned up. A page is a flyer taped or pinned at a slight tilt, and a flyer's way out is a row of tear-off tabs along its bottom edge, cut with dashed perforations. The one thing printed straight on the wall is the slim top bar. Voice is plain, concrete and unhurried: the surfaces explain what a thing is rather than selling it, and the board stays quiet around the paper.

There are two real scenes, not one inverted. Light is a bright day wall of pale cool concrete. Dark is a night street: asphalt with a purple cast under one lamp, a faint warm cone at the top of the page. Paper stays paper in both: a flyer is a sheet of paper, so its ground changes only a few steps (cool off-white by day, slightly lilac off-white at night). Nostr purple is the riso ink that prints headlines' emphasis, stamps, tabs and active states. It is never the ground of a page or a section.

The system is built from a handful of recurring flat shapes (paper, dashed cut lines, a 3px-cornered ink outline) and one soft, layered y-offset shadow. It refuses the old dark-violet gradient template, a hero over five equal buttons, same-size card grids as structure, gradient text, glows, glass, hard offset shadows, side-stripe borders, eyebrow kickers above headings, and em or en dashes in prose.

**Key Characteristics:**
- Paper on a wall: every content surface is a flyer, tilted by a small fixed angle, fixed with tape or a pin.
- Purple is ink, used on emphasis, stamps, primary actions and the "go" tab, and nowhere as a surface ground. The one tint of it that fills areas is the pale purple wash.
- Perforated dashed lines (2px) are the structural divider: tab strips, step bars, price halves, "or" breaks.
- Controls are ink-outlined, near-square (3px), and invert to solid ink on hover.
- Motion is rare: tabs hang lower on hover, new flyers settle in once, a dashed line walks while the wizard waits.

## Colors

A cool concrete wall, warm-neutral paper, near-black violet ink, and a single saturated purple that prints on top of them.

### Primary
- **Riso Purple** (#5f35c7): The ink. Primary buttons, links on paper, stamps, the "go" tab, completed step discs, emphasised words in headlines, the selected template outline. Contrast on paper is 6.9:1. Night value is #5a2fc2.
- **Riso Purple Bright** (#7a52de): Hover fills for the "go" tab, focus rings on wall and paper, the active top-bar underline, the saving status dot. Night value is #7448da.
- **Purple Wash** (#e6defa): The ink printed light. Current progress tab, key ticket, price slip, hover tint on tabs and inline code chips. Night value is #d9cff5.

### Secondary
- **Pushpin Red** (#b3342f): Only the pin head (with a lighter highlight #e86a63 and a dark rim #6d1815 inside its radial fill). Not used for UI state.
- **Masking Tape** (rgba(222, 211, 168, 0.78)): Only the tape strip on a flyer. Night value is rgba(204, 192, 140, 0.8).

### Neutral
- **Wall Concrete** (#d5d9dd): The page ground by day. Night value is Asphalt Violet (#16121d).
- **Wall Concrete Deep** (#c9ced3): Scrollbar track and the second wall tone. Night value is #0f0c15.
- **Wall Ink** (#25202e): Text printed directly on the wall (top bar, wizard intro, footer links). Night value is #ece8f5.
- **Wall Ink Dim** (#4c4658): Secondary text on the wall. Night value is #b3abc6.
- **Paper** (#f6f5f1): Flyer, dialog and card ground. Night value is #e9e6ee.
- **Paper Shade** (#ebe9e3): A second sheet: board backing sheets, template cards in the wizard, the log box, inline panels. Night value is #dcd8e4.
- **Paper Edge** (#d4d0c7): Hairline borders on screenshots, table rules, the third backing sheet. Night value is #bdb8c9.
- **Ink** (#1c1725): Text on paper, outlines of controls and inputs. Night value is #17121f. Ink is not flipped at night because paper stays light.
- **Ink Dim** (#4f4960): Secondary text on paper and every dashed perforation. Night value is #483f5a.
- **On Purple** (#fbf9ff): Text on riso purple fills, same in both scenes.
- **Success Green** (#1f6b3a) and **Error Red** (#a3262a): Log check and cross marks, error notes, status dot. Same in both scenes.

Changed by the dark scene: wall, wall-deep, wall-ink, wall-ink-dim, paper, paper-shade, paper-edge, ink, ink-dim, riso-purple, riso-purple-bright, purple-wash, masking-tape, the shadow, and a lamp tint (rgba(255, 226, 170, 0.16)) that is transparent by day. Unchanged: on-purple, pushpin-red, ok-green, bad-red. Focus outlines on the wall become #b69cff at night.

### Named Rules
**The Riso Ink Rule.** Purple prints on paper; it never becomes the page or a section ground. The only large purple fills are the "go" tab and primary buttons, which are things you tear off or press.
**The Paper Stays Paper Rule.** A flyer is light in both scenes. Dark mode changes the wall, the shadow and the ink's depth, not the idea that text sits on paper.
**The Own Scene Rule.** Light and dark are each designed values, not inversions of each other. Change a token in one scene and check the other.

## Typography

**Display Font:** Bricolage Grotesque (with Arial Narrow, system-ui), self-hosted, weights 500 to 800
**Body Font:** Atkinson Hyperlegible Next (with system-ui, Segoe UI), self-hosted, weights 400 to 700
**Label/Mono Font:** the system monospace stack, for keys, addresses, the build log and code

**Character:** A tight, poster-weight grotesque for what is shouted from the board, and a deliberately legible text face for what has to be read and trusted. The display face is always heavy (800) with negative tracking; there is no light display weight.

### Hierarchy
- **Display** (800, clamp(2.6rem, 7.2vw, 5.1rem), 1.02): The page h1 on a flyer; the index hero sets it at clamp(2.4rem, 5.3vw, 4.3rem), the wizard at clamp(2.2rem, 5.4vw, 3.3rem).
- **Headline** (800, clamp(1.8rem, 4vw, 2.7rem), 1.02): Section h2 and the wizard step title (clamp(1.8rem, 4vw, 2.5rem)).
- **Title** (800, 1.25rem, 1.02): h3, route titles (1.55rem), way-in buttons (1.15rem), tab names (1.05rem).
- **Body** (400, 1.0625rem, 1.62): All running text; the lede steps up to 1.14rem in Ink Dim at up to 62ch; reading columns cap at 70ch.
- **Label** (700, 0.98rem, 1.1): Buttons, form labels (0.92 to 0.95rem), top bar links (600, 0.95rem).
- **Stamp** (800, 0.78rem, 0.1em tracking, uppercase, Bricolage Grotesque): Stamps only.
- **Mono** (600 for keys and addresses, 0.88em to 1.05rem, 1.5 to 1.85): The key, the page address, the build log, code, language codes (0.8rem).

### Named Rules
**The Two Voices Rule.** Display face for shouted words, text face for read words. Do not set paragraphs in Bricolage or buttons' sentences in it; do not set headings in Atkinson.
**The Stamp Only Rule.** Uppercase and wide tracking belong to stamps. Nothing else is uppercased.

## Layout

A single centered column on the wall: 66rem wide for presentation pages, 50rem for narrow reading pages and 54rem for the wizard, always with 1rem side margins. Pages are a vertical stack of flyers separated by 3.2rem (3rem on How it works), starting 2.4rem below the top bar. Prose columns cap at 70ch.

Structure comes from the flyers, not from a grid of equals. The index hero is a two-column flyer (1.05fr / 0.95fr) holding the headline and a tilted live mini-page. The template wall is staggered on purpose: flyers have different tilts (about -1.2 to 1.2 degrees) and uneven top offsets, so the board looks used. Three-up flows and two-column text blocks are separated by dashed lines, never by cards.

Below 52rem the tab strip becomes two columns, hero and flow stack to one column; below 40rem flyers lose their tilt, backing sheets disappear, and the wizard's tab labels stack under their number discs. Spacing is rem-based and loose rather than a strict scale: 0.4, 0.7, 1.1, 2 and 3.2rem recur.

## Elevation & Depth

Depth is paper held off a wall. One soft, three-layer shadow with only vertical offset carries every pinned sheet, so it reads as ambient light from above; no shadow has a horizontal offset. Everything else is flat: buttons, inputs, stamps, tickets and inline panels have no shadow and are drawn with outlines or tints.

### Shadow Vocabulary
- **Flyer lift** (`--shadow`: `0 1px 1px rgba(30, 20, 50, .16), 0 10px 22px -8px rgba(30, 20, 50, .34), 0 26px 46px -22px rgba(30, 20, 50, .3)`): Flyers, dialogs, the wall-of-templates sheets on the index, the board's backing sheets, the owner's floating toolbar. Night version: `0 1px 1px rgba(0, 0, 0, .5), 0 12px 24px -8px rgba(0, 0, 0, .7), 0 30px 50px -20px rgba(0, 0, 0, .7)`.
- **Small card lift** (`0 1px 1px rgba(30, 20, 50, .14), 0 9px 14px -9px rgba(30, 20, 50, .4)`): Template choices inside the wizard, which sit on a flyer and need less lift.
- **Tape and pin** (`0 1px 2px rgba(30, 20, 50, .22)` and `0 3px 4px rgba(20, 10, 30, .4)`): The fixings' own contact shadows.
- **Hanging stub** (`0 10px 14px -10px rgba(30, 20, 50, .55)`): The current wizard tab only.
- **Screenshot lift** (`0 6px 18px -10px rgba(30, 20, 50, .5)`): Figures in reading columns.

### Named Rules
**The Light From Above Rule.** Every shadow is a y-offset with negative spread. No horizontal offsets, no hard offset blocks, no glows.
**The Lamp Is Not A Glow Rule.** The only light effect is the night lamp: a wide, faint warm cone fixed at the top of the wall (70rem by 36rem, rgba(255, 226, 170, 0.16)). It lights the wall, never an element.

## Shapes

Paper is square-cornered. Controls, inputs, stamps, code blocks, dialogs and flyers use 3px corners or none (3px on controls, 4px on language chips); circles (50%) are reserved for the theme toggle, step number discs, the pin, status dots and browser dots in the mini-page. The silhouette is defined by dashed lines: 2px dashed tab strips and dividers, 2px dashed borders on tickets and notices, a 1px dashed line for details panels, 1px dotted rules for list items. Tape ends are notched with a clip-path. Tilt is the other shape device: flyers rotate within about 1.5 degrees, stamps are tilted -3 degrees, done-step discs -8 degrees. Borders are always full outlines, never a single-side stripe.

## Components

### Flyer
A sheet of paper on the wall. Paper ground, Ink text, padding clamp(1.4rem, 4vw, 2.8rem), flyer-lift shadow, rotated by a per-flyer tilt (--tilt, within about 1 degree) around its top edge. Fixed with one of two fixings: **tape** (a notched masking-tape strip, 6.4rem by 1.7rem, centered on the top edge, rotated -2.5 degrees) or **pin** (a 0.95rem red radial-gradient head). New flyers settle in once (0.6s, rising 14px, only when reduced motion is not requested). Tilt is removed below 40rem. The wizard stacks two untilted backing sheets (Paper Shade and Paper Edge, rotated -1 and 0.8 degrees) behind its flyer.

### Buttons
- **Shape:** 3px corners, 2px Ink outline, transparent ground; Label type, padding 0.8rem 1.2rem (small variant 0.55rem 0.85rem).
- **Hover / Focus:** hover inverts to solid Ink with Paper text over 120ms; active presses down 1px; disabled drops to 45% opacity. Focus is a 3px Riso Purple Bright outline offset 3px (Riso Purple inside flyers, #b69cff on the night wall).
- **Primary:** Riso Purple fill and border, On Purple text; hover goes to Ink. One primary per decision.
- **Textlink button:** an unstyled button rendered as an underlined purple link for quiet choices.
- Way-in choices in the wizard are full-width outlined rows with a title in the display face, a dim sentence, and a purple arrow; the "I have nothing yet" group differs by a dashed outline and Purple Wash ground.

### Tear-off tabs
The entrances. A strip of six equal stubs along the bottom edge of a flyer, bled to the flyer's edge, separated by 2px dashed lines, with a dashed line above. Each tab holds a display-face name, a one-line dim description and an arrow, min-height 9.4rem. The "go" tabs (first two: have a key, need one) are Riso Purple with On Purple text. On hover or focus a tab tilts (1.2 degrees, alternate tabs -1.4) and drops 0.45rem, as if pulled, over 200ms; non-go tabs take Purple Wash. At 52rem and below they become two columns.

### Progress tabs (wizard)
Four stubs across the top of the wizard flyer, bled to its edges with a dashed bottom line: a numbered disc and a label. Upcoming steps are Ink Dim outlined discs. Done steps are inked: purple text and a filled Riso Purple disc rotated -8 degrees like a stamp. The current step is pulled out: Purple Wash ground, Ink text, extending 0.4rem lower, with the hanging-stub shadow. Reachable steps get a pointer, lower 0.25rem on hover and underline their label. Labels stack under the discs below 40rem.

### Stamp
A rubber-stamp label: Riso Purple 2px outline, 3px corners, 0.78rem uppercase display type at 0.1em tracking, rotated -3 degrees, padding 0.25rem 0.6rem. Used for status ("done", "your key"). Often positioned half off the corner of what it labels on a Paper ground.

### Key ticket
The one-time key shown at account creation. Purple Wash ground, 2px dashed Riso Purple outline, padding 1.4rem 1.3rem, with a stamp hung off the top-right corner. The key itself sits in a white, 2px Ink-outlined mono box that selects all on click. A confirm row below is a 2px Ink outline with a 1.5rem checkbox. The price slip uses the same ticket language (Purple Wash, dashed or solid purple outline, a display-face total in purple at 2.9rem, two halves split by a dashed line).

### Inputs / Fields
- **Style:** white ground, 2px Ink outline, 3px corners, padding 0.65rem 0.75rem, text-face 1rem; placeholder #6c6578. Labels are 700 at 0.92 to 0.95rem above the field. Mono fields for addresses and keys. Checkboxes and radios take Riso Purple as accent.
- **Focus:** a 3px Riso Purple Bright outline offset 1px.
- **Error:** a note in Error Red below the field; no red border system. Disabled drops to 45 to 50% opacity.

### Navigation (top bar)
Printed directly on the wall, no panel. Brand mark and name in the display face (800, 1.2rem) pushed left; links in 600 0.95rem Wall Ink with no underline until hover, when a 3px Riso Purple Bright underline (offset 0.35em) appears; the current page keeps it. The language switch is a row of mono codes (EN, ES, SK, CS, 0.8rem); the current one is inverted into a Wall Ink chip with Wall Concrete text. The **theme toggle** is a 2.4rem circle with a 2px Wall Ink outline holding a sun or a moon; hover fills it Wall Ink. It follows the system preference until the visitor chooses, then remembers the choice. The bar wraps rather than collapses on narrow widths.

### Template wall
Twelve real templates shown as pinned flyers with screenshots, not as a uniform grid. Each is a Paper sheet with a 16:10 screenshot cropped from the top, a pin head at a varying horizontal position, an alternating tilt (about -1.2 to 1.1 degrees) with staggered top margin, a display-face title and two small outlined actions (preview, and a primary use action). Hover straightens it and lifts 4px. On the index a smaller wall of five (Paper Shade, no pin) is laid out with mixed spans; in the wizard the choices are Paper Shade cards with the small card lift, a selected one gets a 3px Riso Purple outline. Below 62rem the wall is two columns, below 40rem one column without tilt.

### Dashed cut and working mark
`hr.cut` and the "or" divider are 2px dashed Ink Dim lines. While the wizard waits, a 6px dashed Riso Purple bar walks left to right (only when reduced motion is not requested).

## Do's and Don'ts

### Do:
- **Do** put content on paper (a flyer) and let the wall carry only the top bar, intro and footer.
- **Do** print in one ink: Riso Purple (#5f35c7) for emphasis, primary actions, stamps and active states.
- **Do** separate sections with 2px dashed Ink Dim lines, and make entrances tear-off tabs.
- **Do** use one primary button per decision and let the rest be outlined Ink.
- **Do** use the single flyer-lift shadow for anything pinned, and keep everything else flat.
- **Do** design the night wall as its own scene: Asphalt Violet ground, lilac-white paper, lamp cone at the top.
- **Do** set shouted words in Bricolage Grotesque 800 with -0.025em tracking and read words in Atkinson Hyperlegible Next.
- **Do** keep the 3px focus outline visible on every control, and honor reduced motion.

### Don't:
- **Don't** use the old dark-violet gradient template look: no purple page grounds, no gradient washes.
- **Don't** put a hero over five equal buttons, or build structure from same-size card grids; stagger and tilt instead.
- **Don't** use gradient text, glows, glass or blur.
- **Don't** use hard offset shadows or any shadow with a horizontal offset.
- **Don't** use side-stripe borders; a border is a full outline or a dashed divider.
- **Don't** put an eyebrow or kicker label above a heading. A stamp marks status or a name; it does not introduce a heading.
- **Don't** uppercase anything except stamps.
- **Don't** use em or en dashes in prose in any language.
- **Don't** flip paper to dark in dark mode.
