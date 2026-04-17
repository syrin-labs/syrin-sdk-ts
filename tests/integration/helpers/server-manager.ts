/**
 * Server Manager — Spawn and manage example agent servers for integration testing
 *
 * Handles:
 * - Spawning server processes with isolated env vars
 * - Waiting for servers to be healthy
 * - Graceful shutdown
 * - Config directory isolation (each server gets its own temp dir)
 */

import { spawn, ChildProcess } from 'child_process';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'http';

export interface ServerDef {
  name: string;
  script: string; // path to example .ts file relative to SDK root
  port: number;
  agentId: string;
  framework?: string; // 'openai', 'anthropic', 'langchain', 'mastra', 'vercel'
}

export interface ServerHandle {
  def: ServerDef;
  process: ChildProcess;
  configDir: string;
  url: string;
  kill(): Promise<void>;
}

/**
 * Start a single server with isolated config directory
 */
export async function startServer(def: ServerDef): Promise<ServerHandle> {
  const configDir = mkdtempSync(join(tmpdir(), `syrin-test-${def.name}-`));

  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...process.env,
      PORT: String(def.port),
      SYRIN_CONFIG_DIR: configDir,
      // Keep backend URL from env or use localhost
      SYRIN_BACKEND_URL: process.env.SYRIN_BACKEND_URL ?? 'http://localhost:4000',
    };

    // Spawn the server with tsx (TypeScript runner)
    const child = spawn('npx', ['tsx', def.script], {
      cwd: join(process.cwd(), 'syrin-sdk-ts'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let errorOutput = '';

    child.stdout?.on('data', (data) => {
      output += data.toString();
    });

    child.stderr?.on('data', (data) => {
      errorOutput += data.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start ${def.name}: ${err.message}`));
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${def.name} exited with code ${code}\nStdout:\n${output}\nStderr:\n${errorOutput}`,
          ),
        );
      }
    });

    const handle: ServerHandle = {
      def,
      process: child,
      configDir,
      url: `http://localhost:${def.port}`,
      kill: async () => {
        return new Promise((resolveKill) => {
          if (!child.killed) {
            child.kill('SIGTERM');
            setTimeout(() => {
              if (!child.killed) child.kill('SIGKILL');
              resolveKill();
            }, 2000);
          } else {
            resolveKill();
          }
          // Cleanup temp directory
          try {
            rmSync(configDir, { recursive: true, force: true });
          } catch {
            // Ignore cleanup errors
          }
        });
      },
    };

    // Wait for server to be healthy
    waitForServer(handle.url, 30_000).then(() => resolve(handle)).catch(reject);
  });
}

/**
 * Wait for a server to respond to GET /
 */
export async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const checkHealth = () => {
      http
        .get(`${url}/`, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            retry();
          }
        })
        .on('error', () => {
          retry();
        });
    };

    const retry = () => {
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`Server ${url} did not become healthy within ${timeoutMs}ms`));
      } else {
        setTimeout(checkHealth, 200);
      }
    };

    checkHealth();
  });
}

/**
 * Start all servers in parallel
 */
export async function startAll(servers: ServerDef[]): Promise<ServerHandle[]> {
  return Promise.all(servers.map((def) => startServer(def)));
}

/**
 * Stop all servers and cleanup
 */
export async function stopAll(handles: ServerHandle[]): Promise<void> {
  await Promise.all(handles.map((h) => h.kill()));
}
