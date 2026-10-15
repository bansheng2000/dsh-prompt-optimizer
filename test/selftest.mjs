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
// 假 DOM 节点：面板位移要量 offsetWidth / getBoundingClientRect，宿主组件要用
// addEventListener。面板几何默认给一套「桌面：图标在视口右侧够宽处」的值，
// 需要别的布局就用 LAYOUT 覆盖。
let LAYOUT = { panelWidth: 420, wrapRight: 1200, vw: 1440, vh: 900 };
const mkStyle = () => {
  const props = {};
  return { props, setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } };
};
// 面板和 wrap 都是单例：clampPanel 写入 --po-shift，断言要读回同一个对象。
let panelNode = { style: mkStyle(), get offsetWidth() { return LAYOUT.panelWidth; }, getBoundingClientRect: () => ({ left: 0, right: LAYOUT.panelWidth }) };
const wrapNode = { style: mkStyle(), querySelector: (sel) => (sel === ".po-panel" ? panelNode : null),
  getBoundingClientRect: () => ({ left: LAYOUT.wrapRight - 33, right: LAYOUT.wrapRight, top: 840, bottom: 866, width: 33, height: 26 }) };
const resetLayout = (next) => { LAYOUT = next; panelNode.style = mkStyle(); };

// 状态槽要跨渲染留存：点击改的是 state，断言必须重渲染后才看得见新树。
// （先前只重渲染一次就断言，面板永远读不到——假红。）
// 假 React 的 state/ref 要跨渲染稳定：hook 调用顺序固定，所以用「每次渲染从 0 重新
// 计数 + 全局槽位数组」来还原 React 语义。点击改的是 state，断言必须再渲染一次才看得见新树。
const ui = { s: [], refs: [], cur: 0, refCur: 0, effectCur: 0, effects: [] };
const fakeReact = {
  createElement: h,
  useState: (init) => {
    const i = ui.cur++;
    if (!(i in ui.s)) ui.s[i] = init;
    return [ui.s[i], (v) => { ui.s[i] = typeof v === "function" ? v(ui.s[i]) : v; }];
  },
  // useEffect 要按 React 的 deps 语义跑：deps 没变就完全不碰（否则每次重渲染都重复
  // 注册事件监听，测试会数出 2 个）；变了则先跑上一次的清理再跑新的。
  // 空实现 = 挂载副作用永不执行 → 「挂载时偷偷拉目录」这类变异永远绿。
  useEffect: (fn, deps) => {
    const i = ui.effectCur++;
    const prev = ui.effects[i];
    const same = prev !== undefined && Array.isArray(deps) && Array.isArray(prev.deps)
      && deps.length === prev.deps.length && deps.every((d, k) => Object.is(d, prev.deps[k]));
    if (same) return;
    if (prev && typeof prev.cleanup === "function") prev.cleanup();
    const cleanup = fn();
    ui.effects[i] = { deps, cleanup: typeof cleanup === "function" ? cleanup : null };
  },
  // ref 要拿到真实节点：React 在提交时把 DOM 填进 ref.current。组件树里第一个带 ref
  // 的元素就是 .po-wrap，这里直接给个假节点（含 querySelector/offsetWidth）。
  useRef: (v) => {
    const i = ui.refCur++;
    if (!(i in ui.refs)) ui.refs[i] = { current: v === null ? wrapNode : v };
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
// 每次调用 = 一次页面加载：client.js 里的目录缓存是模块级状态，重新挂一次就回到
// 「本页还没拉过目录」。第一个挂载同时做契约断言（模块 id / 只向宿主要 react / inject 槽）。
function mountClient() {
  let registration;
  const style = { tag: null };
  // 组件要在 resize 上挂 clampPanel，沙箱 window 必须有事件接口；顺便记下挂了几个，
  // 断言「面板关闭后不监听」。
  const win = {
    __ModuleLoader__: { load: (r) => { registration = r; } },
    listeners: {},
    addEventListener(t, fn) { (win.listeners[t] ??= []).push(fn); },
    removeEventListener(t, fn) { win.listeners[t] = (win.listeners[t] || []).filter((f) => f !== fn); },
  };
  vm.runInNewContext(clientSrc, {
    window: win,
    document: {
      baseURI: fakeDocument.baseURI,
      createElement: () => (style.tag = { setAttribute() {}, remove() {}, textContent: "" }),
      head: { appendChild() {} },
    },
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
  return { registered, style, win };
}
const mount = mountClient();

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
// 第二个参数是 mountClient() 的返回值：传了就用那份挂载（另一个「页面」）的组件和样式。
let mounted = mount;
const render = (props = INPUT, m = mounted) => {
  ui.cur = 0;
  ui.refCur = 0;
  ui.effectCur = 0; // effect 槽按「本次渲染内的 hook 序号」索引，必须和 state/ref 一样每次归零
  inRender = true;
  try {
    return m.registered.Comp(props);
  } finally {
    inRender = false;
  }
};
// fresh = 一个新场景（新页面）：先卸载旧的（跑清理函数、state/ref 丢掉），
// 再挂一次。useEffect 会在这次渲染里真实触发，所以「挂载时偷偷拉目录」
// 「挂载时注入全局样式」这类副作用现在能被抓到（之前 useEffect 是空实现）。
const fresh = (props = INPUT, m = mounted) => {
  for (const e of ui.effects) if (e && typeof e.cleanup === "function") e.cleanup();
  ui.effects.length = 0;
  ui.effectCur = 0;
  ui.s.length = 0;
  ui.refs.length = 0;
  calls.length = 0;
  return render(props, m);
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
const deepFind = (node, pred) => {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node.kids)) for (const k of node.kids) { const hit = deepFind(k, pred); if (hit) return hit; }
  return pred(node) ? node : undefined;
};
// 渲染整棵树再递归找：空闲态断言要的是「整棵树上什么都没有」，
// 不能只 peek 面板子节点——那样面板没渲染时 deepFind 当然也找不到。
const getSelect = (props, m) => deepFind(render(props, m), (k) => k.type === "select");
const getModelIcon = (props, m) => deepFind(render(props, m), (k) => k?.props?.className === "po-model");

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
  // 再点收起、再点打开：目录不该再拉一次。用户报「有时候还是会刷新模型列表」——
  // 每次点开都重新 GET，下拉框会先塌回「跟随会话模型」再跳出来，看着像列表在闪。
  const getsBefore = calls.filter((c) => c.method === "GET").length;
  await btn(t).onClick(); // 收起
  await flush();
  t = render(INPUT);
  assert.equal(panel(t), undefined, "再点收起");
  await btn(t).onClick(); // 再打开
  await flush();
  t = render(INPUT);
  assert.equal(calls.filter((c) => c.method === "GET").length, getsBefore, "目录是缓存的，同一页面不该反复拉");
    const sel = deepFind(panel(t), (k) => k.type === "select");
  assert.ok(sel.kids.length > 1, "再打开时模型列表应立刻在，不用等网络");
}

// --- 面板出屏夹取（桌面端报「不行」的根因）---
// 面板 right:0 贴着图标往左展开，图标离视口左边不足面板宽时整块跑到屏幕外，
// 只剩右边几个控件可见（截图里标题/下拉/文本全在屏外）。clampPanel 量左溢出写
// --po-shift，transform 把它平回来。
{
  // 桌面：图标右缘 1200，视口 1440，面板 420 → 面板左缘 780，够宽，不需要位移
  resetLayout({ panelWidth: 420, wrapRight: 1200, vw: 1440, vh: 900 });
  let t = fresh(INPUT);
  await btn(t).onClick();
  await flush();
  t = render(INPUT); // 重渲染才跑 effect（假 React 没有调度器，靠 render() 推进）
  assert.equal(panelNode.style.props["--po-shift"], undefined,
    "图标离左边够远时不该位移（--po-shift 要被删掉，否则会平出右边）");
  // 左侧栏一开：图标右缘只剩 300，面板左缘 = 300-420 = -120 → 需要右移 128
  resetLayout({ panelWidth: 420, wrapRight: 300, vw: 1440, vh: 900 });
  t = fresh(INPUT);
  await btn(t).onClick();
  await flush();
  t = render(INPUT);
  assert.equal(panelNode.style.props["--po-shift"], "128px",
    "左溢出 120 + 8px 安全边 = 右移 128");
  // resize 时要重新夹：视口变窄后再夹一次
  LAYOUT = { panelWidth: 420, wrapRight: 100, vw: 1440, vh: 900 };
  const handlers = mounted.win.listeners.resize || [];
  assert.ok(handlers.length === 1, "面板开着时要监听 resize");
  handlers[0]();
  assert.equal(panelNode.style.props["--po-shift"], "328px", "resize 后按新布局重算溢出");
  // 面板收起后必须解绑，别在关闭状态白跑几何。
  // 注意要再 render 一次：清理函数是在 open 变 false 的那次渲染里跑的（真实 React
  // 在 commit 阶段解绑），点完就断言等于断言得太早。
  t = render(INPUT);
  await btn(t).onClick();
  await flush();
  render(INPUT);
  assert.equal((mounted.win.listeners.resize || []).length, 0, "面板关闭后要解绑 resize");
}

// --- 没点就不该有面板，也不该发任何请求 ---
// 用户报「有时候啥都不点还是会加载模型」：挂载/重渲染/父组件刷新都不该碰网络。
{
  const tree = fresh(INPUT, mount);
  // 再多渲染十次：宿主重渲染（切会话、输入内容变化）会反复走到这里
  for (let i = 0; i < 10; i++) {
    const t = render(INPUT, mount);
    assert.equal(calls.length, 0, "渲染不该发请求");
    assert.equal(panel(t), undefined, "没点就不该有面板");
    assert.equal(getSelect(INPUT, mount), undefined, "没点就不该有下拉框");
    assert.equal(getModelIcon(INPUT, mount), undefined, "没点就不该有加载中标记");
  }
  const btnNode = tree.kids.find((k) => k && k.type === "button");
  assert.ok(btnNode, "空闲态也得有按钮");
  assert.equal(btnNode.props.disabled, false, "空闲时按钮不该被禁用");
}

// --- 「用这条」写回草稿：必须「替换整段」，不是追加 ---
// 曾经用 insertText(captureInsertion() 的 span)，而 captureInsertion 给的是光标位置
// （塌缩 span）→ 结果被追加到原文后面（用户报「现在是直接填在原内容后」）。
// 宿主 setDraft 的语义就是「替换整段草稿」，所以主路径必须是它。
{
  let draftNow = "帮我写个爬虫";
  const setDraft = (txt) => { draftNow = txt; };
  const insertText = () => { throw new Error("有 setDraft 时不该走 insertText（它按 span 替换，会追加）"); };
  const props = { useInput: useInputOf({ get draft() { return draftNow; }, draftRev: 3 }),
    inputActions: { captureInsertion: () => ({ start: 6, end: 6, draftRev: 3 }), insertText, setDraft } };
  let t = fresh(props);
  await btn(t).onClick();
  await flush();
  t = render(props);
  actBtn(t, "用这条").props.onClick();
  assert.equal(draftNow, "改写结果", "「用这条」要把整段草稿换成改写结果");
  assert.ok(!draftNow.includes("帮我写个爬虫"), "原草稿必须被替换掉，不能留在结果后面");
  t = render(props);
  assert.equal(panel(t), undefined, "写回后自动收起面板");
}
// 老宿主没有 setDraft：退化成 insertText 时也必须给整段 span，不能给光标 span
{
  let inserted = null, givenSpan = null;
  const props = { useInput: INPUT.useInput, inputActions: {
    captureInsertion: () => ({ start: 6, end: 6, draftRev: 3 }),
    insertText: (txt, span) => { inserted = txt; givenSpan = span; },
  } };
  let t = fresh(props);
  await btn(t).onClick();
  await flush();
  t = render(props);
  actBtn(t, "用这条").props.onClick();
  assert.equal(inserted, "改写结果", "无 setDraft 时仍要能写回");
  // 逐字段比：span 是在 vm 沙箱里建的，deepEqual 跨 realm 会因原型不同而误判。
  assert.equal(givenSpan.start, 0, "fallback 的 span 必须覆盖整段草稿，否则是追加");
  assert.equal(givenSpan.end, 6);
  assert.equal(givenSpan.draftRev, 3);
  t = render(props);
  assert.equal(panel(t), undefined, "写回后自动收起面板");
}
// insertText 被宿主拒绝（revision 漂移返回 false）：必须留在面板上提示，不许静默
{
  const props = { useInput: INPUT.useInput, inputActions: { insertText: () => false } };
  let t = fresh(props);
  await btn(t).onClick();
  await flush();
  t = render(props);
  actBtn(t, "用这条").props.onClick();
  t = render(props);
  assert.ok(panel(t), "写回被拒时不该收起面板");
  assert.match(String(msgOf(t).kids[0] ?? ""), /手动复制/, "被拒要给出可操作的提示");
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
  // 缓存是模块级状态，早先的用例已经把好目录缓下来了，必须整份重新挂一次 client.js
  // 才能回到「本页还没拉过目录」的状态——直接改 catalogBroken 是不生效的（踩过）。
  const reloaded = await mountClient();
  catalogBroken = true;
  let t = fresh(INPUT, reloaded);
  await btn(t).onClick();
  await flush();
  await flush();
  t = render(INPUT, reloaded);
  assert.equal(deepFind(panel(t), (k) => k.type === "textarea").props.value, "改写结果",
    "拉不到模型目录也要照样出结果");
  const selEl = deepFind(panel(t), (k) => k.type === "select");
  assert.equal(selEl.kids.filter((k) => k && k.type === "option").length, 1, "目录挂了只剩「跟随会话模型」一项");
  // 失败不该被缓存住：目录恢复后下次打开必须重试，否则一次抖动就永远是单选项。
  catalogBroken = false;
  const getsAfterFail = calls.filter((c) => c.method === "GET").length;
  await btn(t).onClick(); // 收起
  await flush();
  t = render(INPUT, reloaded);
  await btn(t).onClick(); // 再打开
  await flush();
  t = render(INPUT, reloaded);
  assert.ok(calls.filter((c) => c.method === "GET").length > getsAfterFail, "目录失败后要允许下次重试");
  assert.ok(deepFind(panel(t), (k) => k.type === "select").kids.length > 1, "恢复后模型列表要出来");
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
// --- 用量行：宿主回带 usage 才有；输入/输出/合计分开；没配单价就只报 token ---
{
  let host = { input: 1234, output: 567, cacheRead: 200, cacheWrite: 0, total: 2001,
    requests: 1, attempts: 2, failed: 0, since: 1700000000000, scope: "process",
    price: null, priceSource: null, cost: null };
  sandbox.fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    if (method === "GET") return { status: 200, json: async () => ({ ok: true, value: { ...CATALOG.value, usage: host } }) };
    return { status: 200, json: async () => ({ ok: true, value: { text: "带用量的结果", usage: host } }) };
  };
  const statsEl = (tree) => deepFind(tree, (k) => k && k.props && k.props.className === "po-stats");
  let t = fresh(INPUT);
  await btn(t).onClick();
  await flush();
  await flush();
  t = render(INPUT);
  const el = statsEl(t);
  assert.ok(el, "宿主回了 usage 就该有用量行");
  const line = el.kids[0];
  assert.match(line, /输入 1,234/, "输入 token 单独写出来");
  assert.match(line, /输出 567/, "输出 token 单独写出来");
  assert.match(line, /合计 2,001/, "合计单独写出来，不合并成一个含糊的数");
  assert.match(line, /缓存读 200/, "缓存读写要单列");
  assert.match(line, /成功 1 \/ 尝试 2/, "重试/失败也要让用户看见（那里也花了钱）");
  assert.ok(!/约/.test(line), "没配单价就只能报 token，不许出现金额");
  assert.match(el.props.title, /进程内累计/, "悬停要说明统计范围与生命周期");
  assert.match(el.props.title, /未配单价/, "悬停要说明为什么没有金额");
  // 配了单价（宿主 rules.price）→ 金额出现，且悬停标出单价来源
  host = { ...host, price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0, currency: "CNY" },
    priceSource: "config.rules.price (DSH profile cordis.patch.yml)",
    cost: { input: 0.003702, output: 0.008505, cacheRead: 0.00006, cacheWrite: 0, total: 0.012267, currency: "CNY" } };
  await actBtn(t, "重新生成").props.onClick();
  await flush();
  t = render(INPUT);
  const el2 = statsEl(t);
  assert.match(el2.kids[0], /约 0\.0123 CNY/, "配了单价才显示金额");
  assert.match(el2.props.title, /config\.rules\.price/, "悬停要写明单价来源，不留孤立数字");
  sandbox.fetch = fakeFetch;
}
// --- CSS 断言（图标尺寸 + all:unset 保持不变）---
const styleCss = mount.style.tag.textContent;
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
// at-rule（@media）不是选择器，它的块里装的是别处也要遵守作用域根的规则——过滤掉再校验。
const selectors = [...bareCss.matchAll(/(?:^|\})\s*([^{}]+?)\s*\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith("@"));
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
// 手机版实测（用户截图）：宿主把输入框那一行重排后，图标落到屏幕最左边，按图标对齐的面板
// 从左边缘出屏，只剩「重新生成」看得见。所以窄屏必须有一条脱离图标、改用视口锚定的 @media 规则。
const narrow = /@media \(max-width: 640px\) \{([\s\S]*?)\n {6}\}/.exec(bareCss);
assert.ok(narrow, "必须有窄屏 @media 规则，手机端面板不能只按图标对齐");
const narrowBody = narrow[1];
assert.ok(/\.po-panel \{[\s\S]*?position:\s*fixed/.test(narrowBody), "窄屏面板要脱离图标、贴视口定位");
assert.ok(/\.po-panel \{[\s\S]*?left:\s*8px[\s\S]*?right:\s*8px/.test(narrowBody), "窄屏面板要左右双向锚定，保证全宽可见");
assert.ok(/\.po-panel \{[\s\S]*?top:/.test(narrowBody), "窄屏面板固定在顶部，不跟着图标上下跳");
const narrowPanel = /\.po-panel \{([^}]*)\}/.exec(narrowBody)[1];
assert.ok(/\bbottom:\s*auto/.test(narrowPanel),
  "窄屏面板必须把 base 的 bottom:calc(100% + 6px) 显式盖成 auto，否则会和 top 一起把面板高度撑爆");
assert.ok(!/\bbottom:\s*(?!auto)[^;]*\d/.test(narrowPanel), "窄屏面板的 bottom 只能是 auto");
// token 拼错会静默失效（本项目曾连写 5 个不存在的 token）。只许用 asar 里实测存在的名字，
// 外加本插件自己写入的 --po-shift（面板位移，clampPanel 在开面板时 setProperty）。
const KNOWN_TOKENS = new Set([
  "--dsw-alias-label-primary", "--dsw-alias-label-secondary", "--dsw-alias-state-error-primary",
  "--dsw-alias-state-business-primary", "--dsw-alias-border-l1", "--dsw-alias-bg-layer-1",
  "--dsw-alias-interactive-bg-hover", "--dsw-radius-sm", "--dsw-radius-panel",
  "--dsw-elevation-panel", "--dsw-specific-input-major", "--dsw-font-family",
  "--dsw-font-xs-13", "--dsw-font-xxs-12", "--po-shift",
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
      used = { provider: opts.provider, model: opts.model, system: opts.system, maxTokens: opts.maxTokens, sessionId: opts.sessionId };
      return (async function* () { yield { type: "text-delta", text: "改写后的正文" }; })();
    },
  };
  let r3;
  apply({ inject: (deps, fn) => fn({
    effect: (fn2) => { fn2(); },
    llm: fakeLlm,
    agentDefaultModel: { currentSelection: () => ({ provider: "session-model", model: "session-model" }) },
    agents: { get: () => ({ session: { requestHeader: () => ({ config: { provider: "hdr", model: "hdr" } }) } }) },
    // 真实形状：宿主 ClientSessions 没有 current()（照 dsh-api-session-controller 抄）
    sessions: {},
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
  // 4096 起步：推理模型（deepseek-v4.1-flash）会把 1024 全吃在 reasoning_content 上，
  // 正文一个字符都不剩 —— 实测直连 opencode-go 就是这样。
  assert.ok(used.maxTokens >= 4096, "推理模型的输出预算不能太小");
  // opencode 系 provider（pi-ai 的 withOpenCodeSessionHeader）只在 sessionId 非空时补
  // x-opencode-session 头，缺头就是上游 400 MissingSessionID —— 用户报的 400 就是这个。
  assert.equal(typeof used.sessionId, "string", "sessionId 必须传给 llm.stream（缺头会 400）");
  assert.ok(used.sessionId.length > 0, "sessionId 不能是空串，空串等于没传");
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
  // 适配器失败不抛异常，只折成终止块 {type:"finish", reason:{kind,failure}}：以前只认
  // text-delta，于是 429 / 超时 / 模型不存在全都被显示成同一句「model returned no text」。
  fakeLlm.stream = () => (async function* () {
    yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMITED", message: "upstream 429" } } };
  })();
  const failed = await callWith("POST", JSON.stringify({ text: "hi" }));
  assert.equal(failed.status, 502);
  assert.equal(failed.payload.error.code, "RATE_LIMITED", "要把 finish 块里的 failure.code 透给客户端");
  assert.match(failed.payload.error.message, /upstream 429/);
  // 推理模型把预算吃光 → finish{max-tokens}，正文为空，也要认出来
  fakeLlm.stream = () => (async function* () { yield { type: "finish", reason: { kind: "max-tokens" } }; })();
  const truncated = await callWith("POST", JSON.stringify({ text: "hi" }));
  assert.equal(truncated.status, 502);
  assert.equal(truncated.payload.error.code, "max-tokens");
  // 第一次空响应 → 自动重试一次（用户现在的土办法就是「再点一下」）
  let tries = 0;
  fakeLlm.stream = () => (async function* () {
    tries += 1;
    if (tries === 1) return;
    yield { type: "text-delta", text: "第二次成功" };
  })();
  const retried = await callWith("POST", JSON.stringify({ text: "hi" }));
  assert.equal(retried.status, 200, "第一次空响应要自动重试一次");
  assert.equal(retried.payload.value.text, "第二次成功");
  // 目录：这回 llm 可用，要真列出模型
  const cat = await callWith("GET", "");
  assert.equal(cat.payload.value.groups.length, 1, "零模型的 provider 不该出现在目录里");
  assert.equal(cat.payload.value.groups[0].id, "p-only");
  assert.deepEqual(cat.payload.value.routableProviders, ["p-only"]);
  assert.equal(cat.payload.value.default.provider, "session-model");
}


// --- 用量统计（宿主）：口径 / 累计 / 费用只从配置读 ---
{
  const reg = async (llm, config) => {
    let r;
    const { apply: ap } = await import("../lib/index.js");
    ap({ inject: (deps, fn) => fn({
      effect: (f) => { f(); },
      llm,
      // 没有它 resolveTarget 会返回 null → 503 no-route，根本走不到查询用量的那段
      agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
      webServer: { register: (x) => { r = x; return () => {}; } },
    }) }, config ?? {});
    return r;
  };
  const call = (r, method, body) => new Promise((resolve) => {
    const res = { status: 0, payload: undefined,
      writeHead(st) { this.status = st; },
      end(t2) { this.payload = JSON.parse(t2); resolve(this); } };
    const req = { method, url: "/prompt-optimizer/api", headers: { host: "127.0.0.1:19387" },
      on(ev2, fn) { this[ev2] = fn; }, destroy() {} };
    r.handler(req, res).catch((e) => resolve({ status: 500, payload: { error: String(e) } }));
    setTimeout(() => { if (typeof req.data === "function") { req.data(Buffer.from(body)); req.end(); } }, 0);
  });
  const withUsage = (u, text) => (async function* () {
    yield { type: "usage", usage: u };
    if (text) yield { type: "text-delta", text };
  })();

  // 没配单价：只报 token
  const plain = await reg({ listProviders: () => [], listModels: async () => [],
    stream: () => withUsage({ inputTokens: 1_000_000, outputTokens: 0 }, "结果") });
  const p0 = (await call(plain, "GET", "")).payload.value.usage;
  assert.equal(p0.cost, null, "没配单价 → cost 必须是 null，不许编造价格");
  assert.equal(p0.priceSource, null, "没配单价 → priceSource 也是 null（没有来源就没有数字）");
  assert.equal(p0.scope, "process", "统计范围是「本插件进程内累计」");
  assert.ok(typeof p0.since === "number" && p0.since <= Date.now(), "since = 台账起点（模块加载时刻）");
  const r1 = await call(plain, "POST", JSON.stringify({ text: "hi" }));
  assert.equal(r1.status, 200);
  const p1 = r1.payload.value.usage;
  assert.equal(p1.input - p0.input, 1_000_000, "宿主 usage 块的输入 token 要入账");
  assert.equal(p1.output - p0.output, 0);
  assert.equal(p1.attempts - p0.attempts, 1, "一次尝试记一次");
  assert.equal(p1.requests - p0.requests, 1, "成功返回正文记一次 requests");
  assert.equal(p1.failed - p0.failed, 0);
  assert.equal(p1.total, p1.input + p1.output + p1.cacheRead + p1.cacheWrite, "合计 = 输入+输出+缓存读+缓存写");
  const g1 = (await call(plain, "GET", "")).payload.value.usage;
  assert.ok(g1.total >= p1.total, "GET 也回带同一本账（人工核对通道）");

  // 配了单价：单位「货币 / 百万 token」
  const priced = await reg({ listProviders: () => [], listModels: async () => [],
    stream: () => withUsage({ inputTokens: 1_000_000, outputTokens: 0 }, "结果") },
    { rules: { price: { input: 3, output: 15, currency: "CNY" } } });
  const before = (await call(priced, "GET", "")).payload.value.usage;
  assert.equal(before.price.currency, "CNY");
  assert.match(before.priceSource, /config\.rules\.price/, "单价来源要写明白，不留孤立数字");
  const priced200 = await call(priced, "POST", JSON.stringify({ text: "hi" }));
  const after = priced200.payload.value.usage;
  assert.ok(Math.abs(after.cost.total - before.cost.total - 3) < 1e-9, "每百万输入 token × 单价 3");
  assert.ok(Math.abs(after.cost.input - before.cost.input - 3) < 1e-9, "分项费用也要能算");
  assert.equal(after.cost.cacheRead - before.cost.cacheRead, 0, "没配的字段按 0 算，不炸 NaN");

  // 失败/空响应重试：两次尝试各记各的（第一次白花的也在账上）
  let n = 0;
  const flaky = await reg({ listProviders: () => [], listModels: async () => [],
    stream: () => {
      n += 1;
      return n === 1
        ? withUsage({ inputTokens: 100, outputTokens: 0 })
        : withUsage({ inputTokens: 10, outputTokens: 50 }, "第二次成功");
    } });
  const b2 = (await call(flaky, "GET", "")).payload.value.usage;
  const retried = await call(flaky, "POST", JSON.stringify({ text: "hi" }));
  assert.equal(retried.status, 200, "第二次尝试出正文就算成功");
  assert.equal(retried.payload.value.text, "第二次成功");
  const f2 = retried.payload.value.usage;
  assert.equal(f2.attempts - b2.attempts, 2, "两次尝试都记账（含第一次白花的那笔）");
  assert.equal(f2.input - b2.input, 110, "两次尝试的输入 token 都要累计");
  assert.equal(f2.output - b2.output, 50);
  assert.equal(f2.requests - b2.requests, 1, "成功仍只算一次");
}
console.log("ok - prompt-optimizer self-test passed");
