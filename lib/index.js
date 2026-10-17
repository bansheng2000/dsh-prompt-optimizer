import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { SYSTEM_PROMPT, userPrompt, checkSource, checkRequest, normalizePromptify, pickModel, fail } from "./optimize.js";

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
/**
 * 并发/频率闸（M1）。这条路由本机任意进程都能直接打，也没有排队：
 * 并行几十条 POST 会各自占一个 60s 窗口、各烧 4096 输出 token，把额度和事件循环一起吃掉。
 * 两个数留在进程内单值就够 —— 这是本机单用户插件，不是要扛分布式洪峰的网关。
 * rules.minIntervalMs 可覆盖（0 = 关掉限速，自测用）。
 */
const MAX_INFLIGHT = 2;
const MIN_INTERVAL_MS = 800;
/**
 * 兜底 routing 键。pi-ai 的 opencode 适配器只在 options.sessionId 非空时才补
 * x-opencode-session 头（@earendil-works/pi-ai/dist/providers/opencode-headers.js 的
 * withSessionHeader：!options?.sessionId 就直接原样返回 options），缺这个头上游回
 * 400 MissingSessionID。dsh-llm-pi-ai 用 String(options.sessionId) 原样透传，所以
 * 非空字符串即可，不必是真会话；宿主 agents.get(未知 id) 返回 undefined，不会抛。
 * ponytail: 取不到真会话 id 时全部优化请求共用一个 routing 桶 —— 亲和性对本插件
 * 没意义（每请求都是全新一次性对话）。要按会话分账再说。
 */
const FALLBACK_SESSION_ID = "prompt-optimizer";

/**
 * 用量台账（用户 2026-10 需求：统计累计 token，能算才算费用）。
 *
 * 统计范围：**本插件自己发起的改写请求**，**跨重启累计**（用户 2026-10 要求「改成一直统计」）：
 *   每次改写收尾把 LEDGER 落盘到 DSH profile 的 prompt-optimizer-usage.json，下次启动读回；
 *   进程内只有第一次 apply 读盘（见 ledgerLoaded），重挂载不会把内存里的账倒回旧文件。
 *   展示时带上 since（第一笔账的时刻）、scope:"persistent" 与 store（落盘路径）；
 *   GET /prompt-optimizer/api 也回带这份快照，便于人工核对。
 *   ponytail: 单文件全量重写（一次几百字节、一次点击才写一回）；要留历史/多机合并再换 JSONL。
 * 口径（与宿主 TokenUsage 对齐，asar 实测 dsh-llm 的 DeepSeek provider：
 *   usage.totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens）：
 *   input = 非缓存输入、output = 输出、cacheRead/cacheWrite 单列，合计 = 四项之和。
 *   展示时输入/输出/合计分开写，不合并成一个含糊的「token 数」。
 *   attempts 记「尝试」次数（含失败与空响应重试），requests 记成功返回正文的次数，
 *   failed 记最终 502 的次数 —— 三者不相等时说明账里混着白花的钱。
 */
const LEDGER = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  requests: 0, attempts: 0, failed: 0,
  since: Date.now(),
};

const LEDGER_FILE = "prompt-optimizer-usage.json";

/**
 * 台账落盘位置，优先级：
 *   1) config.rules.storeFile —— 显式覆盖（测试、多实例并存用）
 *   2) DSH profile 目录 —— 宿主把 {name, dir, patchPath} 发布在 profileContext 服务上
 *   3) ~/.dsh —— 没有该服务的旧宿主兜底
 * 每个 profile 一本账，且不放在 node_modules 里（pnpm 重装插件目录不会带走它）。
 */
function storeFileFor(ctx, rules) {
  const override = typeof rules?.storeFile === "string" ? rules.storeFile.trim() : "";
  if (override !== "") return override;
  let dir = "";
  try { dir = ctx.get?.("profileContext")?.dir ?? ""; } catch { /* 旧宿主没这个服务 */ }
  return join(typeof dir === "string" && dir !== "" ? dir : join(homedir(), ".dsh"), LEDGER_FILE);
}

/** 只有进程内第一次 apply 读盘：重复读会让内存里更全的账倒退回磁盘上的旧快照。 */
let ledgerLoaded = false;

function loadLedger(file) {
  if (ledgerLoaded) return;
  ledgerLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "requests", "attempts", "failed"]) {
      LEDGER[key] = num(raw?.[key]);
    }
    LEDGER.since = num(raw?.since) || Date.now();
  } catch { /* 首次运行或文件损坏：从零开始，不是错误 */ }
}

/**
 * 同步落盘。一次几百字节、一次点击才写一回，不值得上防抖/异步队列；
 * 先写 .tmp 再 rename，避免半截文件被下次启动读成更小的账。
 * 写不进去（只读盘、目录被删）不影响改写，退回进程内累计。
 */
