# Usage

The core of this extension is: under **read-only** / **workspace-write**, ordinary tools always go through the sandbox; only a one-off `sandbox_request` / `/sandbox exec` approved by a human runs with off. `off` mode does not intervene, and ordinary tools take Pi's built-in path.

## 1. The three modes

| mode | meaning | shell / `!` | `write` / `edit` |
| --- | --- | --- | --- |
| `off` | the extension does not intervene | Pi's built-in path, unrestricted | Pi's built-in path, unrestricted |
| `read-only` | read-only | restricted token; any write/delete is denied by the kernel | denied before any filesystem call (including `mkdir`) |
| `workspace-write` | writable workspace | restricted token; can write only the authorization root + private temp | the actual write to disk is performed by a helper inside the restricted process |

The default is `workspace-write`. The mode affects only the **current session**; restoring an old session does not bring back a mode that was loosened in that old session, and the configuration always starts from the global setting/CLI.

## 2. The `/sandbox` command

| Command | Effect |
| --- | --- |
| `/sandbox` or `/sandbox mode` | Opens the mode menu. The current mode is listed first; `↑`/`↓` to select, `Enter` to confirm, `Esc` to cancel. Without an interactive UI, only the status and usage are shown |
| `/sandbox status` | Shows the version, the mode and its source, the canonical root, `enforcement: partial`, approval capability, runner/backend versions, temp, ipc, and bash state |
| `/sandbox mode read-only` | Tightens to read-only, no confirmation needed |
| `/sandbox mode workspace-write` | Widens to the writable workspace, **requires confirmation** |
| `/sandbox mode off` | Turns the sandbox off entirely, **requires confirmation**; refused when there is no UI |
| `/sandbox doctor` | Runs a real self-check in a separate temporary workspace: read-only startup/write denial, writable inside the root, directory creation inside the root, write denial outside the root, delete denial outside the root, exit-code passthrough; in addition it runs a "workspace ready" check against the **session's real workspace root** |
| `/sandbox exec <command>` | Executes one exact command once with off, through the same four-option approval as the model |
| `/sandbox help` | Usage |

Loosening the restrictions (`read-only` → `workspace-write` → `off`) uses the same yellow confirmation card/panel in the interactive TUI; the default selection is "cancel", and `Esc`, cancel, an unavailable panel, or a session change will **not** loosen anything.

`/sandbox status` is the fastest way to self-check. It does not execute any command; it only reads the current runtime state.

## 3. Authorization root

- The default root = the **canonical real path** of the current session's `cwd` (resolving junctions, symbolic links, and 8.3 short names).
- A session's root is fixed when the session starts. `cd D:\work\demo` in a command changes only that child process's working directory; it **does not change the authorization root**, and it does not make `D:\work\demo` writable.
- To make another directory the root: start Pi in that other directory. Do not try to "switch the authorization root" inside a command.
- The private temp of each runner invocation is outside the root, and the child process's `TMP`/`TEMP` point there; `tempRoot` can be changed to another drive.

## 4. Model request: `sandbox_request`

The model may call `sandbox_request` in the following situations:

- it anticipates that an ordinary restricted command will be denied by the kernel (for example, it needs to write outside the authorization root);
- a restricted command has already failed clearly and, after confirming that no side effect occurred, a specific out-of-bounds operation needs to be completed.

Parameters:

| Parameter | Constraint |
| --- | --- |
| `command` | Required, non-empty; the **exact PowerShell command** displayed and executed by the approval UI (as-is, not rewritten) |
| `reason` | Required, non-empty; the model's own reason for the request, **shown only to the approver**, not a user instruction |
| `timeout` | Optional; a finite positive number of seconds, maximum **600**; on timeout the command's process tree is killed |

`cwd` is fixed to the current session's canonical authorization root; the model cannot specify another cwd, and cannot request "persistent authorization", a mode switch, or a different runner.

Parameter illustration (not a configuration file for you to write by hand):

```json
{
  "command": "New-Item -ItemType Directory -Path 'D:\\work\\demo\\generated' -Force",
  "reason": "The generated artifacts need to be written to a project directory outside the authorization root",
  "timeout": 60
}
```

