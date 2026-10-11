// 纯粹的「白话 → 提示词」逻辑：不碰宿主、不 fetch，可单独自测。
// 宿主侧 lib/index.js 只负责取 llm 与路由，逻辑全在这儿。

/** 统一的失败信封，status 直接透传成 HTTP status。 */
export function fail(status, code, message) {
  return { ok: false, status, error: { code, message } };
}

/**
 * 校验改写请求体。空草稿不发请求（这是按钮点击的第一道闸）。
 * @returns {{ok: true, text: string} | {ok: false, status: number, code: string, message: string}}
 */
export function checkRequest(body, maxInputChars = 8000) {
  if (body === null || typeof body !== "object") return fail(400, "bad-json", "request body must be an object");
  const text = body.text;
  if (typeof text !== "string") return fail(400, "bad-text", "field 'text' must be a string");
  const trimmed = text.trim();
  if (trimmed === "") return fail(400, "empty", "draft is empty, nothing to optimize");
  if (trimmed.length > maxInputChars) return fail(413, "too-long", `draft is ${trimmed.length} chars, limit ${maxInputChars}`);
  return { ok: true, text };
}

/** 去掉模型爱加的 markdown 代码围栏，只留围栏里的正文。 */
const FENCE_RE = /^(?:```|~~~)[a-zA-Z0-9_-]*\n([\s\S]*?)\n?(?:```|~~~)$/;

/** 把 LLM 的原始输出收敛成可直接写回输入框的一段话。 */
export function normalizePromptify(raw) {
  if (typeof raw !== "string") return "";
  let out = raw.trim();
  const fenced = FENCE_RE.exec(out);
  if (fenced) out = fenced[1].trim();
  return out;
}

/** LLM 的 system prompt：只输出改写后的提示词本身，任何解释都不要。 */
export const SYSTEM_PROMPT = [
  "你是提示词工程师。把用户用口语描述的需求改写成一条结构化、可直接交给 AI 执行的提示词。",
  "要求：",
  "- 只输出改写后的提示词正文，不要解释、不要道歉、不要加「好的」这类前缀。",
  "- 不要用 markdown 代码围栏包裹，不要输出多段候选。",
  "- 保留用户提到的所有实体、文件名、技术栈和约束；缺失的信息不要编造。",
  "- 中文需求用中文输出，英文需求用英文输出。",
  "- 若需求已经足够结构化，原样返回即可，不要为了改写而改写。",
].join("\n");

/** user 消息正文：明确告诉模型这就是要改写的原文。 */
export function userPrompt(text) {
  return `把下面这段口语化需求改写成提示词：\n\n${text}`;
}
