/**
 * Auto-detection of AI framework libraries via Node.js module cache inspection
 * and Module._load hooks.
 *
 * Strategy:
 *  1. At init() time: inspect require.cache to find CJS modules already loaded.
 *  2. After init(): hook Module._load to catch modules loaded afterward.
 *
 * Note: Pure ESM-only packages (no CJS entry point) won't appear in require.cache.
 * This covers the vast majority of real-world usage since LangChain, LangGraph,
 * Mastra, and most AI frameworks still ship CJS compatibility entry points.
 *
 * A library being present in node_modules does NOT trigger instrumentation —
 * only libraries that are actually loaded/required in the current process.
 */

import { createRequire } from 'module';
import type { ISyrinCore } from '../adapters/types.js';
import type { SyrinSDKConfig } from '../types.js';

// Top-level package name → adapter module path (relative to this file) + export name
const WATCHED_LIBRARIES: ReadonlyMap<string, { path: string; exportName: string }> = new Map([
  ['openai', { path: '../adapters/openai/index.js', exportName: 'OpenAIAdapter' }],
  ['@anthropic-ai/sdk', { path: '../adapters/anthropic/index.js', exportName: 'AnthropicAdapter' }],
  ['langchain', { path: '../adapters/langchain/index.js', exportName: 'LangChainAdapter' }],
  ['@langchain/langgraph', { path: '../adapters/langgraph/index.js', exportName: 'LangGraphAdapter' }],
  ['mastra', { path: '../adapters/mastra/index.js', exportName: 'MastraAdapter' }],
  ['ai', { path: '../adapters/vercel-ai/index.js', exportName: 'VercelAIAdapter' }],
]);

// Tracks which adapter export names we have already auto-installed in this process.
// Module-level so it persists across multiple tryInstall calls.
// Cleared in uninstallModuleHook().
const _installed = new Set<string>();

/**
 * Check whether an adapter with the given name is already registered in core.
 * Looks at both adapter.name and the constructor name to be resilient.
 */
function isAlreadyRegistered(core: ISyrinCore, adapterName: string): boolean {
  // SyrinSDKCore keeps a private _adapters Map — access via casting
  const coreInternal = core as ISyrinCore & {
    _adapters?: Map<string, { name?: string; constructor?: { name?: string } }>;
    isAdapterInstalled?(name: string): boolean;
  };

  // Prefer the public isAdapterInstalled() method if available (avoids private access)
  if (typeof coreInternal.isAdapterInstalled === 'function') {
    // Map adapter export name → adapter.name (the stable identifier)
    const exportToAdapterName: Record<string, string> = {
      OpenAIAdapter: 'openai',
      AnthropicAdapter: 'anthropic',
      LangChainAdapter: 'langchain',
      LangGraphAdapter: 'langgraph',
      MastraAdapter: 'mastra',
      VercelAIAdapter: 'vercel-ai',
    };
    const stableName = exportToAdapterName[adapterName];
    if (stableName && coreInternal.isAdapterInstalled(stableName)) return true;
  }

  // Fallback: inspect _adapters directly
  if (!coreInternal._adapters) return false;
  for (const adapter of coreInternal._adapters.values()) {
    if (adapter.name === adapterName || adapter.constructor?.name === adapterName) return true;
  }
  return false;
}

/**
 * Dynamically import the Syrin adapter for a watched library and register it.
 *
 * @param libraryKey - The npm package name (e.g. 'langchain', '@anthropic-ai/sdk')
 * @param core - The SyrinSDKCore instance to register the adapter into
 * @param config - The SDK config (used for debug logging)
 */
