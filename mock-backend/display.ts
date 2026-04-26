/**
 * ANSI colour helpers and console display utilities.
 */

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
} as const;

export function timestamp(): string {
  const now = new Date();
  const hms = now.toTimeString().split(' ')[0]!;
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hms}.${ms}`;
}

export function formatCost(usd: number): string {
  if (usd < 0.0001) return `$${usd.toFixed(8)}`;
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

export interface SyrinEventLike {
  event_type?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  duration_ms?: number;
  stream?: boolean;
  config_applied?: boolean;
  error?: string;
}

export function formatEvent(event: SyrinEventLike): string {
  const type =
    event.event_type === 'LLM_CALL' ? `${C.green}LLM_CALL${C.reset}` :
    event.event_type === 'LLM_ERROR' ? `${C.red}LLM_ERROR${C.reset}` :
    `${C.yellow}${event.event_type}${C.reset}`;

  const model = `${C.cyan}${event.model ?? '?'}${C.reset}`;
  const tokens = `${C.dim}${event.input_tokens?.toLocaleString() ?? '?'}→${event.output_tokens?.toLocaleString() ?? '?'} tokens${C.reset}`;
  const cost = event.cost_usd != null ? `${C.yellow}${formatCost(event.cost_usd)}${C.reset}` : '';
  const duration = event.duration_ms != null ? `${C.dim}${event.duration_ms}ms${C.reset}` : '';
  const stream = event.stream ? `${C.blue}[stream]${C.reset} ` : '';
  const config = event.config_applied ? `${C.magenta}[cfg]${C.reset} ` : '';
  const error = event.error ? ` ${C.red}ERR: ${event.error}${C.reset}` : ` ${C.green}✓${C.reset}`;

  return `  ${type}  ${model}  ${tokens}  ${cost}  ${duration}  ${stream}${config}${error}`;
}
