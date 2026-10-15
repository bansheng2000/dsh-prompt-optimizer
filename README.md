# dsh-prompt-optimizer

在 DSH 聊天输入框右侧加一个按钮，把口语化需求一键改写成结构化提示词。点一下，**面板在图标上方弹出来**：生成的提示词直接可见、可改、可重新生成，确认满意再写回输入框。

## 效果

输入框右侧多一个图标按钮（`conversation.input.right` slot，order 50）。图标是名侦探柯南主题横幅（源图 2500×1677，3:2），缩到 40px 高 → 以 data URI 内联进 `lib/client.js`（client bundle 没有静态文件服务）。CSS 只锁高度、宽度自适应，换源图也不会被压变形。

- 点它 → 读当前草稿 → POST 宿主路由改写 → **面板弹出**，文本框里就是改写结果。
- 面板右上角下拉框选模型，首项「跟随会话模型」即默认（跟随会话当前 provider/model）。
- 文本框随便改；「重新生成」按**当下草稿**再跑一遍（不是拿面板里的旧文本）。
- 「用这条」把文本框内容写回输入框，然后收起面板。
- 空草稿：面板照弹（让人看见为什么没结果），不发请求，红字说明原因。
- 拿不到输入框接口（`inputActions` 缺失）：提示手动复制，面板**不关**——关了就什么都看不到。
- 拉不到模型目录不影响改写，下拉框退回只有「跟随会话模型」。

## 安装

从 GitHub 装（换一台电脑也是这样）：

```bash
# 1) 在 DSH profile 目录（~/.dsh/profiles/<name>）里加依赖
pnpm add github:bansheng2000/dsh-prompt-optimizer
# 2) 把 "dsh-prompt-optimizer" 加进该 profile package.json 的 dsh.profile.bundles 数组
# 3) 重启 DSH
```

宿主条目 `prompt-optimizer` 由包内 `cordis.patch.yml`（`- insert:` 形态）自动注册，不需要手写宿主配置。装完输入框右侧就有图标按钮。

本地开发：profile 的 `node_modules` 是**真实拷贝不是 symlink**，改完仓库里的 `lib/*.js` 必须重新跑 `pnpm install` 或手工 `Copy-Item` 到 profile 才生效。改宿主侧 `lib/index.js` 还要重启 DSH（客户端 bundle 刷新页面即可）。

## 配置

`cordis.patch.yml` 里 `config.rules`，两个可选键：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxInputChars` | 8000 | 草稿超过该长度直接 413，不调 LLM |
| `timeoutMs` | 60000 | 单次改写超时 |
| `maxTokens` | 4096 | 单次输出预算（推理模型会先把预算花在 reasoning 上，别往下调） |
| `price` | 不设 | 单价，用来算费用；格式见下文「用量统计」。**不设就只显示 token** |

模型选择**不持久化**——每次开面板跟随会话模型，选了别的只对本次生效。这是刻意的：持久化要另接 settings 桥，目前没这个需求。

## 用量统计

面板底部有一行用量：

```
累计 token：输入 12.3K · 输出 567 · 合计 2.1M（缓存读 200 / 写 0） · 成功 1 / 尝试 2 · 约 0.0123 CNY
```

数字超过 1000 就缩成 `K`/`M`/`B`（`1234` → `1.2K`、`2001` → `2K`、`1234567890` → `1.2B`），一行放得下；**精确值在悬停提示里**。
悬停先讲统计范围（哪一段账、何时起算、不含什么），再给逐项精确到个位的数字，最后是单价来源。

**口径**（宿主 `TokenUsage` 的定义，asar 实测：`usage.totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`）：

- `输入` = 非缓存输入 token（`inputTokens`）、`输出` = 输出 token（`outputTokens`），缓存读/写单独标出，`合计` = 四项之和。
- 输入/输出**分开写**是刻意的：两者单价常差一个数量级，合并成一个「token 数」就看不出钱花在哪。
- `成功 N / 尝试 M`：M > N 说明有白花的调用（空响应自动重试那一次也算一次尝试）。

**范围**：只统计**本插件自己发起的改写请求**（不含你平时的聊天），且是**进程内累计**——自 DSH 启动起跨会话求和，**重启归零**。悬停提示里带起算时间；不落盘。
要跨重启的长期账单得另写 profile 数据目录，目前没这个需求（`lib/index.js` 的 `LEDGER` 处留了 `ponytail:` 说明）。

**费用**：代码里**没有任何价格常量**，单价只从 profile 配置读；没配就只显示 token（接口里 `cost: null`、`priceSource: null`），**不猜价**。

```yaml
# <profile>/cordis.patch.yml —— prompt-optimizer 条目的配置覆盖层
- id: prompt-optimizer
  name: "dsh-prompt-optimizer"
  config:
    rules:
      # 单位：currency / 百万 token（与 pi-ai 的 model.cost 同口径）
      price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3, currency: CNY }
