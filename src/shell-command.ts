/**
 * Command shapes for the confined shells.
 *
 * Pi's built-in PowerShell backend prepends a UTF-8 console switch and, for Windows PowerShell
 * 5.1, appends an exit-code fix-up (5.1 turns redirected native stderr into error records and
 * clears `$?`, so `git push 2>&1 | Select-Object -Last 3` would exit 1 although git exited 0).
 * Replacing the tool's `operations` bypasses `createLocalPowerShellOperations`, so this module
 * reproduces both strings byte for byte; a unit test pins them against the installed Pi bundle.
 */
import { win32 } from "node:path";

/** Must equal `UTF8_OUTPUT_PREFIX` in `dist/core/tools/powershell.js`. */
export const POWERSHELL_UTF8_OUTPUT_PREFIX =
	"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/** Must equal `WINDOWS_POWERSHELL_EXIT_SUFFIX` in `dist/core/tools/powershell.js`. */
export const WINDOWS_POWERSHELL_EXIT_SUFFIX =
	'\n;\nif ($?) { exit 0 }\nif (($LASTEXITCODE -eq 0) -and ("$($Error[0].FullyQualifiedErrorId)" -like "NativeCommandError*")) { exit 0 }\nexit 1';

/**
 * The exact `-Command` payload Pi would hand to PowerShell for `command`.
 * The suffix is skipped when the last line ends with a backtick, which would continue the user's
 * line into the suffix, and for PowerShell 7 (which does not need it).
 */
export function composePowerShellCommand(command: string, shellPath: string): string {
	const suffix =
		win32.basename(shellPath).toLowerCase() === "powershell.exe" && !command.endsWith("`")
			? WINDOWS_POWERSHELL_EXIT_SUFFIX
			: "";
	return `${POWERSHELL_UTF8_OUTPUT_PREFIX}${command}${suffix}`;
}