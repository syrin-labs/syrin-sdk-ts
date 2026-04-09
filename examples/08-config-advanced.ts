/**
 * Example 8: Advanced Config — @tunable, tune(), ConfigGuard, ConfigFuse
 *
 * Demonstrates:
 *   - @tunable class decorator + TunableField property markers
 *   - tune() on a plain class instance (programmatic registration)
 *   - Nested dotted-path in tune() fields
 *   - getTune() to read current values
 *   - ConfigGuard.safeApply() with valid and invalid updates
 *   - Anchor: takeAnchor() → risky apply → restoreAnchor()
 *   - ConfigFuse: 3 failures → OPEN → manualReset() → CLOSED
 *
 * Note: @tunable uses TypeScript decorators. Ensure your tsconfig has
 *   "experimentalDecorators": true  (TS < 5)
 *   or use TS 5 native decorators with "target": "ES2022".
 *
 * Run:
 *   SYRIN_API_KEY=syrin_test SYRIN_BACKEND_URL=http://localhost:4318 \
 *   npx tsx examples/08-config-advanced.ts
 */

import {
  init,
  shutdown,
  tunable,
  TunableField,
  tune,
  getTune,
  globalRegistry,
  ConfigStore,
} from '../src/index.js';

import { ConfigGuard, ConfigFuse, DEFAULT_RECOVERY_POLICY } from '../src/config-guard.js';

const BACKEND_URL = process.env['SYRIN_BACKEND_URL'] ?? 'http://localhost:4000';

// ---------------------------------------------------------------------------
// Initialize SDK
// ---------------------------------------------------------------------------

const sdk = await init({
  apiKey: process.env['SYRIN_API_KEY'] ?? 'syrin_demo',
  backendUrl: BACKEND_URL,
  agentId: 'config-advanced-demo',
  debug: false,
  offline: true, // no network calls needed for this demo
  captureContent: true,
});

console.log('='.repeat(60));
console.log('  SYRIN ADVANCED CONFIG DEMO (TypeScript)');
console.log('='.repeat(60));
console.log(`  session_id : ${sdk.sessionId}`);
console.log();

// ---------------------------------------------------------------------------
// Demo 1: @tunable class decorator + TunableField
// ---------------------------------------------------------------------------

console.log('--- Demo 1: @tunable decorator + TunableField ---');

@tunable({ namespace: 'processor', applyTiming: 'immediate' })
class DocumentProcessor {
  batchSize = TunableField({ default: 10, ge: 1, le: 100, description: 'Documents per batch' });
  temperature = TunableField({ default: 0.7, ge: 0.0, le: 2.0, description: 'LLM temperature' });
  provider = TunableField({
    default: 'openai',
    enum: ['openai', 'anthropic', 'google'],
    description: 'LLM provider',
  });
}

const processor = new DocumentProcessor();

// After construction, markers are replaced with their default values
console.log(`  processor.batchSize   : ${String(processor.batchSize)}   (expected: 10)`);
console.log(`  processor.temperature : ${String(processor.temperature)} (expected: 0.7)`);
console.log(`  processor.provider    : ${String(processor.provider)}  (expected: openai)`);

// Read back from the registry
let cfg = getTune('processor');
console.log(`  getTune('processor')  : ${JSON.stringify(cfg)}`);

// Update via registry — immediate apply writes through to the instance
globalRegistry.applyUpdate('processor', 'temperature', 0.3);
console.log(`  after applyUpdate(temperature=0.3): processor.temperature = ${String(processor.temperature)}`);
console.log();

// ---------------------------------------------------------------------------
// Demo 2: tune() on a plain class instance
// ---------------------------------------------------------------------------

console.log('--- Demo 2: tune() on a plain class instance ---');

class VectorSearch {
  topK = 5;
  similarityThreshold = 0.8;
  indexName = 'default';
  settings = {
    reranker: {
      enabled: false,
    },
  };
}

const vectorSearch = new VectorSearch();

// Register plain fields
tune({
  target: vectorSearch,
  namespace: 'vector_search',
  fields: {
    topK: 'number',
    similarityThreshold: 'number',
    indexName: 'string',
  },
  applyTiming: 'immediate',
});

console.log(`  vectorSearch.topK                : ${vectorSearch.topK}`);
console.log(`  getTune('vector_search')         : ${JSON.stringify(getTune('vector_search'))}`);

globalRegistry.applyUpdate('vector_search', 'topK', 20);
console.log(`  after applyUpdate(topK=20)       : vectorSearch.topK = ${vectorSearch.topK}`);
console.log();

// ---------------------------------------------------------------------------
// Demo 3: Nested dotted-path in tune() fields
// ---------------------------------------------------------------------------

console.log('--- Demo 3: Nested dotted-path fields ---');

class PipelineConfig {
  retries = 3;
  timeout = 30;
}

const pipelineCfg = new PipelineConfig();

// Register with a custom apply function that handles dotted paths
tune({
  target: pipelineCfg,
  namespace: 'pipeline',
  fields: {
    retries: 'number',
    timeout: 'number',
  },
  apply: (target, key, value) => {
    const parts = key.split('.');
    let obj = target as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = value;
  },
  applyTiming: 'immediate',
});

