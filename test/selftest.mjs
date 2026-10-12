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

const vm = await import("node:vm");
const clientSrc = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
const CATALOG = {
  ok: true,
  value: {
    default: { provider: "deepseek-official", model: "deepseek-chat" },
    routableProviders: ["deepseek-official"],
    groups: [{ id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-chat", name: "deepseek-chat" }, { id: "deepseek-reasoner", name: "deepseek-reasoner" }] }],
  },
};
const calls = [];
let catalogBroken = false; // 让 GET 目录失败，验证下拉框挂了也不影响改写
const fakeFetch = async (url, init) => {
  const method = init?.method ?? "GET";
  calls.push({ method, url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
  if (method === "GET") {
    if (catalogBroken) throw new Error("catalog offline");
    return { status: 200, json: async () => CATALOG };
  }
  return { status: 200, json: async () => ({ ok: true, value: { text: "改写结果" } }) };
};
const h = (type, props, ...kids) => ({ type, props: props || {}, kids });

// 状态槽要跨渲染留存：点击改的是 state，断言必须重渲染后才看得见新树。
// （先前只重渲染一次就断言，面板永远读不到——假红。）
// 假 React 的 state/ref 要跨渲染稳定：hook 调用顺序固定，所以用「每次渲染从 0 重新
// 计数 + 全局槽位数组」来还原 React 语义。点击改的是 state，断言必须再渲染一次才看得见新树。
const ui = { s: [], refs: [], cur: 0, refCur: 0 };
const fakeReact = {
  createElement: h,
  useState: (init) => {
    const i = ui.cur++;
    if (!(i in ui.s)) ui.s[i] = init;
    return [ui.s[i], (v) => { ui.s[i] = typeof v === "function" ? v(ui.s[i]) : v; }];
  },
  useEffect: () => {},
  useRef: (v) => {
    const i = ui.refCur++;
    if (!(i in ui.refs)) ui.refs[i] = { current: v };
    return ui.refs[i];
  },
  useCallback: (fn) => fn,
};
let registration;
let injectedStyle = null;
const fakeDocument = {
  baseURI: "http://127.0.0.1:19387/",
  createElement: () => (injectedStyle = { setAttribute() {}, remove() {}, textContent: "" }),
  head: { appendChild() {} },
};
const sandbox = { fetch: fakeFetch }; // 可换 fetch，用来模拟慢请求
vm.runInNewContext(clientSrc, {
  window: { __ModuleLoader__: { load: (r) => { registration = r; } } },
  document: fakeDocument,
  URL,
  console,
  clearTimeout: () => {},
  setTimeout: () => 0,
  get fetch() { return sandbox.fetch; },
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

// 宿主 useInput 是 materializeStandardBinding 生成的 React selector hook，只能在渲染期调。
// 之前的 bug：把它写在 onClick 的异步回调里 → 非渲染期调 hook 抛错 → 面板弹了但是空的、
// 目录 GET 也没发出去。这层守卫就是为那条回归留的（假 React 不查 hook 规则）。
let inRender = false;
const useInputOf = (state) => (sel) => {
  if (!inRender) throw new Error("useInput 只能在渲染期调用");
  return sel(state);
};
const INPUT = {
  useInput: useInputOf({ draft: "帮我写个爬虫", draftRev: 3 }),
  inputActions: { captureInsertion: () => ({ start: 0, end: 6, draftRev: 3 }), insertText: () => {} },
};
// render = 再渲染一次（state/ref 保留）；fresh = 开一个新场景（state 全清、请求记录全清）。
const render = (props = INPUT) => {
  ui.cur = 0;
  ui.refCur = 0;
  inRender = true;
  try {
    return registered.Comp(props);
  } finally {
    inRender = false;
  }
};
const fresh = (props = INPUT) => {
  ui.s.length = 0;
  ui.refs.length = 0;
  calls.length = 0;
  return render(props);
};
// 目录是 fire-and-forget：loadCatalog().then(setCat) 不在 await 链上，
// 断言下拉框之前得先把微任务排干，否则还在加载中。
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const panel = (tree) => tree.kids.find((k) => k && k.props && k.props.className === "po-panel");
const btn = (tree) => tree.kids.find((k) => k && k.type === "button").props;
const panelRows = (tree) => panel(tree).kids.filter((k) => k && k.props && k.props.className === "po-row");
const actBtn = (tree, label) =>
  panelRows(tree).flatMap((r) => r.kids)
    .find((k) => k && k.type === "button" && k.kids[0] === label);
const msgOf = (tree) => panelRows(tree).flatMap((r) => r.kids)
  .find((k) => k && k.props && k.props.className === "po-msg");

// --- 空闲态：只有按钮，没有面板 ---
{
  const tree = fresh({ useInput: INPUT.useInput });
  assert.equal(tree.props.className, "po-wrap", "组件根必须是 .po-wrap，CSS 以它为作用域根");
  assert.equal(panel(tree), undefined, "没点就不该有面板");
  const iconNode = tree.kids.find((k) => k && k.type === "button").kids.find((k) => k && k.type === "img");
  assert.ok(iconNode, "按钮应当渲染图标");
  assert.ok(iconNode.props.src.startsWith("data:image/png;base64,iVBORw0KGgo"), "图标应是内联 PNG data URI");
  assert.ok(iconNode.props.src.length > 2000, "图标数据应真实存在，不是占位串");
  const png = Buffer.from(iconNode.props.src.slice("data:image/png;base64,".length), "base64");
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "内联数据必须是真 PNG 头");
  const w = png.readUInt32BE(16), hgt = png.readUInt32BE(20);
  assert.equal(hgt, 40, "图标按 40px 高内联，交给 CSS 缩到 20px 渲染");
  assert.ok(Math.abs(w / hgt - 2500 / 1677) < 0.01, "图标应保持 3:2");
}

// --- 点一下：面板出现 + 真发请求 ---
{
  let t = fresh(INPUT);
  assert.equal(btn(t)["aria-expanded"], false);
  await btn(t).onClick();
  await flush();
  t = render(INPUT); // 重渲染：state 已变，面板这时才在树上
  assert.ok(panel(t), "点了就该有面板");
  const post = calls.filter((c) => c.method === "POST");
  assert.equal(post.length, 1, "点一次发一次 POST");
  assert.equal(post[0].body.text, "帮我写个爬虫", "请求体必须带当前草稿");
  assert.equal("model" in post[0].body, false, "默认跟随会话模型，请求体不该带 model");
  assert.ok(calls.some((c) => c.method === "GET"), "还要拉一次模型目录");
  const ta = panel(t).kids.find((k) => k && k.type === "textarea");
  assert.ok(ta, "面板里得有可编辑文本框（用户要的「聊天框」）");
  assert.equal(ta.props.value, "改写结果", "文本框里应当就是生成的提示词，可直接读可改");
  // 改文本框 → 状态更新
  ta.props.onChange({ target: { value: "我自己改的" } });
  assert.equal(ui.s[2], "我自己改的", "文本框改动要进 state");
}

// --- 「用这条」写回草稿 ---
{
  let inserted = null;
  const props = { useInput: INPUT.useInput, inputActions: {
    captureInsertion: () => ({ start: 0, end: 6, draftRev: 3 }),
    insertText: (txt) => { inserted = txt; },
  } };
  let t = fresh(props);
  await btn(t).onClick();
  await flush();
  t = render(props);
  actBtn(t, "用这条").props.onClick();
  assert.equal(inserted, "改写结果", "「用这条」必须写回输入框");
  t = render(props);
  assert.equal(panel(t), undefined, "写回后自动收起面板");
}

// --- 改完草稿可重新生成：以当下草稿为准 ---
{
  let draft = "帮我写个爬虫";
  const props = { useInput: useInputOf({ get draft() { return draft; }, draftRev: 3 }), inputActions: INPUT.inputActions };
  let t = fresh(props);
  await btn(t).onClick();
  await flush();
  t = render(props);
  draft = "改过的需求";
  t = render(props); // 宿主 store 变了会驱动重渲染，generate 的闭包随之拿到新草稿
  await actBtn(t, "重新生成").props.onClick();
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2, "重新生成再发一次 POST");
  assert.equal(posts[1].body.text, "改过的需求", "重新生成必须用当下草稿，而不是上次的文本");
}

// --- 选模型：带上 {provider, model} ---
{
  const props = { useInput: INPUT.useInput, inputActions: INPUT.inputActions };
  let t = fresh(props);
  await btn(t).onClick();
  await flush();
  await flush();
  t = render(props);
  const sel2 = panelRows(t).flatMap((r) => r.kids).find((k) => k && k.type === "select");
  assert.ok(sel2, "面板里得有模型下拉框");
  const opts = sel2.kids.filter((k) => k && k.type === "option");
  assert.equal(opts[0].kids[0], "跟随会话模型", "第一个选项必须是「跟随会话模型」");
  assert.ok(opts.length >= 3, "目录里每个模型都要有选项");
  assert.ok(opts.some((o) => o.props.value === "deepseek-official/deepseek-chat"), "选项值应是 provider/model");
  sel2.props.onChange({ target: { value: "deepseek-official/deepseek-reasoner" } });
  t = render(props); // 重渲染后重新取按钮，闭包里才有新的 open 状态
  await actBtn(t, "重新生成").props.onClick();
  const last = calls.filter((c) => c.method === "POST").at(-1);
  assert.deepEqual(last.body.model, { provider: "deepseek-official", model: "deepseek-reasoner" },
    "选了模型必须按 {provider, model} 发给宿主");
}

// --- 再点一次：收起面板，不再发请求 ---
{
  let t = fresh(INPUT);
  await btn(t).onClick();
  await flush();
  t = render(INPUT);
  calls.length = 0;
  await btn(t).onClick();
  await flush();
  assert.equal(calls.length, 0, "开着的时候再点是关闭，不该发请求");
  t = render(INPUT);
  assert.equal(panel(t), undefined, "再点应当收起面板");
}

// --- 空草稿：开面板但不发请求，且给提示 ---
{
  const props = { useInput: useInputOf({ draft: "   ", draftRev: 1 }) };
  let t = fresh(props);
  await btn(t).onClick();
  await flush();
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "空草稿不发 POST");
  t = render(props);
  assert.ok(panel(t), "空草稿也开面板，让人看见为什么没结果");
  assert.match(msgOf(t).kids[0], /空的/, "空草稿要说明原因");
}

// --- props 缺 inputActions：必须给提示，不能静默 ---
{
  const props = { useInput: INPUT.useInput };
  let t = fresh(props);
  await btn(t).onClick();
  await flush();
  t = render(props);
  actBtn(t, "用这条").props.onClick();
  t = render(props);
  assert.match(msgOf(t).kids[0], /手动复制/, "拿不到输入框接口要提示手动复制");
}

// --- 目录拿不到也不影响改写（下拉框退回「跟随会话模型」）---
{
  catalogBroken = true;
  let t = fresh(INPUT);
  await btn(t).onClick();
  await flush();
  await flush();
  t = render(INPUT);
  assert.equal(panel(t).kids.find((k) => k && k.type === "textarea").props.value, "改写结果",
    "拉不到模型目录也要照样出结果");
  const selEl = panelRows(t).flatMap((r) => r.kids).find((k) => k && k.type === "select");
  assert.equal(selEl.kids.filter((k) => k && k.type === "option").length, 1, "目录挂了只剩「跟随会话模型」一项");
  catalogBroken = false;
}

// --- 请求还在飞时再点：不能重复发（busy 守卫）---
{
  let release;
  const hold = new Promise((r) => { release = r; });
  const realFetch = fetch;
  void realFetch;
  const slowFetch = async (url, init) => {
    if ((init?.method ?? "GET") === "POST") {
      calls.push({ method: "POST", url: String(url), body: JSON.parse(init.body) });
      await hold;
      return { status: 200, json: async () => ({ ok: true, value: { text: "慢结果" } }) };
    }
    return fakeFetch(url, init);
  };
  sandbox.fetch = slowFetch;
  let t = fresh(INPUT);
  const first = btn(t).onClick();
  t = render(INPUT);
  await actBtn(t, "重新生成").props.onClick();
  assert.equal(calls.filter((c) => c.method === "POST").length, 1, "上一次还没回来，不该再发一次");
  // 生成中必须有可见状态：上一次用户报「点了没反应」就是既没文字也没进度
  assert.match(String(msgOf(t).kids[0] ?? ""), /生成中/, "请求在飞时面板要有可见提示");
  release();
  await first;
  sandbox.fetch = fakeFetch;
}

// --- 失败提示不能被「生成中」的清理顺手抹掉 ---
{
  sandbox.fetch = async (url, init) => {
    if ((init?.method ?? "GET") === "POST") {
      calls.push({ method: "POST", url: String(url) });
      return { status: 503, json: async () => ({ ok: false, error: { message: "模型不可用" } }) };
    }
    return fakeFetch(url, init);
  };
  let t = fresh(INPUT);
  await btn(t).onClick();
  await flush();
  t = render(INPUT);
  assert.match(String(msgOf(t).kids[0] ?? ""), /生成失败.*模型不可用/, "失败原因要留在面板上");
  sandbox.fetch = fakeFetch;
}
// --- CSS 断言（图标尺寸 + all:unset 保持不变）---
const styleCss = injectedStyle.textContent;
const iconCss = /\.po-icon \{([^}]*)\}/.exec(styleCss)[1];
const btnCss = /\.po-btn \{([^}]*)\}/.exec(styleCss)[1];
const btnDecl = btnCss.replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(/border:\s*none/.test(btnCss) && /background:\s*none/.test(btnCss),
  "按钮不得自带边框或底色，否则图标外会出现一圈框");
assert.ok(/(^|;)\s*all:\s*unset\s*;/.test(btnDecl), "按钮需 all:unset，避免宿主 button 样式再加回 padding/边框");
assert.ok(/height:\s*20px/.test(iconCss) && /width:\s*auto/.test(iconCss),
  "CSS 应只锁图标高度、宽度自适应，否则会被压变形");

// --- CSS 必须真的能命中 ---
// 曾经的 bug：所有规则写成 [data-plugin-css="po"] .po-icon，而 data-plugin-css 是打在
// <style> 标签自己身上的标记，根本不在按钮的祖先链里 → 规则全部失效，按钮露出浏览器
// 默认样式（2px outset 边框 + 6px padding），看起来就是"图标外面一直有个框"。
// 先剥注释再判定：注释里正解释着这件事，直接扫原文只会命中注释（本项目踩过两次）。
const bareCss = styleCss.replace(/\/\*[\s\S]*?\*\//g, "");
assert.ok(!/data-plugin-css/.test(bareCss), "CSS 不得用 data-plugin-css 做作用域（它在 <style> 自身上，不是祖先）");
const selectors = [...bareCss.matchAll(/(?:^|\})\s*([^{}]+?)\s*\{/g)].map((m) => m[1].trim());
assert.ok(selectors.length >= 10, `应有若干条规则，实际 ${selectors.length}`);
for (const sel of selectors) {
  assert.ok(sel.startsWith(".po-wrap"), `每条规则都要以真实祖先 .po-wrap 开头，否则静默失效：${sel}`);
}
// 面板必须绝对定位且不被裁：宿主 .RlGAzG_card 只有 box-sizing/圆角/阴影，没有 overflow:hidden，
// 所以挂在按钮旁的 .po-panel 能溢出到输入框上方。
assert.ok(/\.po-panel \{[\s\S]*?position:\s*absolute/.test(bareCss), "面板要绝对定位，否则会把输入框撑高");
const panelCss = /\.po-panel \{([^}]*)\}/.exec(bareCss)[1];
assert.ok(!/\btop:\s*\d/.test(panelCss), "面板要挂在图标上方（bottom），不是下方");
assert.ok(/bottom:\s*calc\(100%/.test(panelCss), "面板用 bottom:calc(100% + Npx) 贴到图标上沿");
assert.ok(/width:\s*min\(/.test(panelCss) && /100vw/.test(panelCss),
  "宽度必须按视口兜底，否则手机窄屏会出屏");
assert.ok(/max-height:[^;]*vh/.test(panelCss) && /overflow:\s*auto/.test(panelCss),
  "面板要限高可滚，矮屏才看得全");
assert.ok(/\.po-row \{[^}]*flex-wrap:\s*wrap/.test(bareCss), "面板行要能换行，否则窄屏挤不下");
assert.ok(/\.po-text \{[^}]*max-height:\s*40vh/.test(bareCss), "文本框也要限高，不能把面板撑出屏");
// token 拼错会静默失效（本项目曾连写 5 个不存在的 token）。只许用 asar 里实测存在的名字。
const KNOWN_TOKENS = new Set([
  "--dsw-alias-label-primary", "--dsw-alias-label-secondary", "--dsw-alias-state-error-primary",
  "--dsw-alias-state-business-primary", "--dsw-alias-border-l1", "--dsw-alias-bg-layer-1",
  "--dsw-alias-interactive-bg-hover", "--dsw-radius-sm", "--dsw-radius-panel",
  "--dsw-elevation-panel", "--dsw-specific-input-major", "--dsw-font-family",
  "--dsw-font-xs-13", "--dsw-font-xxs-12",
]);
for (const m of bareCss.matchAll(/var\((--[a-z0-9-]+)/g)) {
  assert.ok(KNOWN_TOKENS.has(m[1]), `未知宿主 token，拼错会静默不生效：${m[1]}`);
}

// --- 宿主路由契约 ---
// 契约照抄 WebServer.match()：exact 表按 pathname 精确命中，前导斜杠是硬要求。
const { apply } = await import("../lib/index.js");
let route, dispose;
apply({ inject: (deps, fn) => fn({ effect: (fn2) => { dispose = fn2(); },
  webServer: { register: (r) => { route = r; return () => { route = undefined; }; } } }) }, {});
assert.equal(route.kind, "exact");
assert.equal(route.path, "/prompt-optimizer/api", "路由路径必须带前导斜杠，否则宿主 match() 匹配不到");

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
const wrongMethod = await call("DELETE", "/prompt-optimizer/api", "");
assert.equal(wrongMethod.status, 405, "只有 GET/POST 合法");
// GET 是模型目录：llm 不可用时也要返回可解析的空目录，而不是崩掉。
const catRoute = await call("GET", "/prompt-optimizer/api", "");
assert.equal(catRoute.status, 200);
assert.deepEqual(catRoute.payload.value.groups, [], "llm 不可用时目录为空数组");
assert.equal(catRoute.payload.value.default, null, "取不到默认模型就是 null");

// --- pickModel（纯逻辑）---
{
  const { pickModel } = await import("../lib/optimize.js");
  assert.equal(pickModel(undefined), null);
  assert.equal(pickModel({}), null);
  assert.equal(pickModel({ model: "x" }), null, "model 不是对象时当没传");
  assert.equal(pickModel({ model: { provider: "p" } }), null, "缺 model 时当没传");
  assert.equal(pickModel({ model: { provider: "", model: "m" } }), null, "空 provider 当没传");
  assert.deepEqual(pickModel({ model: { provider: " p ", model: " m " } }), { provider: "p", model: "m" }, "要去空白");
}


// --- 宿主必须真的按客户端选的模型去调，并回显实际用的那个 ---
// 上面的 call() 假 ctx 没有 llm.stream，POST 在 503 就返回了，走不到模型解析——
// 所以这里换一个带 stream 的 sctx 重新注册路由，专门覆盖「选模型」这条路径。
{
  let used = null;
  const fakeLlm = {
    // p-empty 没有任何模型：宿主要跳过它，否则下拉框会出现一个空分组
    listProviders: () => [{ id: "p-only", name: "Only" }, { id: "p-empty", name: "Empty" }],
    listModels: async (id) => (id === "p-empty" ? [] : [{ id: "m-only", name: "Only Model" }]),
    stream: (opts) => {
      used = { provider: opts.provider, model: opts.model, system: opts.system, maxTokens: opts.maxTokens };
      return (async function* () { yield { type: "text-delta", text: "改写后的正文" }; })();
    },
  };
  let r3;
  apply({ inject: (deps, fn) => fn({
    effect: (fn2) => { fn2(); },
    llm: fakeLlm,
    agentDefaultModel: { currentSelection: () => ({ provider: "session-model", model: "session-model" }) },
    agents: { get: () => ({ session: { requestHeader: () => ({ config: { provider: "hdr", model: "hdr" } }) } }) },
    sessions: { current: () => ({ id: "s1" }) },
    webServer: { register: (r) => { r3 = r; return () => {}; } },
  }) }, {});
  assert.equal(r3.path, "/prompt-optimizer/api");
  const callWith = (method, body) => new Promise((resolve) => {
    const res = { status: 0, payload: undefined,
      writeHead(st) { this.status = st; },
      end(t) { this.payload = JSON.parse(t); resolve(this); } };
    const req = { method, url: "/prompt-optimizer/api", headers: { host: "127.0.0.1:19387" },
      on(ev, fn) { this[ev] = fn; }, destroy() {} };
    r3.handler(req, res).catch((e) => resolve({ status: 500, payload: { error: String(e) } }));
    setTimeout(() => { if (typeof req.data === "function") { req.data(Buffer.from(body)); req.end(); } }, 0);
  });
  // 不带 model → 跟随会话（requestHeader）
  const followed = await callWith("POST", JSON.stringify({ text: "hi" }));
  assert.equal(followed.status, 200, "llm 可用且不指定 model 时应成功");
  assert.equal(used.provider + "/" + used.model, "hdr/hdr", "默认跟随会话模型");
  assert.equal(used.system, SYSTEM_PROMPT, "系统提示词必须原样传给模型");
  assert.ok(used.maxTokens > 0, "maxTokens 传 0 等于不让模型说话");
  assert.deepEqual(followed.payload.value.model, { provider: "hdr", model: "hdr" }, "响应要回显实际用的模型");
  assert.equal(followed.payload.value.text, "改写后的正文");
  // 带 model → 用客户端选的那个，不能被会话回落盖掉
  const picked = await callWith("POST", JSON.stringify({ text: "hi", model: { provider: "p-only", model: "m-only" } }));
  assert.equal(picked.status, 200);
  assert.equal(used.provider + "/" + used.model, "p-only/m-only", "客户端选的模型必须优先于会话模型");
  assert.deepEqual(picked.payload.value.model, { provider: "p-only", model: "m-only" });
  // 模型只吐空白 → 502（别把空面板交给用户）
  fakeLlm.stream = () => (async function* () { yield { type: "text-delta", text: "   " }; })();
  const blank = await callWith("POST", JSON.stringify({ text: "hi" }));
  assert.equal(blank.status, 502);
  assert.equal(blank.payload.error.code, "empty-response");
  // 目录：这回 llm 可用，要真列出模型
  const cat = await callWith("GET", "");
  assert.equal(cat.payload.value.groups.length, 1, "零模型的 provider 不该出现在目录里");
  assert.equal(cat.payload.value.groups[0].id, "p-only");
  assert.deepEqual(cat.payload.value.routableProviders, ["p-only"]);
  assert.equal(cat.payload.value.default.provider, "session-model");
}

console.log("ok - prompt-optimizer self-test passed");
