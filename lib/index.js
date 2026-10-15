import { SYSTEM_PROMPT, userPrompt, checkRequest, normalizePromptify, pickModel, fail } from "./optimize.js";

/**
 * dsh-prompt-optimizer 宿主侧：一条 HTTP 路由，两个方法。
 *   GET  → 模型目录（客户端"选哪个模型"的下拉框）
 *   POST {text, model?} → 改写后的提示词；model 缺省即跟随会话当前模型。
 *
 * 契约（asar 实证）：
 * - ctx.llm.stream({provider, model, messages, maxTokens, sessionId, signal}) 逐分片 yield，
 *   顺手用 @deepseek-ai/dsh-llm 的 BlockAssembler 收块（dsh-compaction 的 summarizer 同款用法）。
 * - messages 接受 request-only 输入：{role:"user", content:[{type:"text", text}]}，无需 id/source。
 * - 目标解析照 compaction summarizer：session.requestHeader()?.config → agent.options → 全局默认。
 * - 路由路径必须以 "/" 开头：宿主 WebServer.match() 用 pathname 查 exact 表，
 *   无前导斜杠的 key 永远匹配不上（点按钮会静默无反应）。
 * - 模型目录不 import 宿主的 buildModelCatalog（它在 app.asar 打包产物里，
 *   没有对外的包路径），这里按同样的 {default, groups, routableProviders} 形状
 *   用 ctx.llm 自己拼一遍；只取客户端下拉框要的 id/name，不带 reasoning 档位。
 */

const name = "dsh-prompt-optimizer";
const inject = [];

export { name };

/** 前导斜杠是宿主 match() 的硬要求（asar @51695741）。 */
const ROUTE = "/prompt-optimizer/api";
const MAX_INPUT_CHARS = 8000;
const TIMEOUT_MS = 60000;
/**
 * 输出预算。deepseek-v4.1-flash 这类推理模型会先把预算花在 reasoning_content 上：
 * 同一份 system+user 直连 opencode-go 实测，max_tokens=1024 → finish_reason=length、
 * reasoning 3329 字、正文 0 字（宿主于是收不到任何 text-delta，只能报 empty-response）；
 * 4096 → finish_reason=stop、正文 1327 字。别再往下调，改这里要走 rules.maxTokens。
 */
const MAX_TOKENS = 4096;
/** 空流/适配器失败重试一次：用户现在的土办法就是「再点一下」。 */
const ATTEMPTS = 2;

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

/**
 * 跑一次改写，把「流为什么是空的」的真相取回来。
 * 宿主 llm.stream 的适配器失败**不抛异常**：dsh-llm 的 adapterStream 会把选择/派发/迭代
 * 失败一律折成终止块 {type:"finish", reason:{kind, failure:{message, code}}}（kind 取
 * stop | tool-calls | max-tokens | aborted | error）。只认 text-delta 的话，超时、429、
 * 400、推理模型把预算吃光……全都被显示成同一句「model returned no text」。
 */
async function runOnce(llm, target, text, sessionId, maxTokens, signal) {
  let raw = "";
  let reason = null;
  for await (const chunk of llm.stream({
    provider: target.provider,
    model: target.model,
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt(text) }] }],
    system: SYSTEM_PROMPT,
    maxTokens,
    ...sessionId === undefined ? {} : { sessionId },
    signal,
  })) {
    if (chunk?.type === "text-delta") { raw += chunk.text ?? ""; continue; }
    if (chunk?.type === "finish") reason = chunk.reason ?? null;
  }
  return { raw, reason };
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

/**
 * 列出可路由的 provider/model，供客户端"选哪个模型"用。
 * 形状照宿主 buildModelCatalog（asar @16150294）精简到 id/name。
 * 单个 provider 拉失败只跳过它，不让整份目录挂掉。
 */
