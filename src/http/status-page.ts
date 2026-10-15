export function statusPageHtml(opts: {
  mode: string;
  host: string;
  port: number;
  healthy: boolean;
  sessions: number;
  requests: number;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Relay Bridge</title>
  <style>
    :root { color-scheme: dark; --bg:#0f1419; --card:#1a222b; --ink:#e8eef4; --muted:#93a1b1; --ok:#3dd68c; --warn:#f5c16c; --line:#2a3542; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: "IBM Plex Sans", "Noto Sans SC", sans-serif; background: radial-gradient(1200px 600px at 10% -10%, #1c3a4d, var(--bg)); color: var(--ink); }
    main { max-width: 920px; margin: 0 auto; padding: 32px 20px 64px; }
    h1 { font-size: 1.8rem; margin: 0 0 8px; }
    p { color: var(--muted); line-height: 1.55; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap:12px; margin: 24px 0; }
    .card { background: var(--card); border:1px solid var(--line); border-radius: 14px; padding:16px; }
    .label { font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
    .value { font-size:1.4rem; margin-top:8px; }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    code { background:#0d1217; padding:2px 6px; border-radius:6px; }
    a { color:#8fd0ff; }
    ul { color: var(--muted); }
    @media (max-width: 640px) { h1 { font-size:1.4rem; } }
  </style>
</head>
<body>
  <main>
    <h1>Relay Bridge</h1>
    <p>本机 Anthropic Messages 兼容入口，按 T3 Code 方式接入官方 Claude Agent SDK：<code>systemPrompt</code> 用 <code>claude_code</code> 预设再追加 Droid 说明；Claude Code 自己执行 Read/Edit/Bash；只有 Mission 等 Droid 专有工具走 MCP。本环境默认 BYOK（MiniMax / GLM），<code>BRIDGE_AUTH=subscription</code> 不改写 <code>ANTHROPIC_*</code>。</p>
    <div class="grid">
      <div class="card"><div class="label">Health</div><div class="value ${opts.healthy ? "ok" : "warn"}">${opts.healthy ? "ok" : "down"}</div></div>
      <div class="card"><div class="label">Mode</div><div class="value">${escapeHtml(opts.mode)}</div></div>
      <div class="card"><div class="label">Listen</div><div class="value">${escapeHtml(opts.host)}:${opts.port}</div></div>
      <div class="card"><div class="label">Sessions</div><div class="value">${opts.sessions}</div></div>
      <div class="card"><div class="label">Recorded requests</div><div class="value">${opts.requests}</div></div>
    </div>
    <div class="card">
      <div class="label">Endpoints</div>
      <ul>
        <li><code>GET /healthz</code> 健康检查</li>
        <li><code>POST /v1/messages</code> Anthropic Messages JSON / SSE</li>
        <li><code>POST /v1/messages/count_tokens</code> 明确不支持精确计数</li>
        <li><code>GET /internal/sessions</code> 管理接口，需要管理员令牌</li>
      </ul>
      <p><code>mock</code> / <code>fake</code> 零上游费用。<code>sdk</code> + <code>BRIDGE_AUTH=byok</code> 把 Claude Code 指到已探测的兼容端点。<code>BRIDGE_AUTH=subscription</code> 使用本机 Claude 登录。不要把 <code>ANTHROPIC_BASE_URL</code> 指回本 Bridge。</p>
    </div>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
