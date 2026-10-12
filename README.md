# dsh-prompt-optimizer

在 DSH 聊天输入框右侧加一个按钮，把输入框里的口语化需求（"白话"）一键改写成结构化提示词。prompt-optimizer 风格：点一下，草稿被改写后的提示词整段替换。

## 效果

聊天输入框右侧多一个图标按钮（`conversation.input.right` slot，order 50）。图标是名侦探柯南主题横幅（源图 2500×1677，3:2），按比例缩到 40px 高 → 以 data URI 内联进 `lib/client.js`（client bundle 没有静态文件服务）。CSS 只锁高度、宽度自适应，所以换源图也不会被压变形。

- 点它 → 读取当前草稿 → POST 宿主路由 → 用当前会话选中的 provider/model 改写 → 结果写回输入框。
- 空草稿：按钮旁提示「输入框是空的」，不发请求。
- 改写期间按钮变成 …，5 秒内的错误以红色小字显示在图标左边。
- 冲突（改写期间用户又改了草稿，宿主 `insertText` 的 `draftRev` 判定失败）：提示重试。

## 安装

在已安装本插件的 DSH profile 里（与 `dsh-free-search` 同目录）：

```bash
pnpm install
```
```

或用 `_ref/install-into-profile.mjs` 把仓库目录 junction 进 profile（注意：profile 的 node_modules 是真实拷贝，改完 `lib/*.js` 必须重新安装或手工拷贝才会生效）。

## 配置

`cordis.patch.yml` 里 `config.rules`，两个可选键：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `maxInputChars` | 8000 | 草稿超过该长度直接 413，不调 LLM |
| `timeoutMs` | 60000 | 单次改写超时 |

## 文件

- `lib/index.js` — 宿主侧：注册 `webServer` prefix 路由 `prompt-optimizer/api`，POST `{text}` → `{ok:true, value:{text}}`。
- `lib/client.js` — 浏览器侧 `window.__ModuleLoader__.load` 工厂：注册 `conversation.input.right` slot 条目 `prompt-optimizer`。
- `lib/optimize.js` — 纯逻辑（校验 / 剥围栏 / system prompt），不 import 宿主，可单独自测。
- `test/selftest.mjs` — `node test/selftest.mjs`，不连宿主。

## 自测

```bash
node test/selftest.mjs   # ok - lib/optimize.js self-test passed
```

## 注意

- 客户端 fetch 走 `new URL("prompt-optimizer/api", document.baseURI)`：GUI 挂在 `<base href="./">` 下，绝对路径会被反代目录前缀打偏。
- 颜色一律用 `--dsw-alias-*` / `--dsw-selector-*`，不写死色值，浅色深色主题都能跟上。
- 换图标：把新图按比例缩到高 40px（保持原始宽高比）→ base64 → 替换 `lib/client.js` 里的 `ICON_SRC`；CSS 高度（20px 显示）在同一处的 `.po-icon` 规则里改。自测会断言内联 PNG 的高度与比例，改尺寸时同步改断言。
