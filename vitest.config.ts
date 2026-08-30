import vue from "@vitejs/plugin-vue";
import { dwcVitestConfig } from "dwc-plugin-test-kit/vitest";

// Pure-logic tests (src/__tests__) plus component mount tests (test/). All the Vitest + Vuetify +
// DWC-mock wiring lives in the shared kit; the consumer only supplies the Vue SFC plugin so it
// resolves from this repo's node_modules at config-load time.
export default dwcVitestConfig({
	plugins: [vue()],
});
