# Attribution and third-party material

This plugin is GPL-3.0-or-later. That imposes obligations on us when we take other people's work,
and the obligations differ sharply depending on *what* we take. Getting this right is cheap if
done at the time and awkward to reconstruct later, so the rule is written down here.

## The rule

**Ideas are free. Code is not.**

| What we take | Legal obligation | What we do anyway |
| --- | --- | --- |
| A feature idea, a UI concept, "they solved it this way" | None — ideas are not copyrightable | Credit them here and in the commit. It costs a line. |
| An algorithm re-implemented from a description or from reading their code | None in most cases, but the line between "re-implemented" and "translated" is thinner than people think | Credit here, name the source in the module comment, and be honest in the commit about how closely we followed it |
| Actual source code, copied or adapted | The source licence applies — for MIT, its copyright line and permission notice must travel with it | Keep the notice in the file itself **and** list it in `THIRD-PARTY-NOTICES.md` |

If you are unsure which column you are in, you are in the third one. Write the notice.

**Licence compatibility.** MIT, BSD and ISC code can be incorporated into a GPL-3.0 work; the
combined result is GPL-3.0, and the permissive notice stays attached to the portions it covers.
The reverse is not true, and code under a licence that is *not* GPL-compatible cannot be
incorporated at all, however small the fragment.

## Sources we have drawn on

### G-Code Modifier — github.com/little-did-I-know/Gcode

**Licence:** MIT, `Copyright (c) 2026 little-did-I-know`. Standard text, no additional clauses.

A browser-based G-code visualiser, analyser and modifier — WebGL layer viewer, thermal and
structural analysis, warp prediction, hole detection with automatic pauses, move-by-move
simulation, and in-viewport editing. Zero dependencies, builds to a single HTML file.

**Status: ideas only. No code has been taken.** Several features on our roadmap were prompted by
their feature list — see the "Prompted by G-Code Modifier" section of
[feature-ideas.md](feature-ideas.md), where each one names the origin. Our implementations are
written from scratch against our own tokeniser and pipeline, because the two projects are shaped
completely differently: theirs is a standalone visual editor, ours is a headless transformation
pipeline inside DWC.

**If that changes** — if anyone reads their source and adapts an algorithm from it rather than
re-deriving one — then: add the MIT notice to the file, add an entry to `THIRD-PARTY-NOTICES.md`,
and say plainly in the commit message which project it came from. Do not quietly upgrade "inspired
by" into "adapted from" without the notice following.

### ArcWelderLib — github.com/FormerLurker/ArcWelderLib

**Licence:** AGPL-3.0. Not GPL-compatible in the direction that matters here — this plugin cannot
incorporate ArcWelderLib source at all, at any size, which is exactly why the second row of the
table above is the one that applies.

The reference implementation of "weld runs of straight moves back into `G2`/`G3` arcs" — the
algorithm `model/gcode/arcFit.ts` (task 08) implements. **Status: algorithm re-implemented from its
published, described behaviour — the three-point circumcircle fit, the radial-and-perpendicular
deviation test, the arc-length-versus-polyline-length check, the buffer-and-restart structure — not
from reading or translating its source.** Our version is written from scratch against this plugin's
own tokeniser, `LineContext` and `Transform` contract, which look nothing like ArcWelderLib's own
C++ structure (a point buffer, a segmented-shape class hierarchy, a command-line tool). The
firmware-facing numbers it must satisfy (RRF's centre-format `I`/`J` requirement, its 0.05mm radius
tolerance) came from reading RepRapFirmware's own source directly, not from ArcWelderLib.

Named in `arcFit.ts`'s module comment, per the rule above.

### PrusaSlicer, OrcaSlicer

Behaviour we deliberately match rather than code we use: the semantics of *G-code Substitutions*
(literal/regex, case, whole-word) are copied as a **specification**, so an existing rule ports
across unchanged. No PrusaSlicer code is present. PrusaSlicer is AGPL-3.0, which would be a
significant constraint if it ever were — another reason to keep the line clean.

### dwc-plugin-runtime, dwc-plugin-test-kit

MIT, by the same author as this plugin. `dwc-plugin-runtime` is bundled into the shipped ZIP as a
normal dependency and its licence travels in the package.

## Adding a new source

1. Record it here: name, URL, licence, copyright line, and which column of the table above it sits in.
2. If code: notice in the file, entry in `THIRD-PARTY-NOTICES.md`, and mention it in the commit.
3. If a bundled runtime dependency: check the licence is GPL-compatible before adding it. See
   `docs/scripting-engines.md` for the candidates already assessed — quickjs-emscripten is MIT,
   Pyodide is MPL-2.0, both compatible.