## 5. The four-option approval

The model tool and the manual `/sandbox exec` use the same set of four choices:

| Option | Behavior |
| --- | --- |
| `Yes` | Immediately executes **this one, exact command** once |
| `No` | Does not execute |
| `Yes, and reason…` | Executes this command; after the operation ends, the model first reports the execution facts truthfully and then completes the supplementary requirement you entered |
| `No, and reason…` | **Does not execute**; the text you enter is the new direction for the current task, and the model replans accordingly |

### 5.1 The two options with text

- **`Yes, and reason…`**: fill in the input box with "the supplementary requirement after this operation completes" (required). The command runs once exactly as displayed on screen. After success or failure, the model must first report the exit code, the output, and the actual side effects, then complete this requirement (for example, explain the intent, effect, and result of this operation), and then continue the task. The text does not rewrite the command.
- **`No, and reason…`**: fill in the input box with "the rejection reason or a new execution direction" (required). The command is **never executed**. This text is handed to the model as a **new user instruction for the current task**: the model replans along the new direction and continues with ordinary sandbox tools, and you do not need to send the prompt again; if the new direction still requires crossing the boundary, a new request must be made for the new command.

The text only affects the model's subsequent behavior; **it is not a new persistent permission**, it does not change the mode, it does not authorize later tools, and it is not spliced into the command.

### 5.2 Behavior of the reason input box

