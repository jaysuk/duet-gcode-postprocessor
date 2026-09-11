/**
 * The one place this plugin decides "is this a small screen?" — for the 4.3"/7" Duet panel case
 * (FEATURES.md F6).
 *
 * Wraps Vuetify's own `useDisplay` (a root export, externalised to `DWC.Vuetify` by DWC's
 * build-plugin.js, so it resolves in the shipped bundle — DWC's own `FileList.vue`/`MacroList.vue`
 * import it the same way). Deliberately **not** `@/composables/useLargeButtons`: that is externalised
 * at build time but has no stub in `dwc-plugin-test-kit`, so importing it breaks every mount test.
 * The `largeButtons` setting is read straight off the settings store instead, defensively — the real
 * store has it (default `true`), the test kit's untyped settings bag will not.
 *
 * Stop point (docs/tasks/16-automation-and-reporting.md §G), resolved: `useDisplay`'s breakpoint
 * **can** be driven under the test harness. Setting `window.innerWidth` and dispatching a `resize`
 * event, then `await nextTick()`, updates `mobile` / `name` / `width` reactively — both at mount
 * time and after mount. So the responsive behaviour is tested directly against this composable
 * rather than being pushed entirely into CSS.
 */

import { computed, type ComputedRef } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { useDisplay } from "vuetify";

export interface Breakpoint {
	/** Vuetify's `mobile` flag — true at/below the `sm` breakpoint (roughly a phone or a small panel). */
	mobile: ComputedRef<boolean>;
	/** True only at the `xs` breakpoint — the 4.3" panel and narrow phones. */
	xs: ComputedRef<boolean>;
	/** True when a small screen coincides with DWC's own "large buttons" setting being on: relax
	 *  `density="compact"` controls to finger size, the same rule DWC's `useLargeButtons` applies. */
	fingerSize: ComputedRef<boolean>;
	/** `"default"` when `fingerSize`, else `"compact"` — drop straight into a `:density` binding. */
	controlDensity: ComputedRef<"default" | "compact">;
}

export function useBreakpoint(): Breakpoint {
	const display = useDisplay();
	const settings = useSettingsStore() as { largeButtons?: boolean };

	const mobile = computed(() => display.mobile.value);
	const xs = computed(() => display.name.value === "xs");
	const fingerSize = computed(() => mobile.value && settings.largeButtons === true);
	const controlDensity = computed<"default" | "compact">(() => (fingerSize.value ? "default" : "compact"));

	return { mobile, xs, fingerSize, controlDensity };
}
