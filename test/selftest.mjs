// 自测：不连宿主，只验纯逻辑 + insertText 的冲突分支语义（照宿主复刻的最小形状）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

// --- client 包的模块面（window.__ModuleLoader__ 按 factory 的返回值取 exports.apply）---
// 少写 `var exports = module.exports` + `return exports` 时工厂在 ES 模块作用域里直接

// --- client 包：模块面 + 真的读草稿 ---
// 1) 模块面：window.__ModuleLoader__ 按 factory 的返回值取 exports.apply。少写
//    `var exports = module.exports` + `return exports` 就抛 ReferenceError，整块 bundle 永不激活。
// 2) props 必须真的传进组件：曾经的 bug 是 slots.register(..., () => OptimizeButton())，
//    无参调用把 props 丢掉，useInput 恒 undefined，于是每次点击都报「输入框是空的」。
const vm = await import("node:vm");
const clientSrc = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
let lastFetch = undefined;
const fakeFetch = async (url, init) => {
  lastFetch = { url: String(url), init };
  return { status: 200, json: async () => ({ ok: true, value: { text: "改写结果" } }) };
};
const h = (type, props, ...kids) => ({ type, props: props || {}, kids });
// 组件只有两个状态：一个 boolean（busy）、一个字符串（err），按初值类型命名即可。
const uiState = { busy: false, err: "" };
const fakeReact = {
  createElement: h,
  useState: (init) => [uiState[typeof init === "boolean" ? "busy" : "err"], (v) => { uiState[typeof init === "boolean" ? "busy" : "err"] = v; }],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
};
let registration;
const fakeDocument = {
  baseURI: "http://127.0.0.1:19387/",
  createElement: () => ({ setAttribute() {}, remove() {} }),
  head: { appendChild() {} },
};
vm.runInNewContext(clientSrc, {
  window: { __ModuleLoader__: { load: (r) => { registration = r; } } },
  document: fakeDocument,
  URL,
  console,
  clearTimeout,
  setTimeout,
  fetch: fakeFetch,
});
assert.equal(registration.id, "dsh-prompt-optimizer");
const face = registration.factory((spec) => {
  assert.equal(spec, "react", "客户端只该向宿主模块表要 react");
  return fakeReact;
});
assert.equal(typeof face.apply, "function");
assert.equal(face.inject.join(","), "slots");
let registered;
face.apply({
  effect: (fn) => fn(),
  slots: { inject: (key, fn) => fn(), register: (options, Comp) => { registered = { options, Comp }; } },
});
assert.equal(typeof registered.Comp, "function", "slot 条目必须直接注册组件，不能是无参包装");
assert.equal(registered.options.id, "prompt-optimizer");
// 走一次真实点击：草稿非空 → 必须发请求；空草稿 → 不发。
const tree = registered.Comp({
  useInput: (sel) => sel({ draft: "帮我写个爬虫", draftRev: 3 }),
  inputActions: { captureInsertion: () => ({ start: 0, end: 6, draftRev: 3 }) },
});
const button = tree.kids.find((k) => k && k.type === "button");
assert.ok(button, "应当渲染出按钮");
// 提示文字排在按钮左边（DOM 顺序：文案在前，按钮在后）。
uiState.err = "改写失败：模型超时";
const treeWithErr = registered.Comp({ useInput: (sel) => sel({ draft: "x", draftRev: 1 }) });
const errKid = treeWithErr.kids.find((k) => k && k.props && k.props.className === "po-err");
assert.ok(errKid, "有错误时应当渲染提示");
assert.equal(errKid.kids[0], "改写失败：模型超时");
assert.ok(treeWithErr.kids.indexOf(errKid) < treeWithErr.kids.findIndex((k) => k && k.type === "button"),
  "提示应当显示在图标左边");
