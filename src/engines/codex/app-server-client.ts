import { execSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { CodexBotConfig } from '../../config.js';
import type { Logger } from '../../utils/logger.js';

const isWindows = process.platform === 'win32';

function resolveCodexPath(): string {
  if (process.env.CODEX_EXECUTABLE_PATH) return process.env.CODEX_EXECUTABLE_PATH;
  try {
    const cmd = isWindows ? 'where codex' : 'which codex';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
  } catch {
    return isWindows ? 'codex' : '/usr/local/bin/codex';
  }
}

export interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexAppServerClientOptions {
  codexConfig: CodexBotConfig;
  logger: Logger;
  botName: string;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type NotificationHandler = (notification: JsonRpcNotification) => void;
type CloseHandler = (error?: Error) => void;
type JsonRpcId = string | number;

function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private initialized = false;
  private stderr = '';
  private readonly stderrCapBytes = 64 * 1024;

  constructor(private opts: CodexAppServerClientOptions) {}

  async start(): Promise<void> {
    if (this.child) return;

    const executable = this.opts.codexConfig.executable || resolveCodexPath();
    const args = ['app-server', '--listen', 'stdio://'];
    const env = {
      ...process.env,
      MB_CALLER_BOT: this.opts.botName,
      ...(this.opts.codexConfig.env ?? {}),
    };

    this.child = spawn(executable, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf-8');
      if (this.stderr.length > this.stderrCapBytes) {
        this.stderr = this.stderr.slice(-this.stderrCapBytes);
      }
    });
    this.child.on('error', (err) => this.failAll(err));
    this.child.on('close', (code, signal) => {
      const err = code === 0 || signal === 'SIGTERM'
        ? undefined
        : new Error(`Codex app-server exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
      if (err) this.failAll(err);
      for (const handler of this.closeHandlers) handler(err);
    });

    await this.request('initialize', {
      clientInfo: { name: 'metabot', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }, 15_000);
    this.notify('initialized', {});
    this.initialized = true;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<T> {
    if (!this.child) throw new Error('Codex app-server is not started');
    const id = ++this.requestId;
    const payload = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
    this.child.stdin.write(JSON.stringify(payload) + '\n');
    return promise;
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  close(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server connection closed'));
      this.pending.delete(id);
    }
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = undefined;
  }

  getStderr(): string {
    return this.stderr;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch (err) {
      this.opts.logger.warn({ err, line }, 'Failed to parse Codex app-server JSON-RPC line');
      return;
    }

    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string' && (typeof message.id === 'number' || typeof message.id === 'string')) {
      if (this.handleServerRequest(message)) return;
      this.replyUnhandledServerRequest(message.id, message.method);
      return;
    }

    if (typeof message.method === 'string') {
      const notification = {
        method: message.method,
        params: message.params && typeof message.params === 'object' ? message.params : {},
      };
      for (const handler of this.notificationHandlers) {
        try {
          handler(notification);
        } catch (err) {
          this.opts.logger.warn({ err, method: notification.method }, 'Codex app-server notification handler failed');
        }
      }
    }
  }

  private handleServerRequest(message: {
    id: JsonRpcId;
    method: string;
    params?: Record<string, unknown>;
  }): boolean {
    if (message.method !== 'mcpServer/elicitation/request') return false;

    const meta = message.params?._meta;
    if (!meta || typeof meta !== 'object') return false;
    const metaObj = meta as Record<string, unknown>;
    if (metaObj.tool_name !== 'access_browser_origin') return false;

    const toolParams = metaObj.tool_params && typeof metaObj.tool_params === 'object'
      ? metaObj.tool_params as Record<string, unknown>
      : {};
    const origin = normalizeOrigin(toolParams.origin ?? metaObj.origin);
    const allowed = new Set((this.opts.codexConfig.autoApproveBrowserOrigins ?? [])
      .map(normalizeOrigin)
      .filter((item): item is string => !!item));

    if (!origin || !allowed.has(origin)) {
      this.opts.logger.warn(
        { origin, allowedOrigins: Array.from(allowed) },
        'Refusing Codex browser-origin auto-approval request',
      );
      return false;
    }

    this.opts.logger.info({ origin }, 'Auto-approving Codex browser-origin request');
    this.replyServerRequest(message.id, {
      action: 'accept',
      content: {},
    });
    return true;
  }

  private replyServerRequest(id: JsonRpcId, result: Record<string, unknown>): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private replyUnhandledServerRequest(id: JsonRpcId, method: string): void {
    if (!this.child) return;
    this.opts.logger.warn({ method }, 'Unhandled Codex app-server request');
    this.child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unhandled server request: ${method}` },
    }) + '\n');
  }

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

export function codexAppServerEnabled(config: CodexBotConfig | undefined): boolean {
  return (config?.transport || process.env.CODEX_TRANSPORT) === 'app-server';
}
