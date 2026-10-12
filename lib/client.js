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

    // 图标：dsh-image-gen(google-sub/Antigravity) 生成后去白底、预乘缩到 32px 内联成 data URI
    // （client bundle 没有静态文件服务，也不能 require 宿主资源包）。
    const ICON_SRC = "data:image/png;base64,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";

    const STYLE = `
      [data-plugin-css="po"] .po-wrap {
        display: inline-flex; align-items: center; gap: var(--dsw-alias-gutter-sm);
        flex: none;
      }
      [data-plugin-css="po"] .po-icon { width: 16px; height: 16px; display: block; flex: none; }
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
        max-width: 260px;
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
        ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: 50, label: "优化提示词" }, OptimizeButton),
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
        // InputState 字段是 draft（clipboardText 投影，@see compose()），不是 detectText。
        const text = String(useInput?.((s) => s?.draft) ?? "").trim();
        if (text === "") {
          flash("输入框是空的，先写点东西");
          return;
        }
        // 捕获选区 + draftRev 必须在 fetch 之前：异步回来后 inputActions.insertText
        // 只在 revision 未变时才插入（SessionInputShell.actions.insertText 的 tick 逻辑）。
        // draftRev 在 InputState 上叫 draftRev（不是 rev）。
        const span = inputActions?.captureInsertion?.() ?? {
          start: 0,
          end: text.length,
          draftRev: useInput?.((s) => s?.draftRev),
        };
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
            // 整段替换：草稿可能因为 span 是 [0,len) 而只替换前半段。
            const inserted = inputActions?.insertText?.(next, span);
            if (inserted === false) {
              // revision 变了：退回 setDraft 不强改草稿，结果仍写回草稿（用户可撤销）。
              if (inputActions?.setDraft) inputActions.setDraft(next);
              else flash("草稿刚改过，改写结果建议另存再试");
            }
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
        { className: "po-wrap" },
        err ? h("span", { className: "po-err", title: err }, err) : null,
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
          busy ? "…" : h("img", { className: "po-icon", src: ICON_SRC, alt: "", draggable: false }),
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return exports;
  },
});