```

填对价钱是你的事：插件不知道你在用哪家 provider、什么价目表。该数字填错只会让账算错，不会影响改写本身。改完配置要**重启 DSH**（bundle 配置是启动期读的）。

**核对**：`GET /prompt-optimizer/api` 会连台账一起返回（`value.usage`），可拿来跟界面上那行对照。

## 文件
- `lib/index.js` — 宿主侧：`kind: "exact"` 路由 `/prompt-optimizer/api`。`GET` → 模型目录 + 用量台账（`value.usage`）；`POST {text, model?}` → `{ok:true, value:{text, model, usage}}`，`model` 缺省即跟随会话。台账 `LEDGER` 也在这一文件。
- `lib/client.js` — 浏览器侧 `window.__ModuleLoader__.load` 工厂：注册 `conversation.input.right` slot 条目 `prompt-optimizer`，并注入以 `.po-wrap` 为作用域根的样式。
- `lib/optimize.js` — 纯逻辑（校验 / 剥围栏 / system prompt / `pickModel`），不 import 宿主，可单独自测。
- `test/selftest.mjs` — `node test/selftest.mjs`，不连宿主。
- `test/layout-probe.html` + `test/cdp-probe.mjs` — 布局探针：真 Edge headless + CDP，把 client.js 的真 STYLE 灌进页面量面板边界，跨 20 种视口比例（桌面/小窗/平板/超宽矮窗/手机/断点两侧 + 图标位置 x=40/100/300/700）断言不出屏。`node test/cdp-probe.mjs <probe-url> <出图目录>`，截图落在 `test/shots/`（已 gitignore）。

## 宿主契约（踩过的坑）

- 路由路径必须以 `/` 开头：宿主 `WebServer.match()` 按 pathname 查 exact 表，无前导斜杠的 key 永远匹配不上，点击静默无反应。
- CSS 作用域必须落在**自己渲染的真实祖先**（`.po-wrap`）上。`data-plugin-css` 是打在 `<style>` 标签自己身上的去重标记，不在祖先链里，拿它做前缀会让所有规则静默失效。
- `--dsw-*` token 名以 asar 实测为准（423 个），拼错同样静默失效。测试里有白名单挡着。
- 面板不能靠第二个 slot 承载：宿主 `conversation.input.overlay` 锚点是 `height:0;position:absolute`，所以面板绝对定位挂在现有 `.po-wrap` 内。宿主 `.RlGAzG_card` 没有 `overflow:hidden`，不会被裁掉。
- `inputActions.insertText` 成功时返回 `undefined`，被拒（revision 漂移）时返回 `false`——两者都可能，必须先 `typeof` 判断函数在不在，否则 props 缺失会静默走完。
- **写回整段草稿只能用 `setDraft`。** `insertText(span, text)` 替换的是**你传进去的那个 span**，而 `captureInsertion()` 返回的是光标位置（塌缩 span）——用它会把改写结果追加到原文**后面**。`setDraft(text)` 的语义是「替换整段草稿」（清空 → 按换行拆段重写 → 光标落到末尾），才是「把原内容换掉」。
- 客户端 hook 只能在渲染期调用：`props.useInput` 是宿主 `materializeStandardBinding` 生成的 React selector hook（`useSyncExternalStoreWithSelector`），写进 `onClick`/`async` 回调会抛 hook 规则错误并被未处理 rejection 吞掉，表现为「点了没反应」。
- 窄屏不能按图标对齐面板：宿主在 `<=640px` 会重排输入框那一行，图标可能落到屏幕最左，`absolute + right:0` 的面板必然出屏。用 `position:fixed` + `left/right` 双向锚定贴视口，并显式把 base 的 `bottom` 盖成 `auto`。
- **桌面端面板出屏**：面板 `right: 0` 贴图标往左展开 420px，图标离视口左边不够一整面板宽时整块出屏（左侧栏一开必现）。解法是 `transform: translateX(var(--po-shift, 0px))` + 开面板时按锚点**右缘**算左溢出：`8 + panel.offsetWidth - wrap.getBoundingClientRect().right`。两条细节：清零必须 `removeProperty`（赋空串会让 `var()` 解析失败，整条 `transform` 变 invalid）；算溢出必须用锚点**右缘**（`right:0` 时面板左缘 = 锚点右缘 - 面板宽，用 `left` 算会整块偏一个面板宽）。窄屏 `@media` 里补 `transform: none`。
