// Runs a TypeScript script against the app's modules outside Next: resolves the `@/` alias and
// stubs `server-only`, which otherwise throws when imported outside a server component.
//
//   node scripts/run.mjs scripts/test-store.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const dashboard = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: { "@": dashboard, "server-only": path.join(dashboard, "scripts/server-only-stub.mjs") },
});
await jiti.import(path.resolve(process.argv[2]));