async function tryInstall(
  libraryKey: string,
  core: ISyrinCore,
  config: SyrinSDKConfig,
): Promise<void> {
  const entry = WATCHED_LIBRARIES.get(libraryKey);
  if (!entry) return;

  const { path, exportName } = entry;

  // Guard: already auto-installed in this process
  if (_installed.has(exportName)) return;

  // Guard: already registered (e.g. user passed it explicitly via options.adapters)
  if (isAlreadyRegistered(core, exportName)) {
    _installed.add(exportName);
    return;
  }

  try {
    // Dynamic import of the Syrin adapter module (NOT the framework library itself)
    const mod = await import(path) as Record<string, new () => InstanceType<new () => unknown>>;
    const AdapterClass = mod[exportName];
    if (typeof AdapterClass !== 'function') {
      console.warn(`[Syrin] auto-detect: ${exportName} is not a constructor in ${path}`);
      return;
    }

    const coreWithRegister = core as ISyrinCore & {
      registerAdapter(adapter: InstanceType<new () => unknown>): Promise<void>;
    };

    if (typeof coreWithRegister.registerAdapter !== 'function') {
      console.warn(`[Syrin] auto-detect: core.registerAdapter() not available`);
      return;
    }

    await coreWithRegister.registerAdapter(new AdapterClass());
    _installed.add(exportName);

    if (config.debug) {
      console.debug(
        `[Syrin] Auto-installed ${exportName} (detected active use of '${libraryKey}')`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Syrin] Failed to auto-install adapter for '${libraryKey}': ${message}`);
  }
}

/**
 * Check require.cache to find which CJS libraries are already loaded, and install
 * adapters for them. This covers libraries imported BEFORE syrin init() was called.
 *
 * ESM-only packages without a CJS compatibility layer won't appear in require.cache —
 * those are handled by the Module._load hook (installModuleHook) for post-init imports,
 * but pre-init pure-ESM imports cannot be detected by this approach.
 */
export async function installForActiveLibraries(
  core: ISyrinCore,
  config: SyrinSDKConfig,
): Promise<void> {
  let cachedPaths: string[];
  try {
    const _require = createRequire(import.meta.url);
    cachedPaths = Object.keys(_require.cache);
  } catch {
    // createRequire may fail in certain ESM environments — skip gracefully
    return;
  }

  for (const [libraryKey] of WATCHED_LIBRARIES) {
    const segment = `/node_modules/${libraryKey}/`;
    const isLoaded = cachedPaths.some((p) => {
      const normalized = p.replace(/\\/g, '/');
      return normalized.includes(segment);
    });

    if (isLoaded) {
      await tryInstall(libraryKey, core, config);
    }
  }
}

// ---------------------------------------------------------------------------
// Module._load hook
// ---------------------------------------------------------------------------

type NodeModuleInternal = {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

type ModuleLoadHook = {
  uninstall: () => void;
};

let _activeHook: ModuleLoadHook | null = null;

/**
 * Hook Node.js's module loading system to detect framework libraries loaded
 * AFTER init(). Uses the Module._load intercept pattern.
 *
 * Works for CJS modules and ESM packages with CJS compatibility entry points.
 * Pure ESM packages loaded via dynamic import() are NOT intercepted here.
 *
 * The hook is idempotent — calling it multiple times installs it only once.
 */
export function installModuleHook(core: ISyrinCore, config: SyrinSDKConfig): void {
  if (_activeHook !== null) return; // Already installed

  let NodeModule: NodeModuleInternal;
  try {
    // Access the Node.js module system internals via the CJS require shim
    const _require = createRequire(import.meta.url);
    NodeModule = _require('module') as NodeModuleInternal;
  } catch {
    // Not in a Node.js environment or createRequire unavailable — skip
    return;
  }

  if (typeof NodeModule._load !== 'function') return;

  // Save without .bind() so we can restore the exact same function reference.
  const originalLoad = NodeModule._load;

  NodeModule._load = function hookedLoad(
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    // Always call original first so require() completes normally.
    // Use call(NodeModule, ...) to preserve the original `this` context.
    const result = originalLoad.call(NodeModule, request, parent, isMain);

    // Extract the top-level package name from the request string.
    // Handles scoped packages like @anthropic-ai/sdk and sub-paths like langchain/openai.
    let pkgName: string;
    if (request.startsWith('@')) {
      pkgName = request.split('/').slice(0, 2).join('/');
    } else {
      pkgName = request.split('/')[0] ?? request;
    }

    if (WATCHED_LIBRARIES.has(pkgName) && !_installed.has(pkgName)) {
      // Use setImmediate to run async install after the current require() call completes,
      // avoiding re-entrant require() issues inside the hook.
      setImmediate(() => {
        void tryInstall(pkgName, core, config);
      });
    }

    return result;
  };

  _activeHook = {
    uninstall(): void {
      NodeModule._load = originalLoad;
    },
  };
}

/**
 * Remove the Module._load hook and reset tracking state.
 * Called on SDK shutdown to restore the original module loading behavior.
 * Always clears the _installed set, regardless of whether the hook was active.
 */
export function uninstallModuleHook(): void {
  if (_activeHook !== null) {
    _activeHook.uninstall();
    _activeHook = null;
  }
  _installed.clear();
}