uiState.err = "";
// 空闲时按钮里是 dsh-image-gen 生成的内联图标（PNG data URI），不是文案。
const img = button.kids.find((k) => k && k.type === "img");
assert.ok(img, "按钮应当渲染图标");
assert.ok(img.props.src.startsWith("data:image/png;base64,iVBORw0KGgo"), "图标应是内联 PNG data URI");
assert.equal(img.props.src.length > 2000, true, "图标数据应真实存在，不是占位串");
// 数据 URI 必须真的解得出 PNG（图标是内联字节，不是字符串常量）。
const png = Buffer.from(img.props.src.slice("data:image/png;base64,".length), "base64");
assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "内联数据必须是真 PNG 头");
const w = png.readUInt32BE(16), hgt = png.readUInt32BE(20);
assert.equal(hgt, 40, "图标按 40px 高内联，交给 CSS 缩到 20px 渲染");
// 横幅必须保持源图 2500x1677 的 3:2 比例（用户要求「按比例缩小」）。
assert.ok(Math.abs(w / hgt - 2500 / 1677) < 0.01, `图标应保持 3:2，实际 ${w}x${hgt}`);
// CSS 只锁高度：宽度必须交给图片自身按比例算。
const iconCss = /\.po-icon \{([^}]*)\}/.exec(await readFile(new URL("../lib/client.js", import.meta.url), "utf8"))[1];
assert.ok(/height:\s*20px/.test(iconCss) && /width:\s*auto/.test(iconCss),
  "CSS 应只锁图标高度、宽度自适应，否则会被压变形");
await button.props.onClick();
assert.ok(lastFetch, "点击必须发请求");
assert.equal(JSON.parse(lastFetch.init.body).text, "帮我写个爬虫", "点击必须把草稿发给宿主路由");
assert.ok(lastFetch.url.endsWith("/prompt-optimizer/api"), "POST 到前缀本身，不是 /optimize");
const emptyTree = registered.Comp({ useInput: (sel) => sel({ draft: "   ", draftRev: 1 }) });
lastFetch = undefined;
await emptyTree.kids.find((k) => k && k.type === "button").props.onClick();
assert.equal(lastFetch, undefined, "空草稿不发请求");
// --- 宿主路由：客户端 POST 的是前缀本身（prompt-optimizer/api），不是 /optimize ---
// 契约照抄 WebServer.register 的 prefix 表：按 pathname 前缀匹配。
const { apply } = await import("../lib/index.js");
let route, dispose;
apply({ inject: (deps, fn) => fn({ effect: (fn2) => { dispose = fn2(); },
  webServer: { register: (r) => { route = r; return () => { route = undefined; }; } } }) }, {});
assert.equal(route.kind, "prefix");
assert.equal(route.path, "prompt-optimizer/api");
// 最小 req/res：req 是 data/end 事件源，res 收 writeHead + end。
function call(method, url, body) {
  return new Promise((resolve) => {
    const res = { status: 0, payload: undefined,
      writeHead(status) { this.status = status; },
      end(text) { this.payload = JSON.parse(text); resolve(this); } };
    const req = { method, url, headers: { host: "127.0.0.1:19387" },
      on(ev, fn) { this[ev] = fn; }, destroy() {} };
    route.handler(req, res).catch((e) => resolve({ status: 500, payload: { error: String(e) } }));
    // handler 是 async；只有走到 readJson 的请求才注册 data/end 监听器，
    // 提前 4xx/405 返回的请求没有，所以喂 body 要放下一轮并守卫。
    setTimeout(() => { if (typeof req.data === "function") { req.data(Buffer.from(body)); req.end(); } }, 0);
  });
}
const okRoute = await call("POST", "/prompt-optimizer/api", JSON.stringify({ text: "hi" }));
assert.equal(okRoute.status, 503, "路由/解析/校验都过了，才轮到 llm 不可用");
assert.equal(okRoute.payload.error.code, "no-llm");
const badText = await call("POST", "/prompt-optimizer/api", JSON.stringify({ text: 42 }));
assert.equal(badText.status, 400);
assert.equal(badText.payload.error.code, "bad-text");
const wrongSub = await call("POST", "/prompt-optimizer/api/optimize", JSON.stringify({ text: "hi" }));
assert.equal(wrongSub.status, 404, "前缀之后还有子路径才是 404");
const wrongMethod = await call("GET", "/prompt-optimizer/api", "");
assert.equal(wrongMethod.status, 405);

console.log("ok - lib/optimize.js self-test passed");
