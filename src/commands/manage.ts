import * as vscode from 'vscode';

import type { ModelCatalog } from '../zen/catalog';

interface ManageAction extends vscode.QuickPickItem {
  action: 'refresh' | 'diagnostics' | 'logs' | 'settings';
}

/** Punto de entrada del `managementCommand` declarado en el manifiesto. */
export function registerManageCommand(catalog: ModelCatalog): vscode.Disposable {
  return vscode.commands.registerCommand('opencode-free.manage', async () => {
    const snapshot = catalog.snapshot();
    const items: ManageAction[] = [
      {
        label: '$(refresh) Actualizar modelos',
        description: `catálogo ${snapshot.status}`,
        action: 'refresh',
      },
      {
        label: '$(output) Mostrar diagnóstico',
        description: `${snapshot.exposed} modelos expuestos`,
        action: 'diagnostics',
      },
      {
        label: '$(list-unordered) Mostrar registros',
        action: 'logs',
      },
      {
        label: '$(gear) Abrir ajustes',
        action: 'settings',
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'OpenCode Free',
      placeHolder: 'Modelos gratuitos de OpenCode Zen para el chat de VS Code',
    });
    if (picked === undefined) return;
    switch (picked.action) {
      case 'refresh':
        await vscode.commands.executeCommand('opencode-free.refreshModels');
        break;
      case 'diagnostics':
        await vscode.commands.executeCommand('opencode-free.showDiagnostics');
        break;
      case 'logs':
        await vscode.commands.executeCommand('opencode-free.showLogs');
        break;
      case 'settings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.opencode-free');
        break;
    }
  });
}
