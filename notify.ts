/**
 * OS notifications with no native dependency.
 *
 * Replaces node-notifier, which vendors `terminal-notifier.app` as an **x86_64-only**
 * Mach-O binary. On Apple Silicon every toast therefore has to go through Rosetta 2,
 * and where Rosetta is not installed it cannot run at all — `arch -arm64` on that
 * binary answers "Bad CPU type in executable". node-notifier has been unmaintained
 * since 2022, so the vendored binary is not getting rebuilt upstream.
 *
 * The system tools are universal and already present:
 *   - macOS: `osascript` (x86_64 + arm64e) → `display notification`
 *   - Linux: `notify-send` (libnotify), when installed
 *
 * Notifications are a nicety. Every failure in here is swallowed to debug: nothing
 * in this module may take the proxy down, throw into a request path, or block.
 */
import { execFile } from 'node:child_process';
import consola from 'consola';

export interface NotifyOptions {
    title: string;
    message: string;
    /** macOS only; ignored on other platforms. */
    sound?: boolean;
}

/**
 * Render a string as an AppleScript string literal.
 *
 * AppleScript has no `\n` escape, and a raw newline inside a quoted literal is a
 * syntax error, so control characters are flattened to spaces before quoting.
 * Exported for tests.
 */
export function appleScriptString(s: string): string {
    const flat = s
        .replace(/[\r\n\t\v\f]+/g, ' ')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, '');
    return `"${flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

let _unsupportedWarned = false;

/** Fire-and-forget OS notification. Never throws. */
export function osNotify({ title, message, sound = false }: NotifyOptions): void {
    try {
        if (process.platform === 'darwin') {
            const script =
                `display notification ${appleScriptString(message)}` +
                ` with title ${appleScriptString(title)}` +
                (sound ? ' sound name "default"' : '');
            // execFile, not exec: the script is passed as an argv entry, so no shell
            // ever sees it. A URL or a scraped response body in `message` cannot be
            // reinterpreted as a command.
            execFile('osascript', ['-e', script], (err) => {
                if (err) consola.debug(`osNotify: osascript failed: ${err.message}`);
            });
            return;
        }

        if (process.platform === 'linux') {
            execFile('notify-send', [title, message], (err) => {
                if (err) {
                    consola.debug(
                        `osNotify: notify-send failed (is libnotify-bin installed?): ${err.message}`
                    );
                }
            });
            return;
        }

        if (!_unsupportedWarned) {
            _unsupportedWarned = true;
            consola.debug(`osNotify: no notification backend for platform ${process.platform}`);
        }
    } catch (err: any) {
        consola.debug(`osNotify: ${err?.message ?? err}`);
    }
}