- The input boxes of both text options start out **completely blank, with no placeholder text**; the title states what should be entered.
- The input area has two **yellow separator lines**, above and below, and the entered text and the **cursor** are also yellow.
- `Enter` submits; `Esc` cancels (equivalent to not approving this time); `Backspace` deletes; `←`/`→` (as well as `Ctrl+A`/`Ctrl+E`) move; `Ctrl+U`/`Ctrl+K`/`Ctrl+W` delete; `Ctrl+-` (Windows' `Ctrl+Z`) undoes; Chinese input and paste are supported (a line break in the paste is merged into the same line).
- Leaving it empty, entering only whitespace, or canceling the input **all mean no approval this time** — an already selected `Yes, and reason…` does not make it pass by default.
- While the approval window is open, the draft in the editor is still preserved; after the panel closes, focus returns to the editor.

### 5.3 Interactive TUI: a card in the message stream + a small panel at the bottom

- The complete request (source, request reason, the full command between `----- BEGIN COMMAND -----`/`END COMMAND`, cwd, mode, off execution method, timeout) is displayed in a **yellow card in the message stream** and does not replace the editor.
- At the bottom is a small yellow approval panel holding only the four options and the key hints; it **does not repeat the full command**. `1`–`4` only move the selection and do not approve; only an explicit `Enter` confirms.
- `F2` hides the panel and hands focus back to the viewport/editor, so you can look back at earlier model output with the wheel or `PageUp`; above the editor, "approval pending: … · press F2 to return to the approval panel · nothing will be executed meanwhile" appears. Press `F2` again to return, and the selected item and the reason you already typed are preserved.
- **Hiding is not answering**: nothing is executed while hidden; pressing `Enter` in the editor only sends your own message. `Esc`/`Ctrl+C` cancels, and the command is not executed.
- After the approval ends, a result card appears below the card (approved/rejected/canceled, whether it was executed, exit code, cwd, mode, the instruction you wrote). Approving **does not change** the mode in `/sandbox status`.

The TUI's yellow is a fixed RGB color and does not follow the theme's `warning`; changing themes will not turn the approval UI blue or green.

### 5.4 RPC / T3 / print / json

- `--mode rpc` (hosts such as T3) keeps the host's native `select` + `input` dialogs: the titles are plain text (without ANSI), and the colors and layout are decided by the host; there is **no yellow card/panel**, but it is still four options.
- `print`/`json` have no UI that can approve, so both `sandbox_request` and `/sandbox exec` fail closed and are never auto-approved.
- Subagents without a confirmable UI likewise cannot approve on their behalf; the error message points out that the upper-level agent or the user should initiate it in an interactive terminal.

### 5.5 Language follows the conversation automatically

The approval UI picks Chinese/English directly from the user's prompt; there is no `language`/`locale` configuration item, and the operating system language is not read either:

- **Only the latest real user prompt on the current branch is considered**: assistant replies, tool results, the model's request reason, and messages generated by the extension do not decide the language.
- **If there is Chinese, use Chinese**: a single Han character is enough; a mix of Chinese and English is always Chinese-first, and the code, paths, and quotations in the prompt are included in the judgment.
- **If there is no Chinese and there are English letters, use English**: this includes short replies such as `ok` and `continue`; word counts are not computed, and language-switching instructions are not interpreted.
- **An empty message or only digits/symbols**: keep searching backward; when there is no usable prompt, the default is Chinese. Old cards without a locale are still displayed in Chinese.
- **No change in the middle of one approval**: the language is pinned to this request when the request starts; the approval card, the bottom panel, the reason input box, the RPC `select`/`input` text, the result card, `/sandbox exec`, and the mode-loosening confirmation all use the same language. If the user later chats in another language, an approval that is already waiting does not get mixed languages.
- **Historical cards are redrawn in the language saved at the time**: result cards and manual `/sandbox exec` cards save the language of that moment; tool request cards are restored from the saved language of this approval, so a "Chinese request + English result" splice never appears.

The translation scope is the UI copy (titles, source, labels, timeout/waiting state, result status, panel/key/F2 hints, the titles and descriptions of the two reason input boxes, RPC dialog text, the loosening confirmation, and the user-visible approval prompts in the approved/rejected/canceled result). **Commands, request reasons, and the text you enter in the approval window are always displayed as-is and are never translated**; the four options `Yes` / `No` / `Yes, and reason…` / `No, and reason…` also stay fixed English.

Only a Chinese/English UI is provided, and no model API is called. Diagnostic output such as `/sandbox status` and `/sandbox help` is still mainly in Chinese and is not part of the approval UI.

## 6. Example

```text
/sandbox status
/sandbox mode read-only
/sandbox doctor
/sandbox exec Write-Output 'ok'
/sandbox exec New-Item -ItemType Directory -Path 'D:\work\demo\out' -Force
```

Assume the session is in `D:\work\demo`:

- `powershell` writes `D:\work\demo\src\a.txt`: allowed.
- `powershell` writes `D:\work\other\a.txt`: denied by the kernel, and the tool result adds a `SANDBOX_DENIED` hint.
- `write` writes `D:\work\other\a.txt`: the extension gives `SANDBOX_DENIED` up front; even if the upfront check fails, the actual write to disk is denied by the restricted helper.
- To write `D:\work\other`: have the model issue a `sandbox_request`, or do it manually with `/sandbox exec`, and approve it as described in section 5.

## 7. Reads, network, and approval

`read`/`ls`/`grep`/`find`, MCP's web search/fetch, and the like **do not go through** this extension, and there is no additional write approval for them. `sandbox_request` is only responsible for one explicit out-of-bounds **execution**; it does not mean "every tool has to be approved".

## 8. Records and sessions

- Approvals record the `requestId`/`toolCallId`, the time, the cwd, the mode, the status, hashes of the command and the request reason, and the approval text entered by the human along with its source. Command output and file contents are **not recorded**.
- The approval text enters the session as an instruction (the tool path goes into the tool result; a manual `/sandbox exec` goes into a user message), so it is saved in the session record. **Do not put passwords or tokens in it.**
- Switching sessions while an approval is pending, `/reload`, a mode change, a `Ctrl+C` interrupt, and so on invalidate a late approval; closing one approval does not accidentally answer the next one.

## 9. Things not to do

- Do not treat `/sandbox mode off` as your everyday default; it is the same as not having this extension installed.
- Do not keep requesting the same command just because of one rejection; adjust to the new direction from `No, and reason…` and only then decide whether a new request is needed.
- Do not expect `sandbox_request` to have an "allow from now on" effect; every approval is one-off and bound to a fixed cwd.