function saveLedger(file) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(LEDGER), "utf8");
    renameSync(tmp, file);
  } catch { /* ignore */ }
}

/** 把宿主 usage 块摊平成四个计数（兼容 TokenUsage 与 pi-ai Usage 两种字段名）。 */
function toCounts(usage) {
  if (!usage || typeof usage !== "object") return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const counts = {
    input: num(usage.inputTokens ?? usage.input),
    output: num(usage.outputTokens ?? usage.output),
    cacheRead: num(usage.cacheReadTokens ?? usage.cacheRead),
    cacheWrite: num(usage.cacheWriteTokens ?? usage.cacheWrite),
  };
  counts.total = num(usage.totalTokens ?? usage.total) || counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
  return counts;
}

function addCounts(counts) {
  if (!counts) return;
  LEDGER.input += counts.input;
  LEDGER.output += counts.output;
  LEDGER.cacheRead += counts.cacheRead;
  LEDGER.cacheWrite += counts.cacheWrite;
}

/**
 * 单价来源：**只读配置**，代码里没有任何价格常量。
 * 配置位置是 DSH profile 的 cordis.patch.yml（prompt-optimizer 条目的覆盖层）：
 *   prompt-optimizer:
 *     rules:
 *       price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3, currency: CNY }
 * 单位是「currency / 百万 token」，与 pi-ai 的 Model.cost 同口径（那边也是每百万）。
 * 缺字段按 0 算；一个数都没有（或压根没配）→ 返回 null，此时台账 cost 也是 null，
 * 界面上只显示 token —— 不猜价，编造的单价比没有更糟。
 */
function readPrice(rules) {
  const raw = rules?.price;
  if (!raw || typeof raw !== "object") return null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const parts = { input: num(raw.input), output: num(raw.output), cacheRead: num(raw.cacheRead), cacheWrite: num(raw.cacheWrite) };
  if (parts.input === null && parts.output === null && parts.cacheRead === null && parts.cacheWrite === null) return null;
  return {
    input: parts.input ?? 0, output: parts.output ?? 0, cacheRead: parts.cacheRead ?? 0, cacheWrite: parts.cacheWrite ?? 0,
    currency: typeof raw.currency === "string" ? raw.currency.trim() : "",
  };
}

const PER_MILLION = 1_000_000;

