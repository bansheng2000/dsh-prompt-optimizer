import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

import { SYSTEM_PROMPT, userPrompt, checkSource, checkRequest, normalizePromptify, pickModel, pickSessionId, pickFollow, fail, redactMessage } from "./optimize.js";

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
/**
 * 插件详情页「模型」设置的读写路由（全局设置：跟随会话模型 / 指定模型）。
 * 与改写路由分开：写一条设置不该占改写路由的并发/频率闸，也不该把 2MB 解析逻辑拖进来。
 */
const SETTINGS_ROUTE = "/prompt-optimizer/settings";
const MODEL_FILE = "prompt-optimizer-model.json";
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

/**
 * 全局模型设置（插件详情页里选的那个）的落盘位置：与台账同目录、同一条目录规则，
 * 文件名固定 prompt-optimizer-model.json，rules.modelFile 可显式覆盖（测试用）。
 * 内容 { model: { provider, model } | null }，null = 跟随会话模型。
 */
function modelFileFor(ctx, rules) {
  const override = typeof rules?.modelFile === "string" ? rules.modelFile.trim() : "";
  if (override !== "") return override;
  return join(dirname(storeFileFor(ctx, rules)), MODEL_FILE);
}

/** 读全局设置：文件不在/坏了/形状不对都当「跟随会话模型」，不许因此挂掉插件。 */
function loadModelPref(file) {
  try { return pickModel(JSON.parse(readFileSync(file, "utf8"))); } catch { return null; }
}

/** 写全局设置（先写 .tmp 再 rename）。写不进去要如实报错——静默吞掉等于用户改了却不知道没存上。 */
async function saveModelPref(file, pref) {
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    await writeFile(tmp, JSON.stringify({ model: pref }), "utf8");
    await rename(tmp, file);
    return true;
  } catch { return false; }
}

/** 只有进程内第一次 apply 读盘：重复读会让内存里更全的账倒退回磁盘上的旧快照。 */
let ledgerLoaded = false;

/** 单个计数项的上限：远超真实用量（一万亿次尝试）就说明文件不可信，夹住而不是照单全收。 */
const MAX_LEDGER_COUNT = 1e15;

function loadLedger(file) {
  if (ledgerLoaded) return;
  ledgerLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    // 上限（L4）：账本可能是手改过的/被截断的，1e308 这种数直接进面板就是一片噪声。
    const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), MAX_LEDGER_COUNT) : 0);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "requests", "attempts", "failed"]) {
      LEDGER[key] = num(raw?.[key]);
    }
    // since 也不能信：未来的时间戳会让悬停里的「累计至今（…起算）」显示成一个还没到的时间。
    LEDGER.since = Math.min(num(raw?.since), Date.now()) || Date.now();
  } catch { /* 首次运行或文件损坏：从零开始，不是错误 */ }
}

/**
 * 落盘（L1）。原来用 writeFileSync：一次几百字节，但每次点击（失败也写）都要在主进程
 * 事件循环上同步做完一次磁盘 I/O，同进程的其它请求只能干等。换成 promise 版之后语义
 * 不变 —— 调用点照样 await 到写完再回响应（账不会丢），等待期间事件循环能去处理别的。
 * 先写 .tmp 再 rename，避免半截文件被下次启动读成更小的账。
 * 写不进去（只读盘、目录被删）不影响改写，退回进程内累计。
 */
async function saveLedger(file) {
  try {
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    await writeFile(tmp, JSON.stringify(LEDGER), "utf8");
    await rename(tmp, file);
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

/** 台账快照：token 明细 + 费用（没配单价就是 null）+ 落盘文件名（M3：不外泄绝对路径，这条 GET 本机任意进程都能读）。 */
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
    storeName: basename(storeFile),
    price,
    priceSource: price === null ? null : "config.rules.price (DSH profile cordis.patch.yml)",
    cost: costOf(counts, price),
  };
}

/** 请求体字节上限：checkRequest 的 8000 字符闸在解析之后，这里挡的是「解析之前」的兜底。 */
const MAX_BODY_BYTES = 2_000_000;
/**
 * readJson 的「太大了」哨兵（L2）。以前是 req.destroy() + 当成解析失败：客户端只看到连接
 * 断掉，响应体还写着 400 bad-json（明明是尺寸问题，也不是 JSON 语法问题）。现在照实回 413。
 */
