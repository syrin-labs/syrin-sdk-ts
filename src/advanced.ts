/**
 * Syrin SDK — Advanced / power-user surface
 *
 * Primary surface:  import { init } from '@syrin/sdk'
 * Advanced surface: import { ConfigSync } from '@syrin/sdk/advanced'
 *                   import { ConfigSync } from '../src/advanced.js'
 *
 * These APIs are intended for framework authors, custom integrations, and
 * power users who need access to internal primitives. Most developers will
 * never need to import from this module.
 */

export { ConfigSync } from '@/core/config-sync.js';
export type { ConfigSyncOptions } from '@/core/config-sync.js';
export { SyrinSDKCore } from '@/core/engine.js';
export { SyrinLogger, getLogger, setLogger } from '@/observability/logger.js';
export type { LogLevel } from '@/observability/logger.js';
export { IdentityManager, getIdentityManager, setIdentityManager } from '@/core/identity.js';
export { CallInterceptor, getCallInterceptor, setCallInterceptor } from '@/control/call-interceptor.js';
export { ToolGovernance, getToolGovernance, setToolGovernance } from '@/control/tool-governance.js';
export type { CompleteControlConfig } from '@/control/complete-control-schema.js';
export { validateConfigValue, getConfigType, PARAMETER_CONSTRAINTS } from '@/control/complete-control-schema.js';
export { ConfigStore } from '@/config/store.js';
export type { FieldSchema, ConfigVersion, AuditEntry } from '@/config/store.js';
export { tunable, TunableField, tune, getTune, globalRegistry, TunableRegistry } from '@/tunable/tunable.js';
export type { TuneOptions, TuneFieldDef } from '@/tunable/tunable.js';
// Also accessible from primary surface — duplicated here for convenience
export { makeSessionId } from '@/index.js';
