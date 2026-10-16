import * as vscode from 'vscode';

import type { LoggerLike } from '../log';
import type { ModelCatalog } from '../zen/catalog';

export function registerRefreshModelsCommand(catalog: ModelCatalog, log: LoggerLike): vscode.Disposable {
  return vscode.commands.registerCommand('opencode-free.refreshModels', async () => {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'OpenCode Free: actualizando catálogo de modelos…',
      },
      async () => {
        await catalog.refreshOnce();
        const snapshot = catalog.snapshot();
        if (snapshot.status === 'error') {
          log.warn(`catálogo no actualizado: ${catalog.lastError}`);
          void vscode.window.showWarningMessage(
            `OpenCode Free: no se pudo actualizar el catálogo. ${catalog.lastError}`,
          );
          return;
        }
        const detail =
          snapshot.status === 'stale'
            ? ` (el catálogo en vivo no respondió; ${catalog.lastError})`
            : '';
        log.info(`catálogo actualizado: ${snapshot.exposed}/${snapshot.total} modelos expuestos`);
        void vscode.window.showInformationMessage(
          `OpenCode Free: ${snapshot.exposed} modelos gratuitos disponibles de ${snapshot.total} en el catálogo${detail}.`,
        );
      },
    );
  });
}