const TOO_BIG = Symbol("too-big");

function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    let tooBig = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (c) => {
      // 超限后继续把字节读走（客户端还在发，断连只会让它拿到网络错误），
      // 但不再往 raw 里堆 —— 上限的意义就是不把内存交给对方。
      if (done || tooBig) return;
      raw += c;
      if (raw.length > limit) { tooBig = true; raw = ""; }
    });
    req.on("error", () => finish(tooBig ? TOO_BIG : null));
    req.on("end", () => {
      if (done) return;
      if (tooBig) { finish(TOO_BIG); return; }
      try { finish(JSON.parse(raw || "{}")); } catch { finish(null); }
    });
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    // L9：GET 会回带用量台账（token/费用），别让它落在浏览器或中间代理的缓存里。
    "cache-control": "no-store",
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
async function buildCatalog(sctx) {
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

/**
 * 目录缓存（M3）：这条路由本机任意进程都能直接打，而目录要逐个 provider 问宿主 ——
 * 高频轮询会变成 N 倍扇出。默认 60s 内共用一次结果，并发也共用同一个 promise。
 * cache 由 apply() 持有（每次注册一份），ttlMs = 0 即不缓存（测试与排障用）。
 * 代价：新装的 provider/model 最多 60s 后才出现在下拉框，改写本身不受影响。
 */
const CATALOG_TTL_MS = 60_000;

async function listCatalogCached(cache, sctx, ttlMs) {
  if (ttlMs > 0 && cache.value !== null && Date.now() - cache.at < ttlMs) return cache.value;
  if (cache.promise !== null) return cache.promise;
  cache.promise = buildCatalog(sctx).then(
    (value) => { cache.value = value; cache.at = Date.now(); cache.promise = null; return value; },
    (err) => { cache.promise = null; throw err; },
  );
  return cache.promise;
}

export function apply(ctx, config) {
  const rules = config?.rules ?? {};
  const maxInputChars = rules.maxInputChars > 0 ? rules.maxInputChars : MAX_INPUT_CHARS;
  const timeoutMs = rules.timeoutMs > 0 ? rules.timeoutMs : TIMEOUT_MS;
  const maxTokens = rules.maxTokens > 0 ? rules.maxTokens : MAX_TOKENS;
  const minIntervalMs = Number.isFinite(rules.minIntervalMs) && rules.minIntervalMs >= 0 ? rules.minIntervalMs : MIN_INTERVAL_MS;
  const catalogTtlMs = Number.isFinite(rules.catalogTtlMs) && rules.catalogTtlMs >= 0 ? rules.catalogTtlMs : CATALOG_TTL_MS;
  const catalogCache = { at: 0, value: null, promise: null };
  // M1 闸门状态：inflight 与「上一次起手时刻」。每个 apply 一份（正常只有一个 profile 挂一次）。
  let inflight = 0;
  let inflightAt = 0;
  let lastStart = Number.NEGATIVE_INFINITY;
  // 单价在 apply() 时读一次：改 cordis.patch.yml 要重启 DSH 才生效（bundle 配置本来就是启动期加载）。
  const price = readPrice(rules);
  // 台账：位置在这一刻定下来（profile 目录），再把上一轮进程留下的账读回来。
  const storeFile = storeFileFor(ctx, rules);
  loadLedger(storeFile);
  // 全局模型设置：启动时读一次，详情页保存时更新内存（不做 TTL —— 单用户本机插件，
  // 多读几次文件比猜缓存新鲜度便宜）。
  const modelFile = modelFileFor(ctx, rules);
  const modelPref = { value: loadModelPref(modelFile) };

  /**
   * 插件详情页的「模型」设置（全局）：GET 读、POST 写。
   * 只认 { model: {provider, model} | null }，null/残缺一律当「跟随会话模型」；
   * 保存失败回 500（不许假装存上了——用户下次打开会看到设置没生效却不知道为什么）。
   * 请求体走同一个 2MB 上限与来源闸：这条路由同样不在宿主的浏览器鉴权墙后面。
   */
  async function settingsHandler(req, res) {
    const rejected = checkSource(req.headers, req.method);
    if (rejected) {
      writeJson(res, rejected.status, rejected);
      return;
    }
    if (req.method === "GET") {
      writeJson(res, 200, { ok: true, value: { model: modelPref.value } });
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, fail(405, "method", "use GET to read or POST to save the model setting"));
      return;
    }
    const body = await readJson(req, 64 * 1024);
    if (body === TOO_BIG) {
      writeJson(res, 413, fail(413, "too-large", "request body is too large for a setting"));
      return;
    }
    if (body === null) {
      writeJson(res, 400, fail(400, "bad-json", "request body is not valid JSON"));
      return;
    }
    const next = pickModel(body);
    if (!await saveModelPref(modelFile, next)) {
      writeJson(res, 500, fail(500, "save-failed", "cannot write the model setting file"));
      return;
    }
    modelPref.value = next;
    writeJson(res, 200, { ok: true, value: { model: next } });
  }

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
              // 目录 + 用量台账 + 全局模型设置：GET 同时也是人工核对 token/费用的通道。
              // model 让聊天页面板在「本页还没选过」时落到详情页配的那个模型上。
              writeJson(res, 200, { ok: true, value: { ...await listCatalogCached(catalogCache, sctx, catalogTtlMs), model: modelPref.value, usage: usageSnapshot(price, storeFile) } });
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
            if (body === TOO_BIG) {
              done(413, fail(413, "too-large", "request body is larger than 2MB"));
              return;
            }
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
            // L8：优先用客户端报上来的会话 id —— sessions.current() 是「全局当前会话」，
            // 多开会话时按钮所在的会话未必是它，按别人的会话模型改写就错了。
            const sessionId = pickSessionId(body) || sctx.sessions?.current?.()?.id || FALLBACK_SESSION_ID;
            // 模型优先级（用户 2026-10 要求）：聊天页里选的模型 > 插件详情页的全局设置 > 会话当前模型。
            // 聊天页面板把「跟随会话模型」显式报成 follow:true —— 这一态必须跳过全局设置，
            // 否则用户在聊天页选了跟随却被详情页的设置抢走，「聊天页设置优先级最高」就名存实亡。
            // 两者都没有（老客户端 / 直接 curl）才用全局设置兜底，行为对旧客户端不变。
            let target = pickModel(body);
            if (!target && !pickFollow(body)) target = modelPref.value;
            if (!target) target = await resolveTarget(sctx, sessionId);
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
              await saveLedger(storeFile);
              done(200, { ok: true, value: { text, model: target, usage: usageSnapshot(price, storeFile) } });
              return;
            }
            LEDGER.failed += 1;
            await saveLedger(storeFile);

            // 空响应必须带上真实原因：把 finish 块里的 failure 透给客户端，
            // 否则「模型没吐正文」和「上游 429/超时/模型不存在」长得一模一样。
            const kind = reason?.kind ?? null;
            const code = reason?.failure?.code ?? (kind === "max-tokens" ? "max-tokens" : kind === "aborted" ? "timeout" : thrown ? "llm-error" : "empty-response");
            const fullMessage = reason?.failure?.message
              ?? (thrown ? String(thrown?.message ?? thrown)
                : kind === "max-tokens" ? `model spent the whole ${maxTokens}-token budget on reasoning and returned no text`
                : kind === "aborted" ? `no answer within ${Math.round(timeoutMs / 1000)}s`
                : "model returned no text");
            // M2：原文只进宿主日志（要查真因时看终端），面板与响应拿脱敏过的短句。
            console.warn("[prompt-optimizer] 改写失败原文：", fullMessage);
            done(502, fail(502, code, redactMessage(fullMessage)));
          },
        },
        name,
      );
      // 插件详情页「模型」设置的独立小路由：GET 回当前设置，POST 保存。
      const disposeSettings = sctx.webServer.register(
        { kind: "exact", path: SETTINGS_ROUTE, handler: settingsHandler },
        name,
      );
      return () => {
        dispose();
        disposeSettings();
      };
    }, name + ": route");
  });
}
