import * as vscode from 'vscode';

import type { LoggerLike } from './log';
import { ModelCatalog } from './zen/catalog';
import { ZenClient } from './zen/client';
import { OpenCodeFreeChatProvider, type RequestTuning } from './provider/chat-provider';
import { registerRefreshModelsCommand } from './commands/refresh-models';
import { registerDiagnosticsCommand } from './commands/diagnostics';
import { registerManageCommand } from './commands/manage';
import { registerAgentGuideCommand } from './commands/agent-guide';

const VENDOR = 'opencode-free';

/** Registro sobre el canal de salida «OpenCode Free» (canal de registro con
 *  niveles, persistido también en los archivos de log de VS Code). */
class ChannelLogger implements LoggerLike {
  constructor(
    private readonly channel: vscode.LogOutputChannel,
    private readonly isDebugEnabled: () => boolean,
  ) {}

  private format(message: string, rest: unknown[]): string {
    return rest.length > 0 ? `${message} ${rest.map((item) => safeStringify(item)).join(' ')}` : message;
  }

  debug(message: string, ...rest: unknown[]): void {
    if (this.isDebugEnabled()) this.channel.debug(this.format(message, rest));
  }

  info(message: string, ...rest: unknown[]): void {
    this.channel.info(this.format(message, rest));
  }

  warn(message: string, ...rest: unknown[]): void {
    this.channel.warn(this.format(message, rest));
  }

  error(message: string, ...rest: unknown[]): void {
    this.channel.error(this.format(message, rest));
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function readTuning(): RequestTuning {
  const config = vscode.workspace.getConfiguration(VENDOR);
  return {
    firstEventTimeoutMs: clamp(config.get<number>('request.firstEventTimeoutSeconds', 30), 5, 600) * 1000,
    idleEventTimeoutMs: clamp(config.get<number>('request.idleTimeoutSeconds', 120), 10, 600) * 1000,
    maxRetries: clamp(config.get<number>('request.maxRetries', 3), 0, 10),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('OpenCode Free', { log: true });
  const logger = new ChannelLogger(channel, () =>
    vscode.workspace.getConfiguration(VENDOR).get<boolean>('debug', false),
  );

  const config = vscode.workspace.getConfiguration(VENDOR);
  const refreshSeconds = clamp(config.get<number>('catalog.refreshMinutes', 5), 1, 240) * 60;

  let provider: OpenCodeFreeChatProvider | undefined;

  const catalog = new ModelCatalog({
    refreshSeconds,
    cachePath: vscode.Uri.joinPath(context.globalStorageUri, 'models.dev.cache.json').fsPath,
    fetchImpl: fetch,
    log: logger,
    onRefresh: (snapshot, lastError) => {
      logger.debug(`ronda de refresco: ${JSON.stringify(snapshot)}${lastError.length > 0 ? ` error=${lastError}` : ''}`);
      provider?.notifyCatalogRefresh();
    },
  });

  const client = new ZenClient(logger);

  provider = new OpenCodeFreeChatProvider({
    catalog,
    client,
    log: logger,
    getTuning: readTuning,
  });

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    provider,
    { dispose: () => catalog.stop() },
    registerRefreshModelsCommand(catalog, logger),
    registerDiagnosticsCommand(catalog, channel),
    registerManageCommand(catalog),
    registerAgentGuideCommand(),
    vscode.commands.registerCommand('opencode-free.showLogs', () => channel.show(true)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(VENDOR)) return;
      const next = vscode.workspace.getConfiguration(VENDOR);
      catalog.setRefreshSeconds(clamp(next.get<number>('catalog.refreshMinutes', 5), 1, 240) * 60);
      logger.debug('configuración actualizada');
    }),
    channel,
  );

  logger.info('OpenCode Free activado (lane anónimo de OpenCode Zen, sin clave)');
  void catalog.start().catch((err) => {
    logger.error(`no se pudo iniciar el catálogo: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export function deactivate(): void {
  // Los recursos viven en context.subscriptions.
}
