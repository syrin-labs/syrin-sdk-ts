/**
 * Syrin SDK — Billing awareness
 *
 * Parses billing info from backend responses (registration + ingest),
 * logs plan/usage on startup, and surfaces limit warnings/exceeded errors
 * as console messages so users notice them in logs.
 */

export interface UsageSummary {
  used: number;
  limit: number;   // -1 = unlimited
  pct: number;
  warning: boolean;
  exceeded: boolean;
}

export interface BillingInfo {
  plan: 'starter' | 'pro' | 'enterprise' | null;
  planStatus: 'pending' | 'active' | 'expired' | 'cancelled' | null;
  usage: {
    traces: UsageSummary;
    agents: UsageSummary;
    projects: UsageSummary;
    governanceRules: UsageSummary;
  } | null;
  features: {
    experiments: boolean;
    remoteConfig: boolean;
    approvals: boolean;
    analyticsRetentionDays: number;
  } | null;
  warnings: string[];
  exceeded: string[];
}

export function parseBilling(data: unknown): BillingInfo | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;

  try {
    const usageData = d['usage'] as Record<string, unknown> | undefined;
    const featuresData = d['features'] as Record<string, unknown> | undefined;

    const parseUsageSummary = (u: unknown): UsageSummary => {
      const s = (u ?? {}) as Record<string, unknown>;
      return {
        used: (s['used'] as number) ?? 0,
        limit: (s['limit'] as number) ?? -1,
        pct: (s['pct'] as number) ?? 0,
        warning: (s['warning'] as boolean) ?? false,
        exceeded: (s['exceeded'] as boolean) ?? false,
      };
    };

    return {
      plan: (d['plan'] as BillingInfo['plan']) ?? null,
      planStatus: (d['planStatus'] as BillingInfo['planStatus']) ?? null,
      usage: usageData ? {
        traces: parseUsageSummary(usageData['traces']),
        agents: parseUsageSummary(usageData['agents']),
        projects: parseUsageSummary(usageData['projects']),
        governanceRules: parseUsageSummary(usageData['governanceRules']),
      } : null,
      features: featuresData ? {
        experiments: (featuresData['experiments'] as boolean) ?? false,
        remoteConfig: (featuresData['remoteConfig'] as boolean) ?? false,
        approvals: (featuresData['approvals'] as boolean) ?? false,
        analyticsRetentionDays: (featuresData['analyticsRetentionDays'] as number) ?? 7,
      } : null,
      warnings: (d['warnings'] as string[]) ?? [],
      exceeded: (d['exceeded'] as string[]) ?? [],
    };
  } catch {
    return null;
  }
}

export function logBillingOnRegister(billing: BillingInfo): void {
  const plan = billing.plan ?? 'none';
  const status = billing.planStatus ?? 'unknown';
  console.log(`[Syrin SDK] Billing: plan=${plan} status=${status}`);

  if (billing.usage) {
    const t = billing.usage.traces;
    if (t.limit === -1) {
      console.log(`[Syrin SDK] Billing: traces=${t.used} (unlimited)`);
    } else {
      console.log(`[Syrin SDK] Billing: traces=${t.used}/${t.limit} (${t.pct}%)`);
    }
  }

  for (const warning of billing.warnings) {
    console.warn(`[Syrin SDK] Billing warning: ${warning}`);
  }
  for (const exceeded of billing.exceeded) {
    console.error(`[Syrin SDK] Billing limit exceeded: ${exceeded}`);
  }
}

export function logBillingOnIngest(billing: BillingInfo): void {
  for (const warning of billing.warnings) {
    console.warn(`[Syrin SDK] Billing warning: ${warning}`);
  }
  for (const exceeded of billing.exceeded) {
    console.error(`[Syrin SDK] Billing limit exceeded: ${exceeded}. Upgrade at https://app.syrin.ai/billing`);
  }
}
