#!/usr/bin/env node
// Codex forwarder — shim that wires the shared core to the Codex provider.
//
// All event normalization, connection handling, permission flow and auto-start
// logic lives in `apps/hook-forwarder-core/`. This shim resolves the
// compiled core (dist/hook-forwarder-core/index.js) at runtime and dispatches
// every event through it.
//
// We deliberately type the core's surface with a local ambient declaration
// (see ./core-types.d.ts) instead of importing from the core's source. This
// keeps the shim's rootDir tight to ./src while still giving us full type
// safety on the imported module's shape.

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

interface CoreProvider {
  id: "claude-code" | "codex";
}

interface CoreExports {
  runForwarder: (options: { provider: CoreProvider }) => Promise<void>;
  claudeCodeProvider: CoreProvider;
  codexProvider: CoreProvider;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveCoreEntry(): string {
  // Dev layout: <project>/dist/hook-forwarder-codex/index.js → sibling ../../hook-forwarder-core/index.js
  // Prod layout: <install>/resources/hook-forwarder-codex/index.js → sibling
  return join(__dirname, "../../hook-forwarder-core/index.js");
}

let corePromise: Promise<CoreExports> | null = null;
function loadCore(): Promise<CoreExports> {
  if (!corePromise) {
    const coreEntry = resolveCoreEntry();
    if (!existsSync(coreEntry)) {
      throw new Error(`[clawd][codex] core not found at ${coreEntry}. Run \`npm run build:forwarder\` first.`);
    }
    corePromise = import(pathToFileURL(coreEntry).href) as Promise<CoreExports>;
  }
  return corePromise;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  loadCore()
    .then(core => core.runForwarder({ provider: core.codexProvider }))
    .catch((error) => {
      process.stderr.write(`[clawd][codex] forward error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(0);
    });
}
