const fs = await import("node:fs/promises");
const [, , fileUrl, outDir] = process.argv;
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await new Promise((r) => { ws.onopen = r; });
const CASES = [
  { n: "01-desktop-1920x1080", w: 1920, h: 1080, x: -1 },
  { n: "02-desktop-1440x900",  w: 1440, h: 900,  x: -1 },
  { n: "03-laptop-1366x768",  w: 1366, h: 768,  x: -1 },
  { n: "04-laptop-1280x720",  w: 1280, h: 720,  x: -1 },
  { n: "05-small-1024x640",   w: 1024, h: 640,  x: -1 },
  { n: "06-narrow-900x600",   w: 900,  h: 600,  x: -1 },
  { n: "07-tablet-820x1180",  w: 820,  h: 1180, x: -1 },
  { n: "08-short-1200x420",   w: 1200, h: 420,  x: -1 },
  { n: "09-sidebar-icon-x300", w: 1600, h: 900, x: 300 },
  { n: "10-sidebar-icon-x100", w: 1600, h: 900, x: 100 },
  { n: "11-icon-left-x40",    w: 1440, h: 900,  x: 40 },
  { n: "12-icon-center-x700", w: 1440, h: 900,  x: 700 },
  { n: "13-mobile-390x844",  w: 390,  h: 844,  x: -1 },
  { n: "14-mobile-360x640",  w: 360,  h: 640,  x: -1 },
  { n: "15-tablet-700x1000", w: 700,  h: 1000, x: -1 },
  { n: "16-breakpoint-640x900", w: 640, h: 900, x: -1 },
  { n: "17-breakpoint-641x900", w: 641, h: 900, x: -1 },
  { n: "18-very-short-1200x300", w: 1200, h: 300, x: -1 },
  { n: "19-short-1024x320", w: 1024, h: 320, x: -1 },
  { n: "20-short-wide-1600x360", w: 1600, h: 360, x: -1 },
];
const out = [];

for (const c of CASES) {
  await send("Emulation.setDeviceMetricsOverride", { width: c.w, height: c.h, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: fileUrl + "?x=" + c.x });
  await new Promise((r) => setTimeout(r, 300));
  const b = JSON.parse((await send("Runtime.evaluate", { expression: "JSON.stringify(window.__probe())", returnByValue: true })).result.value);
  const P = b.panel, bad = [];
  // 夹取后必须整体在视口内
  if (P.left < 0) bad.push("LEFT-OUT(" + P.left + ")");
  if (P.right > b.vw + 0.5) bad.push("RIGHT-OUT");
  if (P.top < 0) bad.push("TOP-OUT");
  if (P.bottom > b.vh + 0.5) bad.push("BOTTOM-CLIPPED");
  for (const [i, r] of b.rows.entries()) if (r && (r.left < P.left - 0.5 || r.right > P.right + 0.5)) bad.push("row" + i + "-overflow");
  if (b.text && b.text.bottom > P.bottom + 0.5) bad.push("textarea-clip");
  const fixedBy = b.unclamped.left < 0 ? "shift+" + b.shift + "px" : "no-shift-needed";
  out.push([c.n.padEnd(22), (b.vw + "x" + b.vh).padEnd(10),
    ("before[" + b.unclamped.left + ".." + b.unclamped.right + "]").padEnd(22),
    ("after[" + P.left + ".." + P.right + "]").padEnd(22), "w" + P.width, fixedBy.padEnd(16),
    bad.join("+") || "OK"].join("  "));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(outDir + "/" + c.n + ".png", Buffer.from(shot.data, "base64"));
}
console.log(out.join("\n"));
ws.close();
