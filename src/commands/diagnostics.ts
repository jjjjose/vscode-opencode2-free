import * as vscode from 'vscode';

import type { ModelCatalog } from '../zen/catalog';
import { AGENT_COMFORTABLE_CONTEXT, publishedWindows } from '../provider/model-information';

/**
 * Diagnóstico: vuelca el estado del catálogo, las decisiones por modelo y los
 * ajustes efectivos al canal de salida. Nunca imprime contenido de
 * conversaciones ni valores sensibles (el lane es anónimo por diseño).
 */
export function registerDiagnosticsCommand(
  catalog: ModelCatalog,
  channel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('opencode-free.showDiagnostics', async () => {
    const snapshot = catalog.snapshot();
    const config = vscode.workspace.getConfiguration('opencode-free');
    const lines: string[] = [];
    lines.push('=== OpenCode Free · diagnóstico ===');
    lines.push(`extensión:      ${vscode.extensions.getExtension('local.opencode-free')?.packageJSON?.version ?? '1.1.0'}`);
    lines.push(`vscode:         ${vscode.version}`);
    lines.push(`catálogo:       ${snapshot.status} · ${snapshot.exposed} expuestos / ${snapshot.total} total`);
    lines.push(`último refresco:${snapshot.lastRefresh !== undefined ? ` ${snapshot.lastRefresh}` : ' aún pendiente'}`);
    if (catalog.lastError.length > 0) lines.push(`último error:   ${catalog.lastError}`);
    lines.push('');
    lines.push('modelos expuestos y decisión:');
    for (const id of catalog.available()) {
      const decision = catalog.decision(id);
      const limits = catalog.limits(id);
      const modalities = catalog.modalities(id);
      lines.push(
        `  - ${id} · nombre=${catalog.metadata(id)?.name ?? id} · expuesto=${decision.allowed} · fuente=${catalog.source(id)} · decisión=${decision.source} · contexto=${limits?.contextWindow ?? 'estimado: 8192'}` +
          ` · entrada=${limits?.maxInput ?? 'derivada del contexto'} · herramientas=${catalog.metadata(id)?.toolCalling ?? 'desconocido'}` +
          ` · salida=${limits?.maxOutput ?? 'por defecto'}` +
          ` · entradas=${modalities !== undefined ? modalities.join('+') : 'por defecto'}`,
      );
    }
    lines.push('');
    lines.push('sesiones de agente (el host compara el contexto estático con el presupuesto del modelo):');
    const wide = catalog.available().filter((id) => publishedWindows(catalog.limits(id)).maxInput >= AGENT_COMFORTABLE_CONTEXT);
    const narrow = catalog.available().filter((id) => publishedWindows(catalog.limits(id)).maxInput < AGENT_COMFORTABLE_CONTEXT);
    lines.push(`  ventana ≥512K (recomendados con muchos MCP): ${wide.length > 0 ? wide.join(', ') : 'ninguno'}`);
    lines.push(`  ventana <512K (pueden bloquearse con muchos MCP): ${narrow.length > 0 ? narrow.join(', ') : 'ninguno'}`);
    lines.push('  guía: comando «OpenCode Free: El agente no responde».');
    lines.push('');
    lines.push('ajustes efectivos:');
    lines.push(`  refreshMinutes=${config.get<number>('catalog.refreshMinutes', 5)}`);
    lines.push(`  firstEventTimeoutSeconds=${config.get<number>('request.firstEventTimeoutSeconds', 30)}`);
    lines.push(`  idleTimeoutSeconds=${config.get<number>('request.idleTimeoutSeconds', 120)}`);
    lines.push(`  maxRetries=${config.get<number>('request.maxRetries', 3)}`);
    lines.push(`  debug=${config.get<boolean>('debug', false)}`);
    lines.push('');
    // Los canales de registro persisten además en los archivos de log de VS Code.
    const logChannel = channel as vscode.LogOutputChannel;
    if (typeof logChannel.info === 'function') logChannel.info(lines.join('\n'));
    else channel.appendLine(lines.join('\n'));
    channel.show(true);
    void vscode.window.showInformationMessage(
      `OpenCode Free: ${snapshot.exposed} modelos expuestos (catálogo ${snapshot.status}). Detalle en el canal de salida.`,
    );
  });
}