function costOf(counts, price) {
  if (price === null) return null;
  const cost = {
    input: (counts.input / PER_MILLION) * price.input,
    output: (counts.output / PER_MILLION) * price.output,
    cacheRead: (counts.cacheRead / PER_MILLION) * price.cacheRead,
    cacheWrite: (counts.cacheWrite / PER_MILLION) * price.cacheWrite,
    currency: price.currency,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return cost;
}

/** 台账快照：token 明细 + 费用（没配单价就是 null）+ 落盘位置。 */
function usageSnapshot(price, storeFile) {
  const counts = { input: LEDGER.input, output: LEDGER.output, cacheRead: LEDGER.cacheRead, cacheWrite: LEDGER.cacheWrite };
  counts.total = counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
  return {
    ...counts,
    requests: LEDGER.requests,
    attempts: LEDGER.attempts,
    failed: LEDGER.failed,
    since: LEDGER.since,
    scope: "persistent",
    store: storeFile,
    price,
    priceSource: price === null ? null : "config.rules.price (DSH profile cordis.patch.yml)",
    cost: costOf(counts, price),
  };
}

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
 * 顺手把 usage 块取回来喂台账（每次尝试各一份，重试就各算各的）。
 */
async function runOnce(llm, target, text, sessionId, maxTokens, signal) {
  let raw = "";
  let reason = null;
  let usage = null;
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
    if (chunk?.type === "usage") { usage = toCounts(chunk.usage) ?? usage; continue; }
    if (chunk?.type === "finish") reason = chunk.reason ?? null;
  }
  return { raw, reason, usage };
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
  const minIntervalMs = Number.isFinite(rules.minIntervalMs) && rules.minIntervalMs >= 0 ? rules.minIntervalMs : MIN_INTERVAL_MS;
  // M1 闸门状态：inflight 与「上一次起手时刻」。每个 apply 一份（正常只有一个 profile 挂一次）。
  let inflight = 0;
  let inflightAt = 0;
  let lastStart = Number.NEGATIVE_INFINITY;
  // 单价在 apply() 时读一次：改 cordis.patch.yml 要重启 DSH 才生效（bundle 配置本来就是启动期加载）。
  const price = readPrice(rules);
  // 台账：位置在这一刻定下来（profile 目录），再把上一轮进程留下的账读回来。
  const storeFile = storeFileFor(ctx, rules);
  loadLedger(storeFile);

  ctx.inject(["webServer", "llm", "agentDefaultModel", "agents", "sessions"], (sctx) => {
    sctx.effect(() => {
      const dispose = sctx.webServer.register(
        {
          kind: "exact",
          path: ROUTE,
          handler: async (req, res) => {
            // H1：本路由不在宿主给 /api/* 的鉴权墙后面（实测同进程 /api/dsh-im/... 回 401，
            // 本路由无 cookie 也 200），所以自己判来源——否则任何网页的 no-cors 简单请求
            // 都能触发一次真实模型调用（烧额度）。判定与用例见 optimize.js 的 checkSource。
            const rejected = checkSource(req.headers, req.method);
            if (rejected) {
              writeJson(res, rejected.status, rejected);
              return;
            }
            if (req.method === "GET") {
              // 目录 + 用量台账：GET 同时也是人工核对 token/费用的通道。
              writeJson(res, 200, { ok: true, value: { ...await listCatalog(sctx), usage: usageSnapshot(price, storeFile) } });
              return;
            }
            if (req.method !== "POST") {
              writeJson(res, 405, fail(405, "method", "use GET for the model catalog or POST to optimize"));
              return;
            }

            // M1：并发/频率闸。GET 是只读目录、不花额度，闸门只罩 POST。
            const now = Date.now();
            // 兜底自愈：正常出口都会走 done() 释放，万一 handle 抛异常越过出口，
            // 最多占住 timeoutMs+10s 就自动放开——不然一次抛错会把插件永久锁成 429。
            if (inflight > 0 && now - inflightAt > timeoutMs + 10_000) inflight = 0;
            if (inflight >= MAX_INFLIGHT || now - lastStart < minIntervalMs) {
              writeJson(res, 429, fail(429, "busy",
                inflight > 0 ? "上一条还在改写中，等它出结果再点" : `点得太快，请 ${minIntervalMs / 1000}s 后再试`));
              return;
            }
            inflight += 1;
            inflightAt = now;
            lastStart = now;
            // 每个出口都要走 done()，否则额度不会释放（自测里连打几十次会立刻暴露漏出口）。
            const done = (status, body) => {
              inflight -= 1;
              writeJson(res, status, body);
            };

            const body = await readJson(req);
            if (body === null) {
              done(400, fail(400, "bad-json", "request body is not valid JSON"));
              return;
            }

            const checked = checkRequest(body, maxInputChars);
            if (!checked.ok) {
              done(checked.status, checked);
              return;
            }

            const llm = sctx.llm;
            if (!llm?.stream) {
              done(503, fail(503, "no-llm", "llm service unavailable"));
              return;
            }

            // 会话 id 同时喂给 llm.stream（openCode 系 provider 靠它补 x-opencode-session 头）
            // 和 resolveTarget（按会话模型路由）。真 id 拿不到也不能留空，见 FALLBACK_SESSION_ID。
            const sessionId = sctx.sessions?.current?.()?.id || FALLBACK_SESSION_ID;
            // 客户端显式选了模型就用它；没选（或残缺）就跟随会话当前模型。
            const target = pickModel(body) ?? await resolveTarget(sctx, sessionId);
            if (!target) {
              done(503, fail(503, "no-route", "cannot resolve a provider/model: no routed request and no selection"));
              return;
            }

            const startedAt = Date.now();
            let raw = "";
            let reason = null;
            let thrown = null;
            for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
              const abort = new AbortController();
              const timer = setTimeout(() => abort.abort(), timeoutMs);
              // 每次「尝试」都记一笔：失败和空响应重试也各是一次真实调用，各自带自己的 usage。
              LEDGER.attempts += 1;
              try {
                let used = null;
                ({ raw, reason, usage: used } = await runOnce(llm, target, checked.text, sessionId, maxTokens, abort.signal));
                addCounts(used);
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
              LEDGER.requests += 1;
              saveLedger(storeFile);
              done(200, { ok: true, value: { text, model: target, usage: usageSnapshot(price, storeFile) } });
              return;
            }
            LEDGER.failed += 1;
            saveLedger(storeFile);

            // 空响应必须带上真实原因：把 finish 块里的 failure 透给客户端，
            // 否则「模型没吐正文」和「上游 429/超时/模型不存在」长得一模一样。
            const kind = reason?.kind ?? null;
            const code = reason?.failure?.code ?? (kind === "max-tokens" ? "max-tokens" : kind === "aborted" ? "timeout" : thrown ? "llm-error" : "empty-response");
            const message = reason?.failure?.message
              ?? (thrown ? String(thrown?.message ?? thrown)
                : kind === "max-tokens" ? `model spent the whole ${maxTokens}-token budget on reasoning and returned no text`
                : kind === "aborted" ? `no answer within ${Math.round(timeoutMs / 1000)}s`
                : "model returned no text");
            done(502, fail(502, code, message));
          },
        },
        name,
      );
      return () => dispose();
    }, name + ": route");
  });
}
