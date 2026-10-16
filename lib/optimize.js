// 纯粹的「白话 → 提示词」逻辑：不碰宿主、不 fetch，可单独自测。
// 宿主侧 lib/index.js 只负责取 llm 与路由，逻辑全在这儿。

/** 统一的失败信封，status 直接透传成 HTTP status。 */
export function fail(status, code, message) {
  return { ok: false, status, error: { code, message } };
}

/**
 * 「看起来是空白」：除掉空白和不可见字符后什么都不剩。
 * trim() 只吃空白，吃不下零宽字符——\u200b（零宽空格）这类字符在输入框里完全看不见，
 * 但 trim() 之后仍是非空串。实测只发一个 \u200b 会真的发起一次模型调用、记一次尝试
 * （用户 2026-10 报的「输入框是空白的也不要记尝试」就是这个）。\ufeff/\u00a0 已含在 \s 里。
 */
export function isBlankText(text) {
  return typeof text !== "string" || text.replace(/[\s\u200b-\u200f\u2060]/g, "") === "";
}

/**
 * 校验改写请求体。空草稿不发请求（这是按钮点击的第一道闸）。
 * @returns {{ok: true, text: string} | {ok: false, status: number, code: string, message: string}}
 */
export function checkRequest(body, maxInputChars = 8000) {
  if (body === null || typeof body !== "object") return fail(400, "bad-json", "request body must be an object");
  const text = body.text;
  if (typeof text !== "string") return fail(400, "bad-text", "field 'text' must be a string");
  if (isBlankText(text)) return fail(400, "empty", "draft is empty, nothing to optimize");
  const trimmed = text.trim();
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

/**
 * 请求里可选的模型覆盖。{ provider, model } 必须都是非空字符串才算数；
 * 缺省/残缺一律当没传（调用方据此回落到会话当前模型）。
 * @returns {{provider: string, model: string} | null}
 */
export function pickModel(body) {
  const m = body?.model;
  if (m === undefined || m === null || typeof m !== "object") return null;
  const provider = typeof m.provider === "string" ? m.provider.trim() : "";
  const model = typeof m.model === "string" ? m.model.trim() : "";
  if (provider === "" || model === "") return null;
  return { provider, model };
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
