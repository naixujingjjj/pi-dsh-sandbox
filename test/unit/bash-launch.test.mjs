import test from "node:test";
import assert from "node:assert/strict";
import { bashStartupFailure, isCygwinStartupFailure } from "../../src/tools/shell-tools.ts";

// Exactly what GitHub's Windows runner produced for a Git-for-Windows bash inside the restricted
// token: the shell dies before running the command, so no command exit code exists at all.
const cygwinCrash =
	"      0 [main] bash (2232) C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe: *** fatal error - couldn't create signal pipe, Win32 error 5\n\n\nCommand exited with code 3221225794";

test("a cygwin signal-pipe crash is an unusable bash, not a command result", () => {
	assert.equal(isCygwinStartupFailure(cygwinCrash), true);
	assert.equal(isCygwinStartupFailure("SANDBOX_BASH_SMOKE\n"), false);
	assert.equal(isCygwinStartupFailure("bash: line 1: foo: command not found\n"), false);
	assert.equal(isCygwinStartupFailure(""), false);
});

test("the unusable-bash error fails closed and names the reason and the way out", () => {
	const error = bashStartupFailure("C:\\Program Files\\Git\\bin\\bash.exe");
	assert.equal(error.code, "SANDBOX_UNAVAILABLE");
	assert.match(error.message, /找不到可用的 bash/);
	assert.match(error.message, /cygwin/);
	assert.match(error.message, /powershell/);
	assert.match(error.message, /shellPath/);
	assert.match(error.message, /不会以未受限方式执行/, "the message must promise no unconfined fallback");
});