async function listCatalog(sctx) {
  const groups = [];
  // llm 没注入或拉不到就交一份空目录：客户端下拉框退回「跟随会话模型」，不影响改写。
  let providers = [];
  try { providers = (await sctx.llm?.listProviders?.()) ?? []; } catch { providers = []; }
  for (const provider of providers) {
    try {
      const models = await sctx.llm.listModels(provider.id);
      const entries = models.map((m) => ({ id: m.id, name: m.name }));
      if (entries.length > 0) groups.push({ id: provider.id, name: provider.name, models: entries });
    } catch { /* 拉不到就当这个 provider 不可用 */ }
  }
  let fallback = null;
  try { fallback = sctx.agentDefaultModel?.currentSelection?.() ?? null; } catch { /* ignore */ }
  return {
    default: fallback === null ? null : { provider: fallback.provider, model: fallback.model },
    routableProviders: groups.map((g) => g.id),
    groups,
  };
}

export function apply(ctx, config) {
  const rules = config?.rules ?? {};
  const maxInputChars = rules.maxInputChars > 0 ? rules.maxInputChars : MAX_INPUT_CHARS;
  const timeoutMs = rules.timeoutMs > 0 ? rules.timeoutMs : TIMEOUT_MS;
  const maxTokens = rules.maxTokens > 0 ? rules.maxTokens : MAX_TOKENS;

  ctx.inject(["webServer", "llm", "agentDefaultModel", "agents", "sessions"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.webServer.register(
        {
          kind: "exact",
          path: ROUTE,
          handler: async (req, res) => {
            if (req.method === "GET") {
              writeJson(res, 200, { ok: true, value: await listCatalog(sctx) });
              return;
            }
            if (req.method !== "POST") {
              writeJson(res, 405, fail(405, "method", "use GET for the model catalog or POST to optimize"));
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

            const sessionId = sctx.sessions?.current?.()?.id ?? undefined; // ponytail: current() 未实证，取不到就退回全局默认模型
            // 客户端显式选了模型就用它；没选（或残缺）就跟随会话当前模型。
            const target = pickModel(body) ?? await resolveTarget(sctx, sessionId);
            if (!target) {
              writeJson(res, 503, fail(503, "no-route", "cannot resolve a provider/model: no routed request and no selection"));
              return;
            }

            const startedAt = Date.now();
            let raw = "";
            let reason = null;
            let thrown = null;
            for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
              const abort = new AbortController();
              const timer = setTimeout(() => abort.abort(), timeoutMs);
              try {
                ({ raw, reason } = await runOnce(llm, target, checked.text, sessionId, maxTokens, abort.signal));
                thrown = null;
              } catch (err) {
                raw = "";
                reason = null;
                thrown = err;
              } finally {
                clearTimeout(timer);
              }
              if (normalizePromptify(raw) !== "") break;
              // 超时、或者第一次就把时间花掉大半，就别再赌第二次：客户端那边还等着同一个响应。
              if (abort.signal.aborted || Date.now() - startedAt > timeoutMs / 2) break;
            }

            const text = normalizePromptify(raw);
            if (text !== "") {
              writeJson(res, 200, { ok: true, value: { text, model: target } });
              return;
            }

            // 空响应必须带上真实原因：把 finish 块里的 failure 透给客户端，
            // 否则「模型没吐正文」和「上游 429/超时/模型不存在」长得一模一样。
            const kind = reason?.kind ?? null;
            const code = reason?.failure?.code ?? (kind === "max-tokens" ? "max-tokens" : kind === "aborted" ? "timeout" : thrown ? "llm-error" : "empty-response");
            const message = reason?.failure?.message
              ?? (thrown ? String(thrown?.message ?? thrown)
                : kind === "max-tokens" ? `model spent the whole ${maxTokens}-token budget on reasoning and returned no text`
                : kind === "aborted" ? `no answer within ${Math.round(timeoutMs / 1000)}s`
                : "model returned no text");
            writeJson(res, 502, fail(502, code, message));
          },
        },
        name,
      );
      return () => dispose();
    }, name + ": route");
  });
}
