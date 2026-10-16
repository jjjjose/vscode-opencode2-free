/**
 * Contrato de registro mínimo usado por las capas puras (zen/*).
 * La implementación real vive en extension.ts sobre un OutputChannel.
 */
export interface LoggerLike {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}
