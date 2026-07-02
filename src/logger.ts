/**
 * Centralized logger for the Netra SDK.
 *
 * Call Logger.setDebugMode(true) once during Netra.init() so all modules
 * automatically respect the configured debug flag without passing Config around.
 */

const PREFIX = "[Netra]";

export class Logger {
  private static _debugMode = false;

  static setDebugMode(enabled: boolean): void {
    this._debugMode = enabled;
  }

  private static get isDebug(): boolean {
    return (
      this._debugMode ||
      ["1", "true"].includes((process.env.NETRA_DEBUG ?? "").toLowerCase())
    );
  }

  static isDebugMode(): boolean {
    return this.isDebug;
  }

  static debug(...args: any[]): void {
    if (this.isDebug) console.debug(PREFIX, ...args);
  }

  static info(...args: any[]): void {
    if (this.isDebug) console.info(PREFIX, ...args);
  }

  static warn(...args: any[]): void {
    if (this.isDebug) console.warn(PREFIX, ...args);
  }

  static error(...args: any[]): void {
    console.error(PREFIX, ...args);
  }

  static log(...args: any[]): void {
    if (this.isDebug) console.log(PREFIX, ...args);
  }
}
