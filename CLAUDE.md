# duet-gcode-postprocessor — project notes for Claude

**This plugin.** A DuetWebControl 3.7 plugin that post-processes G-code files already on the
Duet's SD card: browse, inspect, apply an ordered recipe of transformations (find/replace,
command mapping, layer-anchored insertion, parameter rewriting, rules/scripts), preview the diff,
write back safely.

- **Read [PLAN.md](PLAN.md) first** — architecture, phased delivery, verified DWC platform
  findings, and the safety rules. [FEATURES.md](FEATURES.md) is the prioritised feature list.
- Plugin id `GCodePostProcessor`, camelCase id `gCodePostProcessor`, route `/Plugins/GCodePostProcessor`.
- Sibling plugins to copy patterns from: `duet-tool-align`, `duet-eddy-align`, `Flexible-Layouts`,
  `ClosedLoopTuningPlugin` (all under `C:\Users\live\Documents\Github\`).

**Non-negotiables for this plugin specifically:**

1. All transformation logic lives in `src/model/` as pure, unit-tested modules. `.vue` files
   render and delegate. Golden-file tests over real slicer output are the primary safety net.
2. Never write over a file without a backup, an atomic temp-then-move, and a post-write size
   check. Never touch the file currently printing.
3. Dry run is the default; applying is always a second, explicit user action.
4. The heavy work runs over a **chunked Blob read on the main thread, yielding every ~16 ms** —
   never load a 200 MB G-code file into a JS string. A Web Worker was the original plan and is
   still the right destination, but the bundle is a single IIFE with no dynamic `import()`, so a
   worker would need the whole pipeline inlined into it at build time. `model/io/transfer.ts`
   documents this; see `docs/scripting-engines.md` for the route.

Everything below is the general DWC 3.7 plugin scaffolding guide this repo was started from.

---

# DWC 3.7 plugin — scaffolding guide

This file is a reusable reference for setting up a **new** DuetWebControl 3.7 Vue plugin from scratch.
Copy it into a fresh repo as `CLAUDE.md` before starting a new plugin. It's distilled from three working
plugins (ClosedLoopTuningPlugin, bd_pressure_dwc_plugin, flexible-layouts-example-plugin) plus the
`dwc-plugin-runtime` and `dwc-plugin-test-kit` source — all by the same author (jaysuk / James Skitt).

Once the new plugin exists, replace this file with one describing *that specific plugin* (or keep a
trimmed version of this as background + a "this plugin" section on top).

## What a DWC plugin actually is

A DWC plugin is a Vue 3 component bundle, built externally and installed as a ZIP through
**Settings → General → Plugins → Install plugin**. It is *not* bundled into DWC's own build — it imports
DWC's externalised API (`@/plugins`, `@/stores/*`, `vue`, `vue-router`, `pinia`, `vuetify/components`,
`@duet3d/*`) at runtime via `window.DWC.*`. Nothing else under `@/...` resolves; don't reach for DWC
internals that aren't in that list.

## Quick start checklist

1. `plugin.json` — manifest (see below). `id` must be globally unique.
2. `package.json` — deps on `dwc-plugin-runtime` (prod) and `dwc-plugin-test-kit` (dev), standard scripts.
3. `vitest.config.ts` — one line, delegates to `dwc-plugin-test-kit/vitest`.
4. `src/index.ts` — entry point: register a route (and optionally an embeddable widget), wire up error
   capture + self-update, tear down on `dwcPluginUnloaded`.
5. `src/model/constants.ts` — the plugin's IDs (see naming convention below) so nothing is typed twice.
6. `src/components/*.vue` — actual UI.
7. `src/i18n/en.json` — strings, registered via `registerPluginMessages`.
8. `src/__tests__/*.test.ts` — pure-logic unit tests. `test/component.test.ts` — mount smoke test.
9. `.github/workflows/ci.yml` — one line, reuses `dwc-plugin-test-kit`'s shared workflow.

## `plugin.json` manifest

```jsonc
{
  "id": "MyPlugin",                 // unique, alphanumeric + spaces/dots/dashes, max 32 chars
  "name": "My Plugin",              // display name, max 64 chars
  "author": "Your Name",
  "version": "1.0.0",               // semver
  "license": "GPL-3.0-or-later",
  "homepage": "https://github.com/jaysuk/my-plugin",
  "dwcVersion": "auto-major",       // or "auto", or an exact "3.7.0-alpha.7" to pin
  "tags": ["category", "keywords"]
}
```

`dwcVersion: "auto-major"` (the convention every observed plugin uses) means the plugin targets whatever
major DWC version is installed. Only pin an exact version if you depend on a very recent DWC API (e.g.
`registerEmbeddableComponent`, which needs 3.7.0-alpha.7+).

## `package.json`

```jsonc
{
  "name": "my-plugin",
  "version": "1.0.0",
  "private": true,
  "license": "GPL-3.0-or-later",
  "homepage": "https://github.com/jaysuk/my-plugin",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "typecheck": "dwc-plugin-typecheck",
    "verify-build": "dwc-plugin-verify-build"
  },
  "dependencies": {
    "dwc-plugin-runtime": "^0.8.7"
    // + "chart.js": "^4.4.6" only if you're plotting data
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.4",
    "@vitest/coverage-v8": "^4.1.8",
    "@vue/test-utils": "^2.4.6",
    "dwc-plugin-test-kit": "^0.2.6",
    "happy-dom": "^15.11.7",
    "vitest": "^4.1.8",
    "vue": "^3.5.30",
    "vuetify": "^4.1.0"
  }
}
```

Both `dwc-plugin-*` deps are published to the **npm registry** now — plain semver ranges, a normal
`npm install`/`npm update` upgrades them like any other dependency. (Earlier plugins in this family
pinned `github:jaysuk/...#vX.Y.Z` refs because the packages weren't on npm yet; if you see that
pattern in an older plugin's `package.json`, it predates the npm publish and is safe to switch over.)
`dwc-plugin-runtime` is a real **dependency** (it ships *inside* the plugin bundle, has zero runtime
deps of its own, and never imports `@/stores/*` — you pass it whatever state it needs).
`dwc-plugin-test-kit` is **dev-only** and externalised.

## File layout

```
my-plugin/
├── plugin.json
├── package.json
├── vitest.config.ts
├── .github/workflows/ci.yml
├── src/
│   ├── index.ts                  # entry point — see below
│   ├── components/
│   │   ├── MyPluginPage.vue      # main page
│   │   └── MyPluginWidget.vue    # optional: compact Flexible-Layouts widget
│   ├── model/
│   │   ├── constants.ts          # IDs, paths, localStorage keys, docs URLs
│   │   ├── updateCheck.ts        # self-update wiring (boilerplate, see below)
│   │   └── ...                   # pure logic modules — unit-test these directly
│   ├── i18n/
│   │   └── en.json
│   └── __tests__/
│       └── *.test.ts             # pure-logic tests (no DOM)
└── test/
    └── component.test.ts         # mount smoke test(s), via dwc-plugin-test-kit
```

Keep business logic (parsing, math, decision-making) in `src/model/*.ts`, unit-tested directly with
plain `vitest` — no DOM, no mocking. Keep `.vue` files thin: they call into `model/`, own reactive state,
and render. This is the single biggest thing that makes plugins pleasant to maintain and test.

## `src/model/constants.ts` — naming convention

Every observed plugin defines the same handful of IDs, so nothing is duplicated between `plugin.json`,
routes, i18n keys and localStorage:

```ts
export const PLUGIN_MANIFEST_ID = "MyPlugin";         // == plugin.json "id" — used for route/widget teardown, update hub
export const PLUGIN_ID = "myPlugin";                  // camelCase — i18n key prefix "plugins.myPlugin.*"
export const ROUTE_PATH = "/Plugins/MyPlugin";        // nav path, keep under /Plugins/<id>/...
export const EMBEDDABLE_ID = "MyPlugin.Widget";        // only if you register an embeddable widget
export const DOCS_URL = "https://github.com/jaysuk/my-plugin";

export const LS_UPDATE_ENABLED = "myPlugin.updateCheck.enabled";
export const LS_UPDATE_LAST = "myPlugin.updateCheck.lastCheck";
export const LS_UPDATE_DISMISSED = "myPlugin.updateCheck.dismissed";
```

## `src/index.ts` — entry point

DWC runs this module once when the plugin loads/starts. Minimum viable version (standalone page only):

```ts
import { registerPluginMessages, registerRoute, unregisterRoute } from "@/plugins";
import Events from "@/utils/events";
import { clearAnnouncedUpdate, installErrorCapture } from "dwc-plugin-runtime";

import MyPluginPage from "./components/MyPluginPage.vue";
import { PLUGIN_ID, PLUGIN_MANIFEST_ID, ROUTE_PATH } from "./model/constants";
import { runUpdateCheck } from "./model/updateCheck";
import en from "./i18n/en.json";

registerPluginMessages(PLUGIN_ID, { en });

registerRoute(MyPluginPage, {
	Plugins: {                                     // menu category; DWC lower-cases it
		MyPlugin: {                                  // must be unique per plugin
			icon: "mdi-something",
			caption: "plugins.myPlugin.menuCaption",   // i18n key (or literal string + translated: true)
			path: ROUTE_PATH,
		},
	},
});

const uninstallErrorCapture = installErrorCapture();

setTimeout(() => { void runUpdateCheck({ notify: true }); }, 4000);

function onPluginUnloaded(id: string): void {
	if (id === PLUGIN_MANIFEST_ID) {
		unregisterRoute(ROUTE_PATH);
		clearAnnouncedUpdate(PLUGIN_MANIFEST_ID);
		uninstallErrorCapture();
		Events.off("dwcPluginUnloaded", onPluginUnloaded);
	}
}
Events.on("dwcPluginUnloaded", onPluginUnloaded);
```

Always tear down app-lifetime resources (routes, listeners, announced updates, error capture) in the
`dwcPluginUnloaded` handler — plugins can be stopped/reloaded without a full page refresh.

## Flexible Layouts integration — three ways in

DWC 3.7 has a "Flexible Layouts" companion plugin (custom dashboard grids). A plugin gets into its
widget palette one of three ways, from least to most effort:

1. **Automatic, for free.** Any route registered under the `Plugins` category (as above) is
   auto-discovered by Flexible Layouts and appears in its **Add widget → Plugins** palette as a generic
   "Plugin page" widget. You don't have to do anything extra for this.
2. **A dedicated compact route.** Register a second, smaller `.vue` component as its own route (e.g.
   `/Plugins/MyPlugin/Panel`) sized to sit in a grid cell. Still just `registerRoute` — same free
   discovery as #1, just a better-fitting component to drop in a cell.
3. **`registerEmbeddableComponent`** (DWC 3.7.0-alpha.7+, needs a pinned `dwcVersion`). Publishes a
   component straight into the palette as a first-class tile — no route or nav entry needed — with its
   own caption/icon/description/default size, and it must be explicitly unregistered on unload:

```ts
import { registerEmbeddableComponent, unregisterEmbeddableComponent } from "@/plugins";
import { EMBEDDABLE_ID, PLUGIN_MANIFEST_ID } from "./model/constants";
import MyPluginWidget from "./components/MyPluginWidget.vue";

registerEmbeddableComponent({
	id: EMBEDDABLE_ID,                    // stable, namespaced ("MyPlugin.Widget") — layouts persist it
	pluginId: PLUGIN_MANIFEST_ID,
	caption: "plugins.myPlugin.widget",   // i18n key, or a literal string + `translated: true`
	icon: "mdi-something",
	description: "plugins.myPlugin.widgetDesc",
	component: MyPluginWidget,
	defaultSize: { w: 4, h: 8 },          // grid units
	machineMode: "any",                   // "fdm" | "laser" | "cnc" | "any"
});

// in onPluginUnloaded:
unregisterEmbeddableComponent(EMBEDDABLE_ID);
```

The embedded component receives config via a small props contract — read `config`, call `setConfig(patch)`
to persist changes, check `host.isEditing` to show edit affordances:

```ts
const props = defineProps<{
	config: Record<string, unknown>;
	setConfig: (patch: Partial<Record<string, unknown>>) => void;
	host: { isEditing: boolean; instanceId?: string };
}>();
```

If the widget should be user-configurable (not just fixed props), declare a `WidgetConfigSchema` and call
`registerWidgetConfig()` from `dwc-plugin-runtime` — see `docs/rfc-widget-config.md` in that repo and
`src/widgetConfig.ts` for the full field-type/schema shape. This is a newer, optional layer; none of the
three reference plugins use it yet, so treat it as advanced/unverified-in-practice rather than a default.

Reference implementation: `flexible-layouts-example-plugin` (heavily commented, demonstrates all three).

`@/plugins` also exposes `registerLayout`/`unregisterLayout`, `registerRouteHook`, `registerSettingTab`,
`registerTheme`, and `injectComponent` — not covered here, check DWC's `src/plugins/` for current
signatures if a plugin needs one. Note `dwc-plugin-test-kit`'s `@/plugins` stub (as of this writing)
does **not** export `registerEmbeddableComponent`/`unregisterEmbeddableComponent` — not an issue for
normal component mount tests (they test the `.vue` file directly, not `index.ts`), but if you ever unit
test `index.ts` itself, that import will be `undefined` under the stub.

## `dwc-plugin-runtime` — what it gives you

Ships inside the bundle, store-agnostic (you pass in whatever state it needs — it never imports
`@/stores/*`), so it survives DWC version changes. Import from `"dwc-plugin-runtime"`:

**Diagnostics** — buffer uncaught errors, build a shareable, privacy-scrubbed bug report:
```ts
const stop = installErrorCapture();           // app-lifetime; call the returned fn on unload
recordError("widget", err);                   // manual, context-rich capture
const report = buildReport({ pluginId, model: machineStore.model, state: { widget } });
downloadReport(report);                        // → MyPlugin-diagnostics-….json
await copyReport(report);                       // → clipboard (execCommand-first, works on plain HTTP)
```
`buildReport`'s `sanitizeModel` redacts IP/SSID/MAC/hostname/board serial/filenames before sharing.
**The payoff:** a captured report's `model`/`state` replay directly into a `dwc-plugin-test-kit` mount
test (`setModel(loadObjectModel(report.model))`), turning a user bug report into a permanent regression
test.

**Self-update** — checks GitHub Releases, compares against the installed version, applies the update:
```ts
checkForUpdate({ owner, repo, currentVersion }): Promise<UpdateResult>
applyUpdate({ assetUrl, assetName, installPlugin }): Promise<void>
compareVersions(a, b) / isDwcCompatible(required, running) / runningDwcVersion()
```
Plus a **cross-plugin update hub** so multiple plugins' updates surface in one place if a host (e.g.
Flexible Layouts) claims it: `announceUpdate`, `clearAnnouncedUpdate`, `registerUpdateChecker`,
`claimUpdateHost`, `isUpdateHostActive`. Copy `updateCheck.ts` boilerplate below rather than
re-deriving it — every plugin implements the same pattern.

**Small utilities:**
```ts
copyText(text): Promise<boolean>                          // from "dwc-plugin-runtime/clipboard"
downloadBlob(filename, content, mimeType?)                 // from "dwc-plugin-runtime/download"
downloadJson(filename, value, replacer?)
```

**Components** (Vuetify-based, used directly in templates):
- `<HelpTip text="..." :href="optionalUrl" />` — small info icon + tooltip, click-through to docs.
- `<AboutDialog v-model="open" plugin-id="MyPlugin" title="..." :description="..." :model="machineStore.model" repo="https://github.com/..." :docs-url="..." docs-label="..." :update-available="..." :latest-version="..." :checking="..." :applying="..." :pending-reload="..." :auto-check="..." :extra-actions="[...]" @check-update="..." @apply-update="..." @toggle-auto-check="..." />`
  — the standardised "About" tab: version/repo/docs links, live update banner + one-click apply, and an
  extensible action list (`extra-actions`, e.g. "Download tuning report").

## Self-update boilerplate (`src/model/updateCheck.ts`)

Copy this pattern, swapping the constants and i18n prefix:

```ts
import { ref } from "vue";
import { announceUpdate, applyUpdate, checkForUpdate, clearAnnouncedUpdate, isUpdateHostActive, registerUpdateChecker, type UpdateResult } from "dwc-plugin-runtime";
import i18n from "@/i18n";
import { useMachineStore } from "@/stores/machine";
import { LogLevel, useUiStore } from "@/stores/ui";
import { PLUGIN_MANIFEST_ID } from "./constants";

const OWNER = "jaysuk";
const REPO = "my-plugin";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LS_ENABLED = "myPlugin.updateCheck.enabled";
const LS_LAST = "myPlugin.updateCheck.lastCheck";
const LS_DISMISSED = "myPlugin.updateCheck.dismissed";

export const updateState = ref<UpdateResult | null>(null);
export const checking = ref(false);
export const applying = ref(false);
export const pendingReload = ref(false);

function currentVersion(): string {
	const plugins = (useMachineStore().model as { plugins?: Map<string, { version?: string }> }).plugins;
	return plugins?.get(PLUGIN_MANIFEST_ID)?.version ?? "0.0.0";
}

// ... runUpdateCheck(), dismissCurrentUpdate(), applyUpdateNow() — see ClosedLoopTuningPlugin's
// src/model/updateCheck.ts for the full, working version (~90 lines, copy-paste-and-rename).

registerUpdateChecker(PLUGIN_MANIFEST_ID, async () => { await runUpdateCheck({ force: true }); });
```

## Talking to the machine

```ts
import { useMachineStore } from "@/stores/machine";
const machine = useMachineStore();

await machine.sendCode("G28", false, false);   // (code, fromInput?, logReply?) — check reply for "Error:" prefix
machine.model                                   // reactive object model (typed loosely; cast as needed)
await machine.getFileList("0:/sys");
await machine.installPlugin(filename, blob, start);

import { LogLevel, useUiStore } from "@/stores/ui";
useUiStore().makeNotification(LogLevel.error, "My Plugin", "Something went wrong.");

import i18n from "@/i18n";
i18n.global.t("plugins.myPlugin.someKey", { named: "args" });

import Events from "@/utils/events";
Events.on("dwcPluginUnloaded", handler);        // also: "dwcPluginLoaded"
```

`machine.model` fields are effectively `any` from a plugin's perspective — narrow/cast what you need
(e.g. `(model as any).move?.axes ?? []`). Reads are reactive; watch them directly rather than polling.

## Testing — `dwc-plugin-test-kit`

`vitest.config.ts` (entire file):
```ts
import vue from "@vitejs/plugin-vue";
import { dwcVitestConfig } from "dwc-plugin-test-kit/vitest";
export default dwcVitestConfig({ plugins: [vue()] });
```
This wires up `@/...` → stub aliases, happy-dom, Vue/Vuetify dedupe, and setup polyfills
(ResizeObserver, matchMedia, execCommand, ...). State (`sendCode` calls, notifications, the object
model) auto-resets before every test.

**Pure-logic tests** (`src/__tests__/*.test.ts`) — plain vitest, no mocking needed:
```ts
import { describe, expect, it } from "vitest";
import { myPureFunction } from "../model/myModule";
it("does the thing", () => { expect(myPureFunction(x)).toBe(y); });
```

**Component mount tests** (`test/*.test.ts`) — catches the bugs pure-logic tests miss (TDZ errors,
components that throw on render):
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { mountInDwc, resetDwc, setModel, sentCodes } from "dwc-plugin-test-kit";
import MyPluginPage from "../src/components/MyPluginPage.vue";

describe("MyPluginPage", () => {
	beforeEach(() => resetDwc());
	it("mounts without throwing", () => {
		expect(mountInDwc(MyPluginPage).exists()).toBe(true);
	});
	it("sends G28 when the button is clicked", async () => {
		const w = mountInDwc(MyPluginPage);
		await w.find("button").trigger("click");
		expect(sentCodes()).toContain("G28");
	});
});
```
Other harness helpers: `patchModel`, `setConnected`, `setUiFrozen`, `setFiles`, `setGlobals`,
`setMessageBox`, `lastCode`, `notifications`, `makeObjectModel` (realistic fixture — axes, heaters,
fans, spindles, tools, `global` Map, `ledStrips`, ...), `loadObjectModel` (load a real M409 dump).

If a plugin has multiple widgets driven by a registry/type union, add one **self-maintaining smoke
test** that loops the registry and mounts every entry — it automatically covers widgets added later.

## Build gates (need a DWC checkout)

```bash
DWC_DIR=/path/to/DuetWebControl npm run typecheck      # vue-tsc against DWC's real @/ types
DWC_DIR=/path/to/DuetWebControl npm run verify-build    # builds the ZIP, asserts correct externalisation
```
`verify-build` fails if the JS bundle doesn't reference `window.DWC.*`, bundles a second copy of
Vuetify, or the manifest's `dwcFiles` ends up empty — i.e. it catches "works in dev, breaks once
installed" before a release. `npm test` does **not** need `DWC_DIR`.

## CI

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    uses: jaysuk/dwc-plugin-test-kit/.github/workflows/dwc-plugin-ci.yml@v0.2.6
    with:
      dwc-ref: v3.7-dev
      kit-ref: v0.2.6
```
Pin both `@v0.2.6` (the workflow ref) and `kit-ref: v0.2.6` (what it installs) to a real tag, matching
the `dwc-plugin-test-kit` version in `package.json` — every plugin in this family does this, not
`@main`, so a test-kit change can't silently break CI on an unrelated plugin the day it merges. Bump
both together when you deliberately upgrade the kit. Runs unit + mount tests, then in a second job
checks out DWC and runs `verify-build` + `typecheck`.

## Known gotchas

- **`v-model.number` is silently inert on Vuetify components.** Vue's `.number` modifier only works
  because the *component* reads `modelModifiers`; Vuetify's form components never do. Typing into a
  `v-model.number="foo"` field does coerce (the underlying native `<input>`'s own `v-model` numbers
  it), but **clearing the field leaves `foo` as the empty string `""`, not `0` or `NaN`.** The global
  `isFinite("")` is `true` — it coerces — so a guard written as `if (!isFinite(v)) return` lets an
  empty field straight through, and `Math.round("")` is a silent `0`. Verified by mounting a
  `v-text-field` with `v-model.number` and clearing it. Any numeric field feeding a computation with
  real consequences (a G-code coordinate, an RPM, a tool number) needs an explicit
  `typeof v === "number" && Number.isFinite(v)` check at the boundary, not a bare `isFinite()`.

- **An element sitting between a `v-if` and its `v-else`/`v-else-if` crashes the Vue compiler
  outright**, not just a lint warning — the directives must be *immediately* adjacent siblings
  (whitespace/comments are fine, another element is not). Breaking that produces "Codegen node is
  missing for element/if/for node. Apply appropriate transforms first." at build time, with no source
  location and no hint that adjacency is the cause. If a build throws that, look for a stray element
  (a hidden `<input type="file">`, a helper span) sitting between the two branches.

- **No dynamic `import()`.** The plugin builds as a single IIFE (`formats: ["iife"]` in
  `build-plugin.js`) — there is no code-splitting and no lazy-loading escape hatch. A dynamic
  `import()` (even of a path that resolves fine in dev) ships an unresolvable literal specifier in the
  built bundle and throws only once installed, not in dev. If something needs to be optional or
  deferred, gate it behind a flag inside a normally-imported module — don't try to defer the import.

- **A third-party npm package needed only for its TYPES should get an ambient `.d.ts`, not
  `@types/<pkg>`.** `dwc-plugin-typecheck` copies the plugin's `src/` into the target DWC checkout and
  runs `vue-tsc` there, resolving `node_modules` from *that checkout*, not the plugin's own — so a
  real npm type-only dependency the checkout doesn't have installed fails typecheck for a reason that
  has nothing to do with the plugin's own code. A hand-written `declare module "pkg-name" { ... }`
  file needs no package on disk anywhere, so it resolves identically under `npm test`, `verify-build`,
  and the copied-checkout `typecheck`.

## Conventions worth keeping

- Persist lightweight UI state (selections, not captured data) to `localStorage` behind a debounced
  `watch`, namespaced under the plugin's camelCase ID (e.g. `myPlugin.someSetting`), wrapped in
  try/catch (storage can be disabled).
- Keep a confirm-dialog pattern for any G-code the plugin sends that moves the machine or changes
  physical state — show the actual command, not just a description.
- If the plugin drives motion, remember RepRapFirmware's `G1`/`G0` `H2` (individual motor mode) bypasses
  kinematics **and M208 soft limits entirely** — no firmware-side protection. Any plugin sending H2 moves
  must implement its own position/limit safety layer (read `move.axes[].min/max/machinePosition/homed`
  from the object model) rather than assuming RRF will stop it.
- Before relying on a G/M-code's behaviour, check `Duet3D/wiki-content`
  (https://github.com/Duet3D/wiki-content — `User_manual/Reference/Gcodes.md` has the full dictionary,
  one page with `## Mxxx`/`## Gxxx` sections) in addition to reading RRF source. Source shows what a
  command *does*; the wiki states what it's *for*, which source alone doesn't always make obvious —
  `M585` ("Probe Tool") reads like a generic "move until triggered" primitive from its firmware
  implementation, but it unconditionally overwrites the current tool's offset as a side effect,
  because its real documented purpose is tool-offset calibration. A reference plugin already using a
  command isn't proof it's the right command for a new job — `G38.2` ("Straight Probe") is the actual
  side-effect-free primitive for a plain probe-until-triggered move.
- One page = one focused capability. Prefer a wizard/stepper UI (`v-stepper`) for multi-stage flows over
  a single dense form.
