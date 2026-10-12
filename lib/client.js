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
      .po-wrap {
        display: inline-flex; align-items: center; gap: 4px;
        flex: none;
      }
      /* 作用域根必须是 .po-wrap：data-plugin-css 打在 <style> 标签自己身上，
         它不在按钮的祖先链里，用它做前缀的规则一条都匹配不上——图标外那圈框
         就是规则全失效后露出的浏览器默认 button 样式（2px outset + 6px padding）。 */
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
      .po-wrap .po-err {
        max-width: 260px;
        color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 16px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
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
            // insertText 成功时宿主返回 undefined，被拒（revision 漂移）时返回 false。
            // 所以「函数不存在」和「写成功」在返回值上分不开——必须先问函数在不在，
            // 否则 props 缺失会静默走完：既没写回草稿，也没有任何提示。
            const canInsert = typeof inputActions?.insertText === "function";
            const rejected = canInsert && inputActions.insertText(next, span) === false;
            if (!rejected && canInsert) {
              flash("已改写");
            } else if (typeof inputActions?.setDraft === "function") {
              // 写回草稿（可撤销）；revision 漂移或 insertText 缺失都走这里。
              inputActions.setDraft(next);
              flash(rejected ? "草稿刚改过，结果按整段写回" : "已改写");
            } else {
              flash("拿不到输入框接口，结果请手动复制");
              console.warn("[prompt-optimizer] inputActions 缺失，无法写回草稿", { span, inputActions });
            }
            return;
          }
          flash(String(data?.error?.message ?? `请求失败（${res.status}）`));
        } catch (e) {
          flash("点不动：" + String(e?.message ?? e));
          console.warn("[prompt-optimizer] 请求失败", e);
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
