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
const WATCHED_LIBRARIES = new Map([
  // OpenAI
  ['openai', { path: '../adapters/openai/index.js', exportName: 'OpenAIAdapter' }],
  // Anthropic
  ['@anthropic-ai/sdk', { path: '../adapters/anthropic/index.js', exportName: 'AnthropicAdapter' }],
  // LangChain — modern split-package installs
  ['langchain', { path: '../adapters/langchain/index.js', exportName: 'LangChainAdapter' }],
  ['@langchain/core', { path: '../adapters/langchain/index.js', exportName: 'LangChainAdapter' }],
  ['@langchain/openai', { path: '../adapters/langchain/index.js', exportName: 'LangChainAdapter' }],
  ['@langchain/anthropic', { path: '../adapters/langchain/index.js', exportName: 'LangChainAdapter' }],
  ['@langchain/community', { path: '../adapters/langchain/index.js', exportName: 'LangChainAdapter' }],
  // LangGraph
  ['@langchain/langgraph', { path: '../adapters/langgraph/index.js', exportName: 'LangGraphAdapter' }],
  // Mastra
  ['@mastra/core', { path: '../adapters/mastra/index.js', exportName: 'MastraAdapter' }],
  // Vercel AI SDK
  ['ai', { path: '../adapters/vercel-ai/index.js', exportName: 'VercelAIAdapter' }],
  ['@ai-sdk/openai', { path: '../adapters/vercel-ai/index.js', exportName: 'VercelAIAdapter' }],
  ['@ai-sdk/anthropic', { path: '../adapters/vercel-ai/index.js', exportName: 'VercelAIAdapter' }],
]);

// Tracks which adapter export names we have already auto-installed in this process.
const _installed = new Set<string>();

function isAlreadyRegistered(core: ISyrinCore, adapterName: string): boolean {
  const coreInternal = core as unknown as Record<string, unknown>;
  if (typeof (coreInternal['isAdapterInstalled'] as unknown) === 'function') {
    const exportToAdapterName: Record<string, string> = {
      OpenAIAdapter: 'openai',
      AnthropicAdapter: 'anthropic',
      LangChainAdapter: 'langchain',
      LangGraphAdapter: 'langgraph',
      MastraAdapter: 'mastra',
      VercelAIAdapter: 'vercel-ai',
    };
    const stableName = exportToAdapterName[adapterName];
    if (stableName && (coreInternal['isAdapterInstalled'] as (n: string) => boolean)(stableName)) return true;
  }
  if (!coreInternal['_adapters']) return false;
  for (const adapter of (coreInternal['_adapters'] as Map<string, { name: string; constructor?: { name: string } }>).values()) {
    if (adapter.name === adapterName || adapter.constructor?.name === adapterName) return true;
  }
  return false;
}

async function tryInstall(libraryKey: string, core: ISyrinCore, config: SyrinSDKConfig): Promise<void> {
  const entry = WATCHED_LIBRARIES.get(libraryKey);
  if (!entry) return;
  const { path, exportName } = entry;
  if (_installed.has(exportName)) return;
  if (isAlreadyRegistered(core, exportName)) {
    _installed.add(exportName);
    return;
  }
  try {
    const mod = await import(path);
    const AdapterClass = mod[exportName] as new () => unknown;
    if (typeof AdapterClass !== 'function') {
      console.warn(`[Syrin] auto-detect: ${exportName} is not a constructor in ${path}`);
      return;
    }
    const coreWithRegister = core as unknown as { registerAdapter(a: unknown): Promise<void> };
    if (typeof coreWithRegister.registerAdapter !== 'function') {
      console.warn(`[Syrin] auto-detect: core.registerAdapter() not available`);
      return;
    }
    await coreWithRegister.registerAdapter(new AdapterClass());
    _installed.add(exportName);
    if (config.debug) {
      console.debug(`[Syrin] Auto-installed ${exportName} (detected active use of '${libraryKey}')`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Syrin] Failed to auto-install adapter for '${libraryKey}': ${message}`);
  }
}

/**
 * Check require.cache to find which CJS libraries are already loaded, and install
 * adapters for them. This covers libraries imported BEFORE syrin init() was called.
 */
export async function installForActiveLibraries(core: ISyrinCore, config: SyrinSDKConfig): Promise<void> {
  let cachedPaths: string[];
  try {
    const _require = createRequire(import.meta.url);
    cachedPaths = Object.keys(_require.cache);
  } catch {
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

let _activeHook: { uninstall(): void } | null = null;

/**
 * Hook Node.js's module loading system to detect framework libraries loaded
 * AFTER init(). Uses the Module._load intercept pattern.
 */
export function installModuleHook(core: ISyrinCore, config: SyrinSDKConfig): void {
  if (_activeHook !== null) return;
  let NodeModule: Record<string, unknown>;
  try {
    const _require = createRequire(import.meta.url);
    NodeModule = _require('module') as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof NodeModule['_load'] !== 'function') return;
  const originalLoad = NodeModule['_load'] as (...args: unknown[]) => unknown;
  NodeModule['_load'] = function hookedLoad(request: string, parent: unknown, isMain: boolean) {
    const result = originalLoad.call(NodeModule, request, parent, isMain);
    let pkgName: string;
    if (request.startsWith('@')) {
      pkgName = request.split('/').slice(0, 2).join('/');
    } else {
      pkgName = request.split('/')[0] ?? request;
    }
    if (WATCHED_LIBRARIES.has(pkgName) && !_installed.has(pkgName)) {
      setImmediate(() => {
        void tryInstall(pkgName, core, config);
      });
    }
    return result;
  };
  _activeHook = {
    uninstall() {
      NodeModule['_load'] = originalLoad;
    },
  };
}

/**
 * Remove the Module._load hook and reset tracking state.
 */
export function uninstallModuleHook(): void {
  if (_activeHook !== null) {
    _activeHook.uninstall();
    _activeHook = null;
  }
  _installed.clear();
}
