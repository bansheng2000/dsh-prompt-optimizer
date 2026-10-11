// 客户端：在聊天输入框右边（conversation.input.right）加一个「优化提示词」按钮。
// 点击：取当前草稿 → POST 宿主路由 → 把结果整段替换回输入框。
// 由 window.__ModuleLoader__ 以 UMD 形工厂加载，React 从宿主模块表拿。
window.__ModuleLoader__.load({
  id: "dsh-prompt-optimizer",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const inject = ["slots"];

    const SLOT = "conversation.input.right";
    const ENTRY_ID = "prompt-optimizer";

    const STYLE = `
      [data-plugin-css="po"] .po-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; flex: none; padding: 0;
        border: var(--dsw-alias-border-w-1) solid var(--dsw-selector-border-color);
        border-radius: var(--dsw-alias-border-radius-sm);
        background: var(--dsw-alias-bg-thin);
        color: var(--dsw-alias-text-main);
        cursor: pointer; font-size: 13px; line-height: 1;
        transition: background var(--dsw-anim-duration-fast) var(--dsw-anim-ease-default);
      }
      [data-plugin-css="po"] .po-btn:hover:not(:disabled) { background: var(--dsw-selector-bg-hover); }
      [data-plugin-css="po"] .po-btn:disabled { opacity: 0.55; cursor: not-allowed; }
      [data-plugin-css="po"] .po-err {
        max-width: 260px; padding: 0 var(--dsw-alias-gutter-sm);
        color: var(--dsw-alias-text-error); font-size: 12px; line-height: 16px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
    `;

    function routeUrl() {
      const url = new URL("prompt-optimizer/api", document.baseURI);
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
        ctx.slots.register(
          {
            name: SLOT,
            id: ENTRY_ID,
            order: 50,
            label: "优化提示词",
          },
          () => OptimizeButton(),
        ),
        undefined,
        undefined,
      );
    }

    function OptimizeButton(props) {
      const useInput = props?.useInput;
      const inputActions = props?.inputActions;
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState("");
      const timer = useRef(0);

      useEffect(() => () => clearTimeout(timer.current), []);

      const flash = useCallback((message) => {
        setErr(message);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setErr(""), 5000);
      }, []);

      const onClick = useCallback(async () => {
        if (busy) return;
        setErr("");
        const text = String(useInput?.((s) => s?.detectText) ?? "").trim();
        if (text === "") {
          flash("输入框是空的，先写点东西");
          return;
        }
        setBusy(true);
        try {
          const res = await fetch(routeUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          });
          const data = await res.json().catch(() => null);
          if (data?.ok === true && typeof data?.value?.text === "string") {
            const next = data.value.text;
            const draftRev = useInput?.((s) => s)?.rev;
            const span = { start: 0, end: text.length, draftRev };
            const inserted = inputActions?.insertText?.(next, span);
            if (inserted === false) flash("草稿刚改过，改写已复制到预览，点一下文本框再试");
            return;
          }
          flash(String(data?.error?.message ?? `请求失败（${res.status}）`));
        } catch (e) {
          flash(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      }, [busy, flash, inputActions, useInput]);

      return h(
        "span",
        null,
        h(
          "button",
          {
            type: "button",
            className: "po-btn",
            title: "优化提示词",
            "aria-label": "优化提示词",
            disabled: busy,
            onClick,
          },
          busy ? "…" : "✦",
        ),
        err ? h("span", { className: "po-err", title: err }, err) : null,
      );
    }

    exports.apply = apply;
    exports.inject = inject;
  },
});
