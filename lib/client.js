// 客户端：在聊天输入框右边（conversation.input.right）加一个「优化提示词」按钮。
// 点击：取当前草稿 → POST 宿主路由 → 把结果整段替换回输入框。
// 由 window.__ModuleLoader__ 以 UMD 形工厂加载，React 从宿主模块表拿。
window.__ModuleLoader__.load({
  id: "dsh-prompt-optimizer",
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const inject = ["slots"];

    const SLOT = "conversation.input.right";
    const ENTRY_ID = "prompt-optimizer";

    // 图标：名侦探柯南主题横幅，按源图比例（2500×1677）缩到 40px 高内联成 data URI
    // （client bundle 没有静态文件服务，也不能 require 宿主资源包）。CSS 只锁高度，宽度自适应。
    const ICON_SRC = "data:image/png;base64,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";

    const STYLE = `
      /* 作用域根必须是 .po-wrap：data-plugin-css 打在 <style> 标签自己身上，
         它不在按钮的祖先链里，用它做前缀的规则一条都匹配不上——图标外那圈框
         就是规则全失效后露出的浏览器默认 button 样式（2px outset + 6px padding）。 */
      .po-wrap { display: inline-flex; align-items: center; flex: none; position: relative; }
      /* 图标即按钮：按钮盒 = 图片盒，20px 高、宽度按源图比例自适应。 */
      .po-wrap .po-icon { height: 20px; width: auto; display: block; flex: none; border-radius: 4px; }
      .po-wrap .po-btn {
        /* all:unset 抹掉宿主/UA 的 button padding、边框与 appearance。 */
        all: unset;
        display: inline-flex; align-items: center; justify-content: center;
        flex: none; appearance: none; padding: 0; margin: 0; line-height: 0;
        border: none; background: none;
        cursor: pointer; color: var(--dsw-alias-label-primary);
        border-radius: var(--dsw-radius-sm);
        transition: opacity .1s;
      }
      .po-wrap .po-btn:hover:not(:disabled) { opacity: .7; }
      .po-wrap .po-btn:disabled { opacity: .4; cursor: not-allowed; }
      /* M4：all:unset 把 UA 的 focus 框一起抹了，键盘用户看不出焦点落在哪。用
         :focus-visible 补回来——只在键盘/程序聚焦时出现，鼠标点击不会闪框。
         三个 all:unset 的元素（图标按钮/模型下拉/操作按钮）都要，漏一个就有一条
         Tab 路径看不见焦点。 */
      .po-wrap .po-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .po-wrap .po-model:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .po-wrap .po-act:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      /* 面板：绝对定位挂在图标上方（bottom 而非 top），不占布局；宿主 composer
         祖先链上没有 overflow:hidden（实测 .RlGAzG_card 只有 box-sizing/圆角/阴影），
         所以不会被裁掉。宽度按视口兜底：手机窄屏时 100vw-48 保证左边缘不出屏。 */
      .po-wrap .po-panel {
        position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 20;
        width: min(420px, calc(100vw - 48px)); max-height: 60vh; overflow: auto;
        /* right:0 = 面板一律贴着图标往左展开。图标离视口左边不足一整个面板宽时
           （桌面端左侧栏一开就是这个情况）面板整块跑到屏幕外，只剩右边几个控件
           可见——用户报「桌面版不行」。CSS 量不出自身溢出，所以开面板时用 JS 算出
           左溢出多少写进 --po-shift（clampPanel），transform 只改视觉不参与布局。 */
        transform: translateX(var(--po-shift, 0px));
        display: flex; flex-direction: column; gap: 8px;
        box-sizing: border-box; padding: 10px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dsw-radius-panel);
        background: var(--dsw-specific-input-major);
        box-shadow: var(--dsw-elevation-panel);
        font-size: var(--dsw-font-xs-13); line-height: 20px;
        font-family: var(--dsw-font-family);
        color: var(--dsw-alias-label-primary);
        text-align: left;
      }
      /* 窄屏时允许换行，否则「标题+下拉+关闭」一行挤不下 */
      .po-wrap .po-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .po-wrap .po-row .po-title { flex: 1; font-size: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary); }
      .po-wrap .po-text {
        /* 高度交给面板的 max-height 分配：矮屏（手机横屏）不会被 150px 撑出屏外 */
        width: 100%; box-sizing: border-box; flex: 1 1 auto; min-height: 84px;
        max-height: 40vh; resize: vertical;
        padding: 8px; font: inherit;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dsw-radius-sm);
        white-space: pre-wrap; overflow-wrap: anywhere;
      }
      /* M4：原来在 :focus 里写 outline:none，把文本框的焦点环也抹了。border 变色
         只够「看出在编辑」，键盘用户还需要一条明确的环，用 :focus-visible 补回。 */
      .po-wrap .po-text:focus { border-color: var(--dsw-alias-state-business-primary); }
      .po-wrap .po-text:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
      .po-wrap .po-model {
        all: unset; box-sizing: border-box; max-width: min(190px, 100%); padding: 2px 4px;
        font: inherit; font-size: var(--dsw-font-xxs-12);
        color: var(--dsw-alias-label-secondary);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dsw-radius-sm);
        cursor: pointer;
      }
      .po-wrap .po-act {
        all: unset; cursor: pointer; padding: 3px 8px; font: inherit;
        font-size: var(--dsw-font-xxs-12);
        color: var(--dsw-alias-label-primary);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-interactive-bg-hover);
      }
      .po-wrap .po-act:hover:not(:disabled) { color: var(--dsw-alias-state-business-primary); }
      .po-wrap .po-act:disabled { opacity: .4; cursor: not-allowed; }
      .po-wrap .po-msg { flex: 1; font-size: var(--dsw-font-xxs-12); color: var(--dsw-alias-state-error-primary); }
      /* 用量行：输入/输出/合计分开写；宿主没配单价时 cost 为 null，整段费用就不出现。 */
      .po-wrap .po-stats { flex: 1 0 100%; font-size: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary); }
      /* 插件详情页里的「模型」卡片：那个页面不在 .po-wrap 里面（它是设置页自己的 slot），
         所以规则以卡片自身根 .po-settings 为作用域。别借 .po-wrap 的类名——借了就是静默失效。 */
      .po-settings { display: flex; flex-direction: column; gap: 8px; font-size: var(--dsw-font-xs-13); color: var(--dsw-alias-label-primary); }
      .po-settings .po-settings-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .po-settings .po-settings-sel {
        box-sizing: border-box; max-width: 100%; padding: 4px 6px; font: inherit;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); cursor: pointer;
      }
      .po-settings .po-settings-sel:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .po-settings .po-settings-hint { flex: 1 1 100%; font-size: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary); }
      .po-settings .po-settings-err { flex: 1 1 100%; font-size: var(--dsw-font-xxs-12); color: var(--dsw-alias-state-error-primary); }
      /* 面板里的「可复用模板」开关与变量清单 */
      .po-wrap .po-tpl { display: inline-flex; align-items: center; gap: 4px; font-size: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary); cursor: pointer; }
      .po-wrap .po-vars { flex: 1 0 100%; font-size: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      /* 设置页的累计用量块（和模型下拉同一张卡片） */
      .po-settings .po-settings-usage { display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .po-settings .po-settings-btn {
        align-self: flex-start; cursor: pointer; padding: 2px 8px; font: inherit;
        font-size: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-primary);
        border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-interactive-bg-hover);
      }
      .po-settings .po-settings-btn:hover:not(:disabled) { color: var(--dsw-alias-state-business-primary); }
      .po-settings .po-settings-btn:disabled { opacity: .4; cursor: not-allowed; }
      .po-settings .po-settings-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      /* 窄屏（手机）：宿主把输入框那一行重排后，图标落在屏幕最左边，按图标对齐的面板
         必然从左边缘出屏——实测只剩「重新生成」看得见。图标在哪都不算锚点了，所以窄屏改成
         贴视口的顶部抽屉：left/right 双向锚定 = 一定全宽可见；top 也顺带满足了「在上面」。 */
      @media (max-width: 640px) {
        .po-wrap .po-panel {
          position: fixed;
          top: calc(env(safe-area-inset-top, 0px) + 8px);
          left: 8px; right: 8px; bottom: auto;
          width: auto; max-width: none; max-height: 60vh;
          transform: none; /* 窄屏已贴视口双向锚定，再位移就偏了 */
        }
        .po-wrap .po-panel .po-title { flex: 1 0 100%; }
        .po-wrap .po-panel .po-model { flex: 1 1 auto; max-width: none; }
      }
    `;

    function routeUrl() {
      const url = new URL("/prompt-optimizer/api", document.baseURI);
      return url.href;
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.setAttribute("data-plugin-css", "po");
        style.textContent = STYLE;
        document.head.appendChild(style);
        return () => style.remove();
      }, "po: css");

      ctx.slots.inject(SLOT, () =>
        ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: 50, label: "优化提示词" }, OptimizeButton),
      );

      // 插件详情页的「模型」设置。inject 包一层：宿主没声明这个槽（旧版本）时不会炸。
      ctx.slots.inject(SETTINGS_SLOT, () =>
        ctx.slots.register(
          { name: SETTINGS_SLOT, key: SETTINGS_KEY, locale: "promptOptimizer" },
          ({ view }) => (view === "summary" ? "模型：" + prefLabel : h(SettingsCard, null)),
        ),
      );
    }

    // 「跟随会话模型」是哨兵值：空串表示不覆盖模型，由宿主解析当前会话模型。
    const FOLLOW_SESSION = "";

    // 聊天页里的模型选择记在 sessionStorage，按会话 id 分桶：用户要求「聊天页内的模型设置
    // 优先级最高，在聊天页内始终保持一致」。组件状态只活到这次挂载，刷新页面就丢；
    // 记在本页（sessionStorage = 一个标签页）才能做到「刷新后还是这个」。
    // 两种「跟随」要分开存：FOLLOW_STORED = 本页明确选了跟随会话模型（压过全局设置），
    // 空串 = 本页从没选过（这时才落到插件详情页的全局设置）。
    const FOLLOW_STORED = "follow";
    const MODEL_KEY_PREFIX = "po.model.";

    function pageKey(sessionId) {
      return MODEL_KEY_PREFIX + (sessionId === "" ? "default" : sessionId);
    }
    function readPagePick(sessionId) {
      // 隐私模式 / 配额满时 sessionStorage 会抛：只影响「刷新后还记得」，不影响本次使用。
      try { return String(sessionStorage.getItem(pageKey(sessionId)) ?? ""); } catch { return ""; }
    }
    function writePagePick(sessionId, sel) {
      const next = sel === FOLLOW_SESSION ? FOLLOW_STORED : sel;
      try {
        if (next === "") sessionStorage.removeItem(pageKey(sessionId));
        else sessionStorage.setItem(pageKey(sessionId), next);
      } catch { /* ignore */ }
    }
    // 存的是 "provider/model"（select 的 value 只能是串），发给宿主的是对象。
    function splitPick(sel) {
      if (sel === FOLLOW_SESSION) return FOLLOW_SESSION;
      const at = sel.indexOf("/");
      if (at <= 0) return FOLLOW_SESSION; // 坏值一律当跟随，别把整串当模型发出去
      return { provider: sel.slice(0, at), model: sel.slice(at + 1) };
    }
    // 存的值 → 下拉框的值（「明确跟随」与「从没选过」都显示成跟随会话模型）。
    function pickToSel(raw) {
      return raw === "" || raw === FOLLOW_STORED ? FOLLOW_SESSION : raw;
    }

    // 生成中提示。用常量而不是字面量，finally 里才能只清自己那条、不误伤 flash 的错误提示。
    const BUSY_MSG = "生成中…";

    // 「看起来是空白」：trim() 只吃空白，吃不下零宽字符（\u200b 在输入框里完全看不见）。
    // 宿主侧 lib/optimize.js 有同名判定，两边一致：空草稿连请求都不发。
    const INVISIBLE_RE = /[\s\u200b-\u200f\u2060]/g;
    const isBlank = (t) => String(t ?? "").replace(INVISIBLE_RE, "") === "";

    // 用量行文案。口径与宿主一致：输入/输出/合计分开写，缓存读/写单独标出来；
    // 合计 = 输入 + 输出 + 缓存读 + 缓存写（宿主 TokenUsage 同定义）。
    // 费用只在宿主配了单价（profile cordis.patch.yml 的 rules.price）时才出现——
    // 没配就只报 token，不猜价（编造的单价比没有更糟）。
    // 面板只有一行：≥1000 起缩成 K/M/B（只留量级），精确值放悬停提示里。
    function compactNumber(v) {
      const n = Number(v ?? 0);
      for (const [size, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
        if (n >= size) {
          const scaled = n / size;
          // ≥100 时小数位没意义（123.4M 不如 123M）；1.0K 也去掉尾巴的 .0
          return (scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, "")) + suffix;
        }
      }
      return String(n);
    }

    // 面板只显示**本次**改写的输入/输出（用户要求）；累计统计与成功/失败次数搬到插件设置页。
    function statsText(u) {
      const n = compactNumber;
      return `本次 token：输入 ${n(u.input)} · 输出 ${n(u.output)}`;
    }

    function formatCost(cost) {
      const unit = cost.currency ? " " + cost.currency : "";
      return cost.total.toFixed(cost.total < 0.01 ? 6 : 4) + unit;
    }

    // 悬停：先说统计范围（哪一段账、何时起算、含什么不含什么），再给精确到个位的明细
    // （面板上的是缩写，看量级够用但算不了账），单价来源放最后。
    function statsTitle(u) {
      const exact = (v) => Number(v ?? 0).toLocaleString("en-US");
      const cache = u.cacheRead || u.cacheWrite ? ` · 缓存读 ${exact(u.cacheRead)} / 写 ${exact(u.cacheWrite)}` : "";
      return `本次改写：输入 ${exact(u.input)} · 输出 ${exact(u.output)}${cache}`
        + "\n累计统计、成功/失败次数与清除按钮在「插件 → dsh-prompt-optimizer → 配置」里";
    }

    // 设置页的累计用量文案（口径与宿主一致：合计 = 输入 + 输出 + 缓存读 + 缓存写）。
    function usageText(u) {
      const n = compactNumber;
      const cache = u.cacheRead || u.cacheWrite ? `（缓存读 ${n(u.cacheRead)} / 写 ${n(u.cacheWrite)}）` : "";
      const cost = u.cost ? ` · 约 ${formatCost(u.cost)}` : "";
      return `累计 token：输入 ${n(u.input)} · 输出 ${n(u.output)} · 合计 ${n(u.total)}${cache}${cost}`;
    }
    function usageCounts(u) {
      const since = u.since ? new Date(u.since).toLocaleString() : "未知";
      return `成功 ${u.requests} / 尝试 ${u.attempts}` + (u.failed ? ` · 失败 ${u.failed}` : "") + ` · 自 ${since} 起算`;
    }
    function usageTitle(u) {
      const exact = (v) => Number(v ?? 0).toLocaleString("en-US");
      const src = u.priceSource ? `单价来源：${u.priceSource}` : "未配单价，只统计 token";
      const where = u.storeName ? `，账本：${u.storeName}` : "";
      return `本插件累计至今（已落盘${where}，DSH 重启不清零，不含普通聊天）\n`
        + `输入 ${exact(u.input)} · 输出 ${exact(u.output)} · 合计 ${exact(u.total)} · 缓存读 ${exact(u.cacheRead)} / 写 ${exact(u.cacheWrite)}\n${src}`;
    }

    // 模板模式：从结果里扫出 {{变量}}，给用户看有哪些可替换位（不额外花 token）。
    function placeholders(text) {
      const out = [];
      for (const m of String(text ?? "").matchAll(/\{\{([^{}]{1,40})\}\}/g)) {
        const name = m[1].trim();
        if (name !== "" && !out.includes(name)) out.push(name);
      }
      return out;
    }

    const STYLE_OPTIONS = [
      ["standard", "标准"],
      ["review", "审查型"],
      ["concise", "精简"],
      ["role", "角色设定"],
    ];

    // 下拉项摊平成 {value,label,provider,model}：value 只能是一串，所以拆回对象要在
    // 这里做（value 里带 provider 前缀只是 select 需要的唯一键）。
    function flattenCatalog(cat) {
      return (cat?.groups ?? []).flatMap((g) =>
        (g.models ?? []).map((m) => ({ value: g.id + "/" + m.id, label: m.name + " · " + g.name, provider: g.id, model: m.id })),
      );
    }

    // 模型目录整个页面只拉一次：用户报「有时候还是会刷新模型列表」——每次点开都重新拉，
    // 下拉框会先塌回「跟随会话模型」再跳出来，看着像列表在闪。缓存 promise 本身，
    // 并发点击也只会发一次请求；失败缓存 null（可重试），不缓存失败原因。
    // L5：再加一层 60s TTL（与宿主 lib/index.js 的 CATALOG_TTL_MS 同口径）。
    // 原来成功结果整页有效：改完配置、新装一个 provider，得刷新整个页面才看得见新模型。
    const CATALOG_TTL_MS = 60_000;
    let catalogPromise = null;
    let catalogAt = 0;
    // 最近一次 GET 的完整结果（含 model = 全局设置）。详情页保存后同步改这里，
    // 否则面板缓存的那份还是旧设置，60s 内的下一次打开会拿旧值。
    let catalogValue = null;
    function loadCatalog() {
      if (catalogPromise !== null && Date.now() - catalogAt < CATALOG_TTL_MS) return catalogPromise;
      catalogAt = Date.now();
      catalogPromise = fetch(routeUrl())
        .then(async (res) => {
          const data = await res.json().catch(() => null);
          if (data?.ok !== true) throw new Error(String(data?.error?.message ?? `请求失败（${res.status}）`));
          catalogValue = data.value;
          return data.value;
        })
        .catch((e) => {
          catalogPromise = null; // 目录拿不到就允许下次重试
          throw e;
        });
      return catalogPromise;
    }

    // 插件详情页的「模型」设置（全局）。slot 契约（宿主文档 plugins.row.config）：
    // 以「包名#行 id」为键注册，宿主给 view：'summary' 要一段文字、'page' 要表单。
    // 这张表单自己保存（选中即写），所以离开页面不会丢改动、也不用额外保存按钮。
    const SETTINGS_SLOT = "plugins.row.config";
    const SETTINGS_KEY = "dsh-prompt-optimizer#prompt-optimizer";

    function settingsUrl() {
      return new URL("/prompt-optimizer/settings", document.baseURI).href;
    }

    // summary 视图只给一段文字（宿主不会因此拉数据），所以摘要读模块缓存：
    // 卡片加载/保存后更新它，下次进详情页就是新值。默认即用户要求的默认值。
    let prefLabel = "跟随会话模型";
    function setPrefLabel(pref) {
      prefLabel = pref && pref.provider && pref.model ? pref.provider + "/" + pref.model : "跟随会话模型";
      if (catalogValue !== null) catalogValue = { ...catalogValue, model: pref };
    }

    function SettingsCard() {
      const [pref, setPref] = useState(null); // null = 跟随会话模型
      const [cat, setCat] = useState(null);
      const [err, setErr] = useState("");
      const [saving, setSaving] = useState(false);
      const [usage, setUsage] = useState(null);
      useEffect(() => {
        let alive = true;
        fetch(settingsUrl())
          .then((res) => res.json())
          .then((data) => {
            if (!alive) return;
            if (data?.ok !== true) throw new Error(String(data?.error?.message ?? "读取设置失败"));
            const next = data.value?.model ?? null;
            setPref(next);
            setPrefLabel(next);
            if (data.value?.usage) setUsage(data.value.usage);
          })
          .catch((e) => { if (alive) setErr("读取设置失败：" + String(e?.message ?? e)); });
        loadCatalog().then((value) => { if (alive) setCat(value); }, () => {});
        return () => { alive = false; };
      }, []);

      const flat = flattenCatalog(cat);
      const value = pref === null ? FOLLOW_SESSION : pref.provider + "/" + pref.model;
      const onChange = (e) => {
        const picked = flat.find((o) => o.value === e.target.value);
        const next = picked === undefined ? null : { provider: picked.provider, model: picked.model };
        setPref(next);
        setPrefLabel(next);
        setErr("");
        setSaving(true);
        fetch(settingsUrl(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: next }),
        })
          .then((res) => res.json())
          .then((data) => {
            if (data?.ok !== true) throw new Error(String(data?.error?.message ?? "保存失败"));
          })
          .catch((e) => setErr("保存失败：" + String(e?.message ?? e)))
          .finally(() => setSaving(false));
      };

      // 清除累计统计：只清台账（token 与成功/尝试/失败全部归零），不动模型设置。
      const clearUsage = () => {
        setErr("");
        setSaving(true);
        fetch(settingsUrl(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clear: "usage" }),
        })
          .then((res) => res.json())
          .then((data) => {
            if (data?.ok !== true) throw new Error(String(data?.error?.message ?? "清除失败"));
            if (data.value?.usage) setUsage(data.value.usage);
          })
          .catch((e) => setErr("清除失败：" + String(e?.message ?? e)))
          .finally(() => setSaving(false));
      };

      return h(
        "div",
        { className: "po-settings" },
        h(
          "div",
          { className: "po-settings-row" },
          h("span", null, "改写用模型"),
          h(
            "select",
            {
              className: "po-settings-sel",
              "aria-label": "改写用模型",
              title: "本插件的全局默认模型",
              value,
              disabled: saving,
              onChange,
            },
            h("option", { key: "po-follow", value: FOLLOW_SESSION }, "跟随会话模型"),
            ...flat.map((o) => h("option", { key: o.value, value: o.value }, o.label)),
          ),
        ),
        h("span", { className: "po-settings-hint" },
          "全局默认，对所有聊天页生效；聊天页面板里选过的模型优先于这里，并在该页内保持不变。"),
        usage === null ? null : h(
          "div",
          { className: "po-settings-usage" },
          h("span", { className: "po-settings-hint", title: usageTitle(usage) }, usageText(usage)),
          h(
            "div",
            { className: "po-settings-row" },
            h("span", { className: "po-settings-hint" }, usageCounts(usage)),
            h("button", { type: "button", className: "po-settings-btn", disabled: saving, onClick: clearUsage }, "清除统计"),
          ),
        ),
        err === "" ? null : h("span", { className: "po-settings-err" }, err),
      );
    }

    function OptimizeButton(props) {
      const useInput = props?.useInput;
      const inputActions = props?.inputActions;
      // 宿主把本组件所在会话的 id 一起发下来（L8）：POST 带上它，宿主才不会用别的会话的模型。
      const sessionId = typeof props?.sessionId === "string" ? props.sessionId.trim() : "";
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [draft, setDraft] = useState("");
      const [msg, setMsg] = useState("");
      // 初始值：本页选过的模型（sessionStorage）→ 否则等目录回来落到全局设置 → 再否则跟随会话。
      // useState 的初值只在首次挂载读一次，之后由 onChange / 目录回来时改。
      const [sel, setSel] = useState(pickToSel(readPagePick(sessionId)));
      const [cat, setCat] = useState(null);
      const [catErr, setCatErr] = useState("");
      const [stats, setStats] = useState(null);
      const [style, setStyle] = useState("standard");
      const [tpl, setTpl] = useState(false);
      const timer = useRef(0);
      // 宿主 useInput 是 materializeStandardBinding 生成的 selector hook，只能在渲染期调。
      // 之前写在 generate() 的异步回调里 → 非渲染期调 hook 抛错 → 面板弹了但是空的、
      // 目录 GET 也没发出去。这里挪回组件体，闭包自然能拿到当次的值。
      const inputDraft = String(useInput?.((s) => s?.draft) ?? "");
      const draftRev = useInput?.((s) => s?.draftRev);
      const target = useRef(splitPick(pickToSel(readPagePick(sessionId)))); // 跟 sel 分开：sel 变才重渲染，target 供异步回调读
      // 用户有没有在本页动过下拉框：动过就一律以本页为准，不再被全局设置改写。
      const touched = useRef(false);
      // busy 的同步副本：onClick 现在要先等目录/全局设置回来，期间组件可能已重渲染，
      // 靠 state 闭包判断「在飞」会漏放第二条请求。
      const busyRef = useRef(false);

      // 面板一打开就把目录拉回来（与 onClick 里的 await 共用同一个 60s 缓存请求）：
      // 点击链路万一没走到，下拉框也不会永远只剩「跟随会话模型」一项。
      useEffect(() => {
        if (!open) return;
        let alive = true;
        loadCatalog().then((value) => {
          if (!alive) return;
          setCat(value);
          setCatErr("");
          if (value?.usage) setStats(value.usage);
        }, (e) => {
          if (alive) setCatErr(String(e?.message ?? e));
        });
        return () => { alive = false; };
      }, [open]);

      useEffect(() => () => {
        clearTimeout(timer.current);
        // L7：卸载（换会话、切页面）时把还挂着的请求掐掉。宿主的超时是 60s，不取消的话
        // 响应回来会往已经不存在的组件里塞状态；重新生成时也可能盖掉新结果。
        abortRef.current?.abort();
      }, []);

      // 面板 right:0 贴着图标往左展开，图标太靠左就整块出屏（桌面端左侧栏一开必现）。
      // 开面板时量一次，左溢出多少就右移多少：面板左缘 = wrap 右缘 - 面板宽，
      // 所以要跟 wrap 的 right 比，不是 left。面板宽度由 CSS 定死（min(420px, 100vw-48px)），
      // 内容变化不影响它 → 只需 open 变化和 resize 时夹，不需要 ResizeObserver。
      const wrapRef = useRef(null);
      // 在途 POST 的取消把手（L7）。必须排在 wrapRef 之后：自测的假 useRef 只把「第一个 null
      // 引用」当 .po-wrap 节点，顺序反了它就会拿到假 DOM（换成无参 useRef 也能避开）。
      const abortRef = useRef(null);
      const clampPanel = useCallback(() => {
        const wrap = wrapRef.current;
        const panel = wrap?.querySelector(".po-panel");
        if (!panel) return;
        const over = 8 + panel.offsetWidth - wrap.getBoundingClientRect().right;
        // 不位移时删掉变量而不是置空串：var(--po-shift, 0px) 拿到空串会让整条
        // transform 变成 invalid，行为依赖「失效即 none」而不是我们想要的 0。
        if (over > 0) panel.style.setProperty("--po-shift", Math.ceil(over) + "px");
        else panel.style.removeProperty("--po-shift");
      }, []);
      useEffect(() => {
        if (!open) return;
        clampPanel();
        window.addEventListener("resize", clampPanel);
        return () => window.removeEventListener("resize", clampPanel);
      }, [clampPanel, open]);

      const flash = useCallback((message) => {
        setMsg(message);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setMsg(""), 5000);
      }, []);

      const close = useCallback(() => {
        setOpen(false);
        setMsg("");
      }, []);

      const run = useCallback(async (text, model) => {
        // L7：一次请求一个 AbortController，signal 交给 fetch（取消路径见挂载 effect 的清理）。
        const abort = new AbortController();
        abortRef.current = abort;
        try {
          // L8：带上按钮所在会话的 id（宿主据此解析按会话的模型/路由）。拿不到就不带字段，
          // 由宿主回落到全局「当前会话」/兜底键。
          // 三态协议：选了具体模型就报 model；选了「跟随会话模型」要显式报 follow:true ——
          // 不报的话宿主会拿插件详情页的全局设置兜底，把聊天页里的选择盖掉。
          const payload = model === FOLLOW_SESSION ? { text, follow: true } : { text, model };
          payload.style = style;
          if (tpl) payload.template = true;
          if (sessionId !== "") payload.sessionId = sessionId;
          const res = await fetch(routeUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: abort.signal,
          });
          const data = await res.json().catch(() => null);
          if (data?.ok !== true || typeof data?.value?.text !== "string") {
            throw new Error(String(data?.error?.message ?? `请求失败（${res.status}）`));
          }
          return data.value; // 连 used（本次用量）一起带回，generate 里落到 stats
        } finally {
          if (abortRef.current === abort) abortRef.current = null;
        }
      }, [sessionId, style, tpl]);

      // 生成 / 重新生成：每次都读当下草稿，所以改完再点「重新生成」会以新草稿重写。
      const generate = useCallback(async () => {
        if (busyRef.current) return;
        if (isBlank(inputDraft)) {
          flash("输入框是空的，先写点东西");
          return;
        }
        const text = inputDraft.trim();
        busyRef.current = true;
        setBusy(true);
        setMsg(BUSY_MSG);
        try {
          const value = await run(text, target.current);
          setDraft(value.text);
          // 面板只显示这一次的输入/输出；累计值在设置页（老宿主不返回 used 就不显示）。
          if (value.used) setStats(value.used);
        } catch (e) {
          flash("生成失败：" + String(e?.message ?? e));
          console.warn("[prompt-optimizer] 请求失败", e);
        } finally {
          busyRef.current = false;
          setBusy(false);
          // 只清自己那条「生成中」，失败提示（flash 有 5 秒自清）不能被顺手抹掉。
          setMsg((m) => (m === BUSY_MSG ? "" : m));
        }
      }, [busy, flash, inputDraft, run]);

      // 本页的初始模型：本页选过 → 用它；没选过 → 插件详情页的全局设置；都没有 → 跟随会话。
      const syncFromSettings = (value) => {
        if (touched.current) return; // 用户在本页动过：一律以本页为准
        const raw = readPagePick(sessionId);
        if (raw !== "") {
          const stored = pickToSel(raw);
          setSel(stored);
          target.current = splitPick(stored);
          return;
        }
        const pref = value?.model;
        if (pref && pref.provider && pref.model) {
          setSel(pref.provider + "/" + pref.model);
          target.current = { provider: pref.provider, model: pref.model };
        }
      };

      const onClick = useCallback(async () => {
        if (open) {
          close();
          return;
        }
        // 空草稿一个请求都不发（含目录 GET），只开面板说明原因——这条要排在拉目录之前。
        if (isBlank(inputDraft)) {
          setOpen(true);
          flash("输入框是空的，先写点东西");
          return;
        }
        setOpen(true);
        // 等目录/全局设置回来期间先占住「在飞」并显示进度：这个窗口里连点不能发出第二次请求，
        // 面板也不能看起来毫无反应（用户报过的「点了没反应」）。拿到结果后交给 generate。
        busyRef.current = true;
        setMsg(BUSY_MSG);
        // 先让「用哪个模型」定下来再发改写请求：否则第一次请求会因为下拉框还停在
        // 「跟随会话模型」而用了会话模型，面板随后却显示全局设置里的那个——看到的和用上的不一致。
        // 目录拿不到不影响改写（catch 里照样往下走）。
        await loadCatalog().then((value) => {
          setCat(value);
          setCatErr("");
          if (value?.usage) setStats(value.usage);
          syncFromSettings(value);
        }, (e) => {
          // 拿不到目录不挡改写（老行为），但要留痕：面板会写明为什么下拉框是空的。
          setCatErr(String(e?.message ?? e));
        });
        busyRef.current = false;
        await generate();
      }, [close, generate, inputDraft, open, sessionId]);

      // 「用这条」写回草稿。宿主 inputActions.setDraft 的语义是「替换整段草稿」
      // （占位符清洗、换行拆段、光标落在末尾），正好是用户要的「把原内容换掉」。
      // 别用 insertText：它替换的是你传进去的 span，而 captureInsertion() 给的是
      // 光标位置（塌缩 span），实测会把结果追加到原文后面——不是用户要的。
      // insertText 成功时宿主返回 undefined，被拒（revision 漂移）时返回 false，
      // 两者都可能，所以先问函数在不在。
      const adopt = useCallback(() => {
        if (isBlank(draft)) {
          flash("提示词是空的");
          return;
        }
        const next = draft.trim();
        if (typeof inputActions?.setDraft === "function") {
          inputActions.setDraft(next);
        } else if (typeof inputActions?.insertText === "function") {
          // 老宿主没有 setDraft：给整段 span（不是光标 span），一样是替换而非追加。
          const span = { start: 0, end: inputDraft.length, draftRev };
          if (inputActions.insertText(next, span) === false) {
            flash("草稿已变动，写不进去，请手动复制");
            console.warn("[prompt-optimizer] insertText 被宿主拒绝", { span });
            return;
          }
        } else {
          // 不 close()：close 会清掉 msg，提示就一闪而过，等于没提示。
          flash("拿不到输入框接口，请手动复制");
          console.warn("[prompt-optimizer] inputActions 缺失，无法写回草稿", { inputActions });
          return;
        }
        close();
      }, [close, draft, draftRev, flash, inputActions, inputDraft]);

      // M4：Esc 关面板。挂在 wrap（根节点）上而不是 .po-panel 上——点开面板后焦点还在
      // 图标按钮上，而 panel 自己不可聚焦，挂在 panel 上永远接不到 Esc；wrap 同时包住
      // 按钮和面板内所有控件，focus 在哪都逃不出它。
      const onKeyDown = useCallback((e) => {
        if (!open || e?.key !== "Escape") return;
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        close();
      }, [close, open]);

      const kids = [
        h(
          "button",
          {
            type: "button",
            className: "po-btn",
            title: "优化提示词",
            "aria-label": "优化提示词",
            "aria-expanded": open,
            disabled: busy,
            onClick,
          },
          h("img", { className: "po-icon", src: ICON_SRC, alt: "", draggable: false }),
        ),
      ];
      if (open) {
        const flat = flattenCatalog(cat);
        kids.push(
          h(
            "div",
            { className: "po-panel", role: "dialog", "aria-label": "优化后的提示词" },
            h(
              "div",
              { className: "po-row" },
              h("span", { className: "po-title" }, "优化后的提示词（改完可重新生成）"),
              h(
                "select",
                {
                  className: "po-model",
                  title: "默认跟随会话模型",
                  value: sel,
                  onChange: (e) => {
                    const picked = flat.find((o) => o.value === e.target.value);
                    touched.current = true;
                    setSel(e.target.value);
                    target.current = picked === undefined ? FOLLOW_SESSION : { provider: picked.provider, model: picked.model };
                    // 记在聊天页里（按会话 id）：同一页刷新/重开面板都以它为准，全局设置不再覆盖。
                    writePagePick(sessionId, e.target.value);
                  },
                },
                h("option", { key: "po-follow", value: FOLLOW_SESSION }, "跟随会话模型"),
                ...flat.map((o) => h("option", { key: o.value, value: o.value }, o.label)),
              ),
              h("button", { type: "button", className: "po-act", onClick: close }, "关闭"),
            ),
            h(
              "div",
              { className: "po-row" },
              h("span", { className: "po-title" }, "风格"),
              h(
                "select",
                {
                  className: "po-model",
                  "aria-label": "改写风格",
                  title: "改写风格（标准 / 审查型 / 精简 / 角色设定）",
                  value: style,
                  onChange: (e) => setStyle(e.target.value),
                },
                ...STYLE_OPTIONS.map(([v, label]) => h("option", { key: v, value: v }, label)),
              ),
              h(
                "label",
                { className: "po-tpl", title: "把具体值抽成 {{变量}}，方便复用" },
                h("input", { type: "checkbox", checked: tpl, onChange: (e) => setTpl(e.target.checked) }),
                "可复用模板",
              ),
            ),
            ...cat === null && catErr ? [h("div", { className: "po-row" }, h("span", { className: "po-msg" }, "模型列表没加载上：" + catErr))] : [],
            h("textarea", {
              className: "po-text",
              value: draft,
              spellCheck: false,
              "aria-label": "生成后的提示词",
              onChange: (e) => setDraft(e.target.value),
            }),
            ...stats === null ? [] : [
              h("div", { className: "po-row" },
                h("span", { className: "po-stats", title: statsTitle(stats) }, statsText(stats))),
            ],
            ...tpl && placeholders(draft).length > 0 ? [
              h("div", { className: "po-row" },
                h("span", { className: "po-vars" }, "变量：" + placeholders(draft).map((v) => "{{" + v + "}}").join("、"))),
            ] : [],
            h(
              "div",
              { className: "po-row" },
              h("span", { className: "po-msg" }, msg),
              h("button", { type: "button", className: "po-act", onClick: adopt }, "用这条"),
              h("button", { type: "button", className: "po-act", disabled: busy, onClick: generate }, "重新生成"),
            ),
          ),
        );
      }
      return h("span", { ref: wrapRef, className: "po-wrap", onKeyDown }, ...kids);
    }

    exports.apply = apply;
    exports.inject = inject;
    return exports;
  },
});
