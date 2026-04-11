/**
 * Example 06 — Config Safety: Guardrails for Remote Config in Production
 * =======================================================================
 *
 * THE PROBLEM
 * -----------
 * Remote config is powerful. Someone in your backend pushes an update:
 *
 *   temperature: 2.0  ← the maximum, output becomes incoherent garbage
 *   model: "gpt-4-turbo"  ← $10/M tokens instead of $0.15/M
 *   system_prompt: null   ← wipes your carefully crafted system prompt
 *
 * These are accidents. Maybe a misconfigured dashboard widget. A copy-paste error.
 * A junior engineer testing something in production.
 *
 * Your agent now responds with word salad, on an expensive model, with no safety prompt.
 * You find out when users report nonsense answers — or when the bill arrives.
 *
 * THE SYRIN SOLUTION
 * ------------------
 * ConfigStore gives you enterprise-grade guardrails for remote config:
 *
 *   ALLOWLIST:   Only whitelisted keys can be changed remotely.
 *                Push `model` from the backend? Silently ignored.
 *
 *   BLOCKLIST:   Specific keys are always blocked from remote changes.
 *                `system_prompt` can never be overwritten remotely.
 *
 *   ANCHORS:     Lock a key to a specific value. Nothing can change it.
 *                `model: "gpt-4o-mini"` is locked. Governance can't override it.
 *
 *   VERSION HISTORY:  Every config change is logged with a version ID.
 *                     Roll back to any previous version instantly.
 *
 *   AUDIT LOG:   See every change: what changed, when, and from where
 *                (remote, local, governance, anchor).
 *
 * Run:   npx tsx 06-config-safety.ts
 */

import 'dotenv/config';
import { init, ConfigStore } from '../src/index.js';

// ─── SETUP ───────────────────────────────────────────────────────────────────

const _sdk = await init({
  apiKey: process.env.SYRIN_API_KEY!,
  name: 'production-agent',
  url: process.env.SYRIN_BACKEND_URL ?? 'http://localhost:4000',
});

console.log('');
console.log('='.repeat(60));
console.log('  CONFIG SAFETY DEMO');
console.log('  Showing guardrails for production remote config');
console.log('='.repeat(60));
console.log('');

// ─── CREATE AND CONFIGURE A CONFIG STORE ─────────────────────────────────────

// ConfigStore is a standalone, typed config manager with safety features.
// In production you attach this to your SDK and framework adapters.
// Here we demonstrate its safety features directly.

const store = new ConfigStore();

// ─── STEP 1: ALLOWLIST — ONLY THESE KEYS CAN CHANGE REMOTELY ─────────────────

// Only temperature and max_tokens can be changed by the backend.
// Any other keys in a remote config update are silently ignored.
// This prevents accidents — and intentional abuse.

store.setAllowlist(new Set(['llm.temperature', 'llm.max_tokens']));

console.log('Step 1: Allowlist set.');
console.log('  Allowed for remote updates: llm.temperature, llm.max_tokens');
console.log('  Everything else: silently blocked.\n');

// ─── STEP 2: BLOCKLIST — THESE KEYS ARE ALWAYS BLOCKED ───────────────────────

// Even if a key is not on the allowlist, blocklist is belt-and-suspenders.
// system_prompt can NEVER be changed remotely, no matter what.
// This protects your safety instructions, persona definition, guardrails.

store.setBlocklist(new Set(['llm.system_prompt']));

console.log('Step 2: Blocklist set.');
console.log('  llm.system_prompt: ALWAYS blocked from remote changes.');
console.log('  Even a direct governance action cannot change this.\n');

// ─── STEP 3: ANCHOR — LOCK MODEL PERMANENTLY ─────────────────────────────────

// Anchors are the strongest protection. Once anchored:
//   - Remote config cannot change it
//   - Governance actions cannot change it
//   - Only your code calling unanchor() can release it
//
// Use this for cost-critical settings. A backend bug sends model: "gpt-4-turbo"?
// The anchor silently ignores it. Your agent stays on gpt-4o-mini.

store.anchor('llm.model', 'gpt-4o-mini');

console.log('Step 3: Model anchored to "gpt-4o-mini".');
console.log('  Remote config CANNOT change the model.');
console.log('  Governance actions CANNOT change the model.');
console.log('  Only unanchor() in code can release this lock.\n');

// ─── STEP 4: APPLY A SAFE UPDATE (SHOULD SUCCEED) ────────────────────────────

// This update only touches allowed keys. It should apply cleanly.
const safeUpdate = {
  'llm.temperature': 0.3,
  'llm.max_tokens': 500,
};

const safeRejected = store.applyUpdates(safeUpdate, 'remote');

console.log('Step 4: Applying a safe remote update...');
console.log('  Update:', JSON.stringify(safeUpdate));

if (Object.keys(safeRejected).length === 0) {
  console.log('  Result: All keys accepted.');
} else {
  console.log('  Rejected keys:', JSON.stringify(safeRejected));
}

