/**
 * Doble del módulo `vscode` para pruebas de integración en Node puro.
 * Cubre solo la superficie que usa esta extensión.
 */

export class Disposable {
  constructor(private readonly callback: () => void = () => {}) {}
  dispose(): void {
    this.callback();
  }
}

export class EventEmitter<T> {
  #listeners = new Set<(event: T) => void>();

  readonly event = (listener: (event: T) => void): Disposable => {
    this.#listeners.add(listener);
    return new Disposable(() => this.#listeners.delete(listener));
  };

  fire(event: T): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}

export class LanguageModelDataPart {
  constructor(
    public data: Uint8Array,
    public mimeType: string,
  ) {}

  static json(value: unknown, mime?: string): LanguageModelDataPart {
    return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mime ?? 'application/json');
  }
}

export const enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}

export class LanguageModelError extends Error {
  static Blocked(message?: string): LanguageModelError {
    return new LanguageModelError(message, 'Blocked');
  }
  static NotFound(message?: string): LanguageModelError {
    return new LanguageModelError(message, 'NotFound');
  }
  static NoPermissions(message?: string): LanguageModelError {
    return new LanguageModelError(message, 'NoPermissions');
  }
  constructor(
    message?: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'LanguageModelError';
  }
}

export interface RegisteredCommand {
  id: string;
  handler: (...args: unknown[]) => unknown;
}

export const registeredCommands: RegisteredCommand[] = [];
export const chatProviderRegistrations: Array<{ vendor: string; provider: unknown }> = [];
export const informationMessages: string[] = [];
export const warningMessages: string[] = [];

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): Disposable {
    registeredCommands.push({ id, handler });
    return new Disposable(() => {
      const index = registeredCommands.findIndex((entry) => entry.id === id);
      if (index >= 0) registeredCommands.splice(index, 1);
    });
  },
  async executeCommand(id: string): Promise<unknown> {
    const entry = registeredCommands.find((command) => command.id === id);
    return entry?.handler();
  },
};

class OutputChannelStub {
  lines: string[] = [];
  appendLine(line: string): void {
    this.lines.push(line);
  }
  append(text: string): void {
    this.lines.push(text);
  }
  debug(message: string): void {
    this.lines.push(`[debug] ${message}`);
  }
  info(message: string): void {
    this.lines.push(`[info] ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`[warn] ${message}`);
  }
  error(message: string): void {
    this.lines.push(`[error] ${message}`);
  }
  show(): void {}
  dispose(): void {}
}

export const outputChannels: OutputChannelStub[] = [];

export const ProgressLocation = { Notification: 15, Window: 10, SourceControl: 1 };

export const window = {
  createOutputChannel(_name: string, _options?: { log?: boolean }): OutputChannelStub {
    const channel = new OutputChannelStub();
    outputChannels.push(channel);
    return channel;
  },
  showInformationMessage(message: string): Thenable<string | undefined> {
    informationMessages.push(message);
    return Promise.resolve(undefined);
  },
  showWarningMessage(message: string): Thenable<string | undefined> {
    warningMessages.push(message);
    return Promise.resolve(undefined);
  },
  async showQuickPick<T>(): Promise<T | undefined> {
    return undefined;
  },
  async withProgress<T>(_options: unknown, task: () => Promise<T>): Promise<T> {
    return task();
  },
};

export interface ConfigurationStub {
  values: Record<string, unknown>;
}

export const configuration: ConfigurationStub = { values: {} };

export const workspace = {
  getConfiguration(_section?: string) {
    return {
      get<T>(key: string, fallback: T): T {
        const value = configuration.values[key];
        return value === undefined ? fallback : (value as T);
      },
    };
  },
  onDidChangeConfiguration(): Disposable {
    return new Disposable();
  },
};

export const Uri = {
  joinPath(base: { fsPath: string }, ...parts: string[]): { fsPath: string } {
    return { fsPath: [base.fsPath, ...parts].join('/') };
  },
};

export const lm = {
  registerLanguageModelChatProvider(vendor: string, provider: unknown): Disposable {
    chatProviderRegistrations.push({ vendor, provider });
    return new Disposable();
  },
};

export const extensions = {
  getExtension(): undefined {
    return undefined;
  },
};

export const version = '1.142.0-test';
