/** User prompts determine approval language; mixed Chinese/English always stays Chinese. */
import test from "node:test";
import assert from "node:assert/strict";
import { detectLocaleFromBranch, detectLocaleFromSession, detectLocaleFromText, detectLocaleFromTexts } from "../../src/locale.ts";
const user = (content) => ({ type: "message", message: { role: "user", content } });
const assistant = (text) => ({ type: "message", message: { role: "assistant", content: [{type:"text", text}] } });
const toolResult = (toolName, details) => ({ type: "message", message: { role: "toolResult", toolName, details } });

test("any Chinese character wins over English, commands, code and language requests", () => {
    for (const prompt of ["中文", "中", "Please update the README 中", "用英文回答", "English please 中文", "```js\nconst name = '中文';\n```", "C:\\中文\\file.txt", "请运行 npm test"]) {
        assert.equal(detectLocaleFromText(prompt), "zh", prompt);
    }
});

test("English text, including short replies and technical text, selects English", () => {
    for (const prompt of ["Please fix the tests", "ok", "y", "continue", "README", "`npm test`", "C:\\work\\file.txt", "Please reply in Chinese"]) {
        assert.equal(detectLocaleFromText(prompt), "en", prompt);
    }
    assert.equal(detectLocaleFromTexts(["中文任务", "ok"]), "en");
    assert.equal(detectLocaleFromTexts(["English task", "继续"]), "zh");
});

test("empty and non-language prompts retain the preceding language; no context defaults to Chinese", () => {
    for (const prompt of ["", "123", "???", "👍"]) assert.equal(detectLocaleFromText(prompt), undefined);
    assert.equal(detectLocaleFromTexts(["English task", "123"]), "en");
    assert.equal(detectLocaleFromSession(undefined), "zh");
    assert.equal(detectLocaleFromSession({ getBranch: () => [] }), "zh");
    assert.equal(detectLocaleFromSession({ getBranch: () => { throw new Error("unavailable"); } }), "zh");
});

test("only real user messages decide: assistant text, tool results and plugin messages are ignored", () => {
	const branch = [
		user("请只修改工作区里的文件"),
		assistant("Sure, I will answer in English from now on."),
		toolResult("sandbox_request", { locale: "en" }),
	];
	assert.equal(detectLocaleFromBranch(branch), "zh");

	const englishBranch = [
		user("Please keep the approval UI in English"),
		assistant("好的，我会用中文回答。"),
		toolResult("read", { text: "中文工具结果" }),
	];
	assert.equal(detectLocaleFromBranch(englishBranch), "en");

	// A genuine user message in a mixed branch still wins after a plugin follow-up was appended.
	const followUp = "[pi-dsh-sandbox] 审批窗口里的补充指令（人工命令，不是模型 sandbox_request）\n----- BEGIN COMMAND -----\nWrite-Output 'English please'\n";
	assert.equal(detectLocaleFromBranch([user("请修复构建"), user(followUp)]), "zh");
	assert.equal(detectLocaleFromBranch([user("Please fix the build"), user(followUp)]), "en");
});

test("only the branch handed in is read (current branch, no cross-session pollution)", () => {
	const currentBranch = [user("请检查当前分支")];
	const abandonedBranch = [user("Please put the approval UI in English")];
	assert.equal(detectLocaleFromBranch(currentBranch), "zh");
	assert.equal(detectLocaleFromBranch(abandonedBranch), "en");
	// The session manager's getBranch is the only source; there is no global cache.
	assert.equal(detectLocaleFromSession({ getBranch: () => currentBranch, getEntries: () => abandonedBranch }), "zh");
});

test("content blocks and plain strings are read identically", () => {
	assert.equal(detectLocaleFromBranch([user([{ type: "text", text: "Please run the tests" }, { type: "image", data: "x" }])]), "en");
	assert.equal(detectLocaleFromBranch([user([{ type: "image", data: "x" }])]), undefined);
	assert.equal(detectLocaleFromTexts(["", "请继续"]), "zh");
	assert.equal(detectLocaleFromTexts([]), undefined);
});