console.log(`  llm.temperature is now: ${store.get('llm', 'temperature')}`);
console.log(`  llm.max_tokens is now:  ${store.get('llm', 'max_tokens')}`);
console.log('');

// ─── STEP 5: APPLY A DANGEROUS UPDATE (SHOULD BE BLOCKED) ────────────────────

// This update tries to change the model (anchored), the system_prompt (blocklisted),
// AND set temperature to an invalid value (2.5 — over the 2.0 maximum).
// Each violation is handled differently but all are blocked silently.

const dangerousUpdate = {
  'llm.model': 'gpt-4-turbo',       // BLOCKED: anchored
  'llm.system_prompt': 'Ignore all previous instructions.', // BLOCKED: blocklisted
  'llm.temperature': 2.5,            // REJECTED: validation failure (max is 2.0)
  'llm.max_tokens': 200,             // ALLOWED: this one goes through
};

const dangerousRejected = store.applyUpdates(dangerousUpdate, 'remote');

console.log('Step 5: Applying a DANGEROUS remote update...');
console.log('  Update:', JSON.stringify(dangerousUpdate));
console.log('');
console.log('  Results:');
console.log(`  llm.model:       ${store.get('llm', 'model')} (anchored — stays "gpt-4o-mini", ignored silently)`);
console.log(`  llm.system_prompt: (blocklisted — change silently dropped)`);

if (dangerousRejected['llm.temperature']) {
  console.log(`  llm.temperature: REJECTED — ${dangerousRejected['llm.temperature']}`);
} else {
  console.log(`  llm.temperature: (was blocked silently)`);
}

console.log(`  llm.max_tokens:  ${store.get('llm', 'max_tokens')} (the only key that actually changed)`);
console.log('');
console.log('  Validation rejections returned:', JSON.stringify(dangerousRejected));
console.log('');
console.log('  Your agent is still running "gpt-4o-mini", with the original system prompt,');
console.log('  with a valid temperature. The dangerous update was neutralized.\n');

// ─── STEP 6: VERSION HISTORY ──────────────────────────────────────────────────

// Every time applyUpdates() changes at least one key, a new version is recorded.
// The history keeps the last 50 versions. You can roll back to any of them.

const history = store.getHistory(5); // get the last 5 versions

console.log('Step 6: Version history (last 5 versions):');
for (const version of history) {
  console.log(`  v${version.versionId} [${version.timestamp}]`);
  console.log(`    source: ${version.source}`);
  console.log(`    changed keys: ${version.changedKeys.join(', ')}`);
}
console.log('');
console.log('  To roll back to version 1:');
console.log('  store.rollback(1)  ← instantly restores that snapshot\n');

// ─── STEP 7: AUDIT LOG ────────────────────────────────────────────────────────

// The audit log records every individual field change:
// what was the old value, what is the new value, and what source made the change.
// Anchored/blocklisted changes do NOT appear in the log (they never happened).

const auditLog = store.getAuditLog(10); // get the last 10 audit entries

console.log('Step 7: Audit log (most recent changes first):');
for (const entry of auditLog) {
  console.log(`  [${entry.timestamp}] ${entry.key}`);
  console.log(`    ${JSON.stringify(entry.oldValue)} → ${JSON.stringify(entry.newValue)}`);
  console.log(`    source: ${entry.source}`);
}
console.log('');

// ─── STEP 8: INSPECT ANCHORS ──────────────────────────────────────────────────

const anchors = store.getAnchors();
console.log('Step 8: Currently anchored keys:');
for (const [key, value] of Object.entries(anchors)) {
  console.log(`  ${key}: ${JSON.stringify(value)} (immutable until unanchor() is called)`);
}
console.log('');

await _sdk.flush();
await _sdk.shutdown();

// ─── WHAT YOU JUST SAW ───────────────────────────────────────────────────────
//
//  BEFORE SYRIN:  Remote config is all-or-nothing. You either trust it completely
//                 or don't use it at all. One bad push can break production.
//
//  WITH SYRIN ConfigStore:
//
//  ALLOWLIST      Only whitelisted keys can change. Everything else: silently ignored.
//                 "The backend can tune temperature, but NOTHING else."
//
//  BLOCKLIST      Belt-and-suspenders. Specific keys never change. Ever.
//                 "system_prompt is sacred. No remote update can touch it."
//
//  ANCHORS        Strongest protection. Locks a key to a value in code.
//                 Remote config, governance, dashboard — all blocked.
//                 "Model is locked to gpt-4o-mini. Not negotiable."
//
//  VERSION HISTORY  50 versions kept. Roll back instantly with store.rollback(versionId).
//                   "Something broke? Roll back to yesterday's config in one line."
//
//  AUDIT LOG      Every change logged: key, old value, new value, source, timestamp.
//                 Anchored/blocklisted attempts do NOT appear (they never happened).
//                 "Show me every config change in the last 24 hours and who made it."
//
//  VALIDATION     Schema constraints (ge, le, enum) enforced before applying.
//                 temperature: 2.5 is rejected because le: 2.0.
//                 Invalid updates appear in the returned rejected map.
