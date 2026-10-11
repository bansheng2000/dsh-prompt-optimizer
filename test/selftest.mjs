// 自测：不连宿主，只验纯逻辑 + insertText 的冲突分支语义（照宿主复刻的最小形状）。
import assert from "node:assert/strict";
import { checkRequest, normalizePromptify, SYSTEM_PROMPT, userPrompt, fail } from "../lib/optimize.js";

// --- checkRequest ---
assert.deepEqual(checkRequest({ text: "帮我写个爬虫" }), { ok: true, text: "帮我写个爬虫" });
assert.deepEqual(
  checkRequest(null),
  { ok: false, status: 400, error: { code: "bad-json", message: "request body must be an object" } },
);
assert.deepEqual(
  checkRequest({ text: 42 }),
  { ok: false, status: 400, error: { code: "bad-text", message: "field 'text' must be a string" } },
);
assert.deepEqual(
  checkRequest({ text: "   \n " }),
  { ok: false, status: 400, error: { code: "empty", message: "draft is empty, nothing to optimize" } },
);
assert.deepEqual(
  checkRequest({ text: "x".repeat(20) }, 10),
  { ok: false, status: 413, error: { code: "too-long", message: "draft is 20 chars, limit 10" } },
);
assert.equal(checkRequest({ text: "ok".repeat(5) }, 100).ok, true);

// --- normalizePromptify：剥围栏 + 剥空白 ---
assert.equal(normalizePromptify(42), "");
assert.equal(normalizePromptify("  正文  "), "正文");
assert.equal(normalizePromptify("```\n第一行\n第二行\n```"), "第一行\n第二行");
assert.equal(normalizePromptify("~~~md\n只有一行~~~"), "只有一行");
assert.equal(normalizePromptify("```\n没有收尾"), "```\n没有收尾"); // 缺尾围栏 → 原样返回
// 围栏匹配锚定 ^$：内嵌中间围栏不许吃掉正文
assert.equal(normalizePromptify("前\n```\n中\n```\n后").includes("中"), true);

// --- prompt 形状 ---
assert.ok(SYSTEM_PROMPT.includes("只输出改写后的提示词正文"));
assert.equal(userPrompt("A"), "把下面这段口语化需求改写成提示词：\n\nA");

// --- fail ---
assert.deepEqual(fail(503, "no-llm", "x"), { ok: false, status: 503, error: { code: "no-llm", message: "x" } });

// --- insertText 冲突分支（照 SessionInputShell.actions.insertText 语义的最小复刻）---
function makeInsertText(initialRev) {
  return function insertText(text, span) {
    if (span.draftRev !== initialRev) return false; // 宿主机同名判定
    return String(text).length; // 成功时宿主返回 undefined，这里只示意「插入长度」
  };
}
const okSpan = { start: 0, end: 4, draftRev: 7 };
assert.equal(makeInsertText(7)("新草稿", okSpan), 3);
assert.equal(makeInsertText(8)("新草稿", okSpan), false); // rev 漂移 → 冲突

console.log("ok - lib/optimize.js self-test passed");
