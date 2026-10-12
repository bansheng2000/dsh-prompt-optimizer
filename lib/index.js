import { SYSTEM_PROMPT, userPrompt, checkRequest, normalizePromptify, fail } from "./optimize.js";

/**
 * dsh-prompt-optimizer 宿主侧：一条 HTTP 路由，POST {text} → 改写后的提示词。
 *
 * 契约（asar 实证）：
 * - ctx.llm.stream({provider, model, messages, maxTokens, sessionId, signal}) 逐分片 yield，
 *   顺手用 @deepseek-ai/dsh-llm 的 BlockAssembler 收块（dsh-compaction 的 summarizer 同款用法）。
 * - messages 接受 request-only 输入：{role:"user", content:[{type:"text", text}]}，无需 id/source。
 * - 目标解析照 compaction summarizer：session.requestHeader()?.config → agent.options → 全局默认。
 * - GUI 挂在 <base href="./"> 下，path 不能用 leading slash（客户端按 document.baseURI 解析）。
 */

const name = "dsh-prompt-optimizer";
const inject = [];

export { name };

const MAX_INPUT_CHARS = 8000;
const TIMEOUT_MS = 60000;
const MAX_TOKENS = 1024;

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 2_000_000) { req.destroy(); finish(null); }
    });
    req.on("error", () => finish(null));
    req.on("end", () => {
      if (done) return;
      try { finish(JSON.parse(raw || "{}")); } catch { finish(null); }
    });
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

async function resolveTarget(sctx, sessionId) {
  // 1) 当前会话最近一次请求的 provider/model
  const agent = sctx.agents?.get?.(sessionId);
  const header = agent?.session?.requestHeader?.();
  const fromHeader = header?.config;
  if (fromHeader?.provider && fromHeader?.model) {
    return { provider: fromHeader.provider, model: fromHeader.model };
  }
  // 2) AgentOptions 上显式指定的
  const opts = agent?.options;
  if (opts?.provider && opts?.model) {
    return { provider: opts.provider, model: opts.model };
  }
  // 3) 全局当前选择
  try {
    const cur = sctx.agentDefaultModel?.currentSelection?.();
    if (cur?.provider && cur?.model) return { provider: cur.provider, model: cur.model };
  } catch { /* ignore */ }
  return null;
}

export function apply(ctx, config) {
  const rules = config?.rules ?? {};
  const maxInputChars = rules.maxInputChars > 0 ? rules.maxInputChars : MAX_INPUT_CHARS;
  const timeoutMs = rules.timeoutMs > 0 ? rules.timeoutMs : TIMEOUT_MS;

  ctx.inject(["webServer", "llm", "agentDefaultModel"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.webServer.register(
        {
          kind: "prefix",
          path: "prompt-optimizer/api",
          handler: async (req, res) => {
            const host = req.headers.host ?? "localhost";
            let sub;
            try {
              sub = new URL(String(req.url ?? "/"), `http://${host}`).pathname.slice("/prompt-optimizer/api".length);
            } catch {
              writeJson(res, 400, fail(400, "bad-url", "cannot parse request url"));
              return;
            }
            if (req.method !== "POST") {
              writeJson(res, 405, fail(405, "method", "only POST is supported"));
              return;
            }
            // 客户端 POST 的就是前缀本身（prompt-optimizer/api），没有子路径。
            if (sub.replace(/^\/+|\/+$/g, "") !== "") {
              writeJson(res, 404, fail(404, "no-route", `unknown sub-route ${sub}`));
              return;
            }

            const body = await readJson(req);
            if (body === null) {
              writeJson(res, 400, fail(400, "bad-json", "request body is not valid JSON"));
              return;
            }

            const checked = checkRequest(body, maxInputChars);
            if (!checked.ok) {
              writeJson(res, checked.status, checked);
              return;
            }

            const llm = sctx.llm;
            if (!llm?.stream) {
              writeJson(res, 503, fail(503, "no-llm", "llm service unavailable"));
              return;
            }

            const sessionId = sctx.sessions?.current?.()?.id ?? undefined;
            const target = await resolveTarget(sctx, sessionId);
            if (!target) {
              writeJson(res, 503, fail(503, "no-route", "cannot resolve a provider/model: no routed request and no selection"));
              return;
            }

            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), timeoutMs);
            let raw = "";
            try {
              const stream = llm.stream({
                provider: target.provider,
                model: target.model,
                messages: [{ role: "user", content: [{ type: "text", text: userPrompt(checked.text) }] }],
                system: SYSTEM_PROMPT,
                maxTokens: MAX_TOKENS,
                ...sessionId === undefined ? {} : { sessionId },
                signal: abort.signal,
              });
              for await (const chunk of stream) {
                if (chunk?.type === "text-delta") raw += chunk.text ?? "";
              }
            } catch (err) {
              writeJson(res, 502, fail(502, "llm-error", String(err?.message ?? err)));
              return;
            } finally {
              clearTimeout(timer);
            }

            const text = normalizePromptify(raw);
            if (text === "") {
              writeJson(res, 502, fail(502, "empty-response", "model returned no text"));
              return;
            }
            writeJson(res, 200, { ok: true, value: { text } });
          },
        },
        name,
      );
      return () => dispose();
    }, name + ": route");
  });
}
