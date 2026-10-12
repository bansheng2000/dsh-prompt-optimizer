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

    // 图标：名侦探柯南主题横幅（3:2），按比例缩到 40px 高内联成 data URI
    // （client bundle 没有静态文件服务，也不能 require 宿主资源包）。CSS 只锁高度，宽度自适应。
    const ICON_SRC = "data:image/png;base64,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";

    const STYLE = `
      [data-plugin-css="po"] .po-wrap {
        display: inline-flex; align-items: center; gap: var(--dsw-alias-gutter-sm);
        flex: none;
      }
      [data-plugin-css="po"] .po-icon { height: 20px; width: auto; display: block; flex: none; border-radius: 4px; }
      [data-plugin-css="po"] .po-btn {
        display: inline-flex; align-items: center; justify-content: center;
        flex: none; padding: 0;
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
