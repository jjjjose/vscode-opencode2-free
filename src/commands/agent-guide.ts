import * as vscode from 'vscode';

/**
 * Guía accionable para el bloqueo de turnos en sesiones de agente por
 * contexto estático (chequeo previo del host, anterior al proveedor). Solo
 * explica y ofrece atajos; no lee ni imprime contenido de conversaciones.
 */

const MESSAGE =
  '¿Un turno de sesión de agente termina al instante con «No response was returned»? ' +
  'Si en el canal «OpenCode Free» no aparece la línea «petición →», el turno se bloqueó antes de llegar al proveedor.';

const DETAIL = [
  'Motivo: el host de agentes compara el contexto estático (prompt de sistema + definiciones de herramientas/MCP) contra la ventana del modelo. Con muchos servidores MCP, esas definiciones por sí solas superan los 200K tokens (agravado por el inflado de definiciones, copilot-cli#5151), así que los modelos de 200K–262K se quedan sin presupuesto.',
  '',
  'Soluciones:',
  '1. Elige un modelo de 1M del grupo «OpenCode Free»: Space Bunny, Cat Jam, Nemotron 3.5 Super VL o LongCat 2.5 Preview.',
  '2. O abre el selector de herramientas de la sesión y desactiva MCP que no uses; luego repite el turno.',
  '3. El chat/agente de la ventana suele funcionar con cualquier modelo porque difiere las herramientas.',
].join('\n');

export function registerAgentGuideCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('opencode-free.agentNoResponse', async () => {
    const choice = await vscode.window.showWarningMessage(
      MESSAGE,
      { modal: false, detail: DETAIL },
      'Elegir modelo',
      'Abrir herramientas',
      'Ver registro',
    );
    if (choice === 'Elegir modelo') await runCommandSafe('workbench.action.chat.changeModel');
    else if (choice === 'Abrir herramientas') await runCommandSafe('workbench.action.chat.configureTools');
    else if (choice === 'Ver registro') await runCommandSafe('opencode-free.showLogs');
  });
}

/** Los comandos del workbench pueden no existir en otras versiones; el aviso sigue siendo válido. */
async function runCommandSafe(command: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(command);
  } catch {
    // Sin efecto: el aviso y sus instrucciones ya quedaron visibles.
  }
}
