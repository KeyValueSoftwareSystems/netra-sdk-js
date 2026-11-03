/**
 * The logger every module of the Netra SDK uses.
 *
 * `debug`, `info`, `warn`, `error` and `log` follow debug mode: they print only
 * when `Netra.init({ debugMode: true })` was called or `NETRA_DEBUG` is "1" or
 * "true", because most of what the SDK logs is internal detail a developer
 * cannot act on.
 *
 * `notice` is the exception. It is for problems the developer has to fix: a
 * missing endpoint, a rejected export, an invalid argument to a public method,
 * a failed API call. It prints whether or not debug mode is on, every time it
 * is called.
 */

const PREFIX = "[Netra]";

/** Severity of a notice: printed with console.warn or console.error. */
export type NoticeLevel = "warn" | "error";

export class NetraLogger {
  private static _debugMode = false;

  /**
   * Turn debug output on or off for every module. Called once by Netra.init().
   *
   * @param enabled - `true` to print debug/info/warn/error/log output.
   * @returns Nothing.
   */
  static setDebugMode(enabled: boolean): void {
    this._debugMode = enabled;
  }

  /**
   * Whether level methods currently print.
   *
   * `NETRA_DEBUG` is read on every call, so setting it at runtime takes effect
   * immediately.
   *
   * @returns `true` if `setDebugMode(true)` was called or `NETRA_DEBUG` is "1"
   *   or "true" (any case); otherwise `false`.
   */
  static isDebugMode(): boolean {
    return (
      this._debugMode ||
      ["1", "true"].includes((process.env.NETRA_DEBUG ?? "").toLowerCase())
    );
  }

  /**
   * Print through console.debug, in debug mode only.
   *
   * @param args - Values to print after the "[Netra]" prefix, as console.debug would.
   * @returns Nothing.
   */
  static debug(...args: unknown[]): void {
    if (this.isDebugMode()) console.debug(PREFIX, ...args);
  }

  /**
   * Print through console.info, in debug mode only.
   *
   * @param args - Values to print after the "[Netra]" prefix, as console.info would.
   * @returns Nothing.
   */
  static info(...args: unknown[]): void {
    if (this.isDebugMode()) console.info(PREFIX, ...args);
  }

  /**
   * Print through console.warn, in debug mode only.
   *
   * @param args - Values to print after the "[Netra]" prefix, as console.warn would.
   * @returns Nothing.
   */
  static warn(...args: unknown[]): void {
    if (this.isDebugMode()) console.warn(PREFIX, ...args);
  }

  /**
   * Print through console.error, in debug mode only. For a failure the
   * developer must see regardless of debug mode, use `notice("error", ...)`.
   *
   * @param args - Values to print after the "[Netra]" prefix, as console.error would.
   * @returns Nothing.
   */
  static error(...args: unknown[]): void {
    if (this.isDebugMode()) console.error(PREFIX, ...args);
  }

  /**
   * Print through console.log, in debug mode only.
   *
   * @param args - Values to print after the "[Netra]" prefix, as console.log would.
   * @returns Nothing.
   */
  static log(...args: unknown[]): void {
    if (this.isDebugMode()) console.log(PREFIX, ...args);
  }

  /**
   * Report a problem the developer has to fix. Printed whether or not debug
   * mode is on; repeats are not collapsed.
   *
   * @param level - "warn" (console.warn) for something to fix, "error"
   *   (console.error) for a failure such as a rejected API call.
   * @param args - Values to print after the "[Netra]" prefix. Errors and
   *   objects are passed to the console as-is, not stringified.
   * @returns Nothing.
   */
  static notice(level: NoticeLevel, ...args: unknown[]): void {
    if (level === "error") {
      console.error(PREFIX, ...args);
      return;
    }
    console.warn(PREFIX, ...args);
  }
}