globalRegistry.applyUpdate('pipeline', 'retries', 5);
globalRegistry.applyUpdate('pipeline', 'timeout', 60);

console.log(`  pipelineCfg.retries : ${pipelineCfg.retries}  (expected: 5)`);
console.log(`  pipelineCfg.timeout : ${pipelineCfg.timeout} (expected: 60)`);
console.log(`  getTune('pipeline') : ${JSON.stringify(getTune('pipeline'))}`);
console.log();

// ---------------------------------------------------------------------------
// Demo 4: ConfigGuard.safeApply() with valid and invalid updates
// ---------------------------------------------------------------------------

console.log('--- Demo 4: ConfigGuard.safeApply() ---');

// Build a ConfigStore and ConfigGuard for the 'llm' namespace
const store = new ConfigStore();

const guard = new ConfigGuard(store, globalRegistry, {
  onValidationFail: 'rejectField',   // reject only the offending field
  fuseThreshold: 3,
  fuseResetSeconds: 300,
});

// Valid apply
const validResult = guard.safeApply('llm', {
  temperature: 0.3,
  max_tokens: 2048,
});
console.log('  safeApply (all valid):');
console.log(`    success  : ${validResult.success}`);
console.log(`    applied  : ${JSON.stringify(validResult.applied)}`);
console.log(`    rejected : ${JSON.stringify(validResult.rejected)}`);
console.log(`    anchorId : ${validResult.anchorId ?? 'none'}`);

// Mixed apply — temperature out of range, max_tokens valid
const mixedResult = guard.safeApply('llm', {
  temperature: 9.9,   // invalid: > 2.0
  max_tokens: 1024,   // valid
});
console.log('  safeApply (mixed — one invalid):');
console.log(`    success  : ${mixedResult.success}`);
console.log(`    applied  : ${JSON.stringify(mixedResult.applied)}`);
console.log(`    rejected : ${JSON.stringify(mixedResult.rejected)}`);
console.log();

// ---------------------------------------------------------------------------
// Demo 5: Anchor — take → apply risky change → restore
// ---------------------------------------------------------------------------

console.log('--- Demo 5: Anchor (take → risky apply → restore) ---');

// Apply a known-good state first
guard.safeApply('llm', { temperature: 0.5, max_tokens: 512 });
console.log(`  llm.temperature (before anchor): ${store.get('llm', 'temperature')}`);

// Take a manual anchor before the risky change
const anchor = guard.takeAnchor('before risky change');
console.log(`  anchor taken: ${anchor.anchorId} (reason="${anchor.reason}")`);

// Apply a "risky" change
guard.safeApply('llm', { temperature: 1.8, max_tokens: 100 });
console.log(`  llm.temperature (after risky apply): ${store.get('llm', 'temperature')}`);

// Restore to the anchor
guard.restoreAnchor(anchor.anchorId);
console.log(`  llm.temperature (after restore): ${store.get('llm', 'temperature')}  (should be 0.5)`);
console.log(`  llm.max_tokens  (after restore): ${store.get('llm', 'max_tokens')}  (should be 512)`);
console.log();

// ---------------------------------------------------------------------------
// Demo 6: ConfigFuse — 3 failures → OPEN → manualReset → CLOSED
// ---------------------------------------------------------------------------

console.log('--- Demo 6: ConfigFuse circuit breaker ---');

const fuse = new ConfigFuse({ ...DEFAULT_RECOVERY_POLICY, fuseThreshold: 3 });

console.log(`  initial state: ${fuse.state}  (expected: CLOSED)`);

fuse.recordFailure();
console.log(`  after failure 1: ${fuse.state}  failures=${fuse.consecutiveFailures}`);

fuse.recordFailure();
console.log(`  after failure 2: ${fuse.state}  failures=${fuse.consecutiveFailures}`);

fuse.recordFailure();
console.log(`  after failure 3: ${fuse.state}  (expected: OPEN)`);
console.log(`  isAccepting(): ${fuse.isAccepting()}  (expected: false)`);

// Verify apply is rejected when fuse is OPEN
const newStore2 = new ConfigStore();
const guardWithBrokenFuse = new ConfigGuard(newStore2, globalRegistry, { fuseThreshold: 1 });
guardWithBrokenFuse.fuse.recordFailure(); // trip immediately
const blockedResult = guardWithBrokenFuse.safeApply('llm', { temperature: 0.5 });
console.log(`  apply while OPEN: success=${blockedResult.success}  error="${blockedResult.error?.message ?? 'none'}"`);

// Manual reset
fuse.manualReset();
console.log(`  after manualReset: ${fuse.state}  (expected: CLOSED)`);
console.log(`  isAccepting(): ${fuse.isAccepting()}  (expected: true)`);
console.log();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('='.repeat(60));
console.log('  Demo complete. Key concepts demonstrated:');
console.log('    @tunable    — class decorator, replaces TunableField markers with defaults');
console.log('    tune()      — register plain instances programmatically');
console.log('    getTune()   — read current logical values from the registry');
console.log('    ConfigGuard — safeApply with per-field validation + policy');
console.log('    Anchors     — snapshot before risky changes, restore on failure');
console.log('    ConfigFuse  — circuit breaker: CLOSED → OPEN → CLOSED');
console.log('='.repeat(60));

await shutdown();
