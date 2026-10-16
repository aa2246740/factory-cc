import { createHash } from "node:crypto";

// This page has no server-rendered session data or credentials. All untrusted
// tool/session strings are inserted with textContent after authentication.
const script = String.raw`
(() => {
  'use strict';
  let token = '';
  let generation = 0;
  let busy = false;
  let refreshing = false;
  let timer;
  let approvalSnapshot = '';
  let sessionSnapshot = '';
  const drafts = new Map();
  const $ = (id) => document.getElementById(id);
  const status = (message, error = false) => {
    $('status').textContent = message;
    $('status').className = error ? 'error' : '';
  };
  const element = (tag, value, className) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = String(value);
    if (className) node.className = className;
    return node;
  };
  function lock(message = '已断开。令牌已从页面内存清除。') {
    generation += 1;
    token = '';
    clearInterval(timer);
    approvalSnapshot = '';
    sessionSnapshot = '';
    drafts.clear();
    busy = false;
    refreshing = false;
    $('token').value = '';
    $('approvals').replaceChildren();
    $('sessions').replaceChildren();
    $('workspace').hidden = true;
    $('login').hidden = false;
    status(message);
  }
  async function request(path, body, currentGeneration) {
    if (!token || currentGeneration !== generation) throw new Error('连接已关闭，请重新连接。');
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (currentGeneration !== generation) throw new Error('连接已关闭，请重新连接。');
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        lock('管理员令牌无效或管理接口未启用。');
        throw new Error('管理员令牌无效或管理接口未启用。');
      }
      if (response.status === 409 || response.status === 404) throw new Error('请求已结束、过期或被处理。请刷新列表。');
      throw new Error('操作失败（HTTP ' + response.status + '）。请检查 Bridge 日志。');
    }
    return response.json();
  }
  const date = (value) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
  };
  function renderApproval(item, currentGeneration) {
    const card = element('article', undefined, 'card');
    card.append(element('h3', item.toolName));
    card.append(element('p', '会话：' + item.bridgeSessionId, 'identifier'));
    if (item.sdkSessionId) card.append(element('p', 'Claude Code：' + item.sdkSessionId, 'identifier'));
    card.append(element('p', '请求：' + item.id, 'identifier'));
    card.append(element('p', '到期：' + date(item.expiresAt), 'muted'));
    card.append(element('pre', JSON.stringify(item.input, null, 2)));
    const details = element('details');
    details.append(element('summary', '修改本次执行的输入（可选）'));
    const label = element('label', '完整 JSON 对象；只有点“允许一次”才会使用修改。');
    const input = element('textarea');
    input.rows = 8;
    input.spellcheck = false;
    const draft = drafts.get(item.id) || { value: JSON.stringify(item.input, null, 2), open: false };
    drafts.set(item.id, draft);
    input.value = draft.value;
    details.open = draft.open;
    input.addEventListener('input', () => { draft.value = input.value; });
    details.addEventListener('toggle', () => { draft.open = details.open; });
    label.append(input);
    details.append(label);
    card.append(details);
    const actions = element('div', undefined, 'actions');
    const allow = element('button', '允许一次');
    const deny = element('button', '拒绝', 'secondary');
    allow.type = deny.type = 'button';
    const decide = async (decision) => {
      if (busy || currentGeneration !== generation) return;
      let updatedInput;
      if (decision === 'allow' && input.value !== JSON.stringify(item.input, null, 2)) {
        try { updatedInput = JSON.parse(input.value); } catch { status('修改后的输入必须是有效 JSON。', true); return; }
        if (!updatedInput || typeof updatedInput !== 'object' || Array.isArray(updatedInput)) {
          status('修改后的输入必须是 JSON 对象。', true); return;
        }
      }
      busy = true;
      allow.disabled = deny.disabled = true;
      status('正在提交决定…');
      try {
        await request('/internal/approvals/' + encodeURIComponent(item.id), {
          decision, ...(updatedInput === undefined ? {} : { updatedInput }),
          ...(decision === 'deny' ? { message: 'User denied this request in Relay Bridge.' } : {}),
        }, currentGeneration);
        if (currentGeneration !== generation) return;
        card.remove();
        approvalSnapshot = '';
        status(decision === 'allow' ? '已允许本次执行。' : '已拒绝本次执行。');
      } catch (error) {
        if (currentGeneration === generation) status(error.message, true);
        // A transport failure may happen after the server accepted a decision.
        // Refresh before offering another action; never automatically retry it.
        approvalSnapshot = '';
      } finally {
        if (currentGeneration === generation) { busy = false; void refresh(); }
      }
    };
    allow.addEventListener('click', () => void decide('allow'));
    deny.addEventListener('click', () => void decide('deny'));
    actions.append(allow, deny);
    card.append(actions);
    return card;
  }
  function renderSession(item, currentGeneration) {
    const card = element('article', undefined, 'card compact');
    card.append(element('h3', item.role + ' · ' + item.state));
    card.append(element('p', item.bridgeSessionId, 'identifier'));
    if (item.sdkSessionId) card.append(element('p', 'Claude Code：' + item.sdkSessionId, 'identifier'));
    if (!['CANCELLED', 'FAILED', 'CLOSED', 'COMPLETED'].includes(item.state)) {
      const cancel = element('button', '取消会话', 'secondary');
      cancel.type = 'button';
      cancel.addEventListener('click', async () => {
        if (busy || currentGeneration !== generation) return;
        if (!window.confirm('取消会话 ' + item.bridgeSessionId + '？正在执行的任务会停止。')) return;
        busy = true;
        cancel.disabled = true;
        try {
          await request('/internal/cancel', { sessionId: item.bridgeSessionId }, currentGeneration);
          if (currentGeneration === generation) status('已请求取消会话。');
        } catch (error) {
          if (currentGeneration === generation) status(error.message, true);
        } finally {
          if (currentGeneration === generation) { busy = false; sessionSnapshot = ''; void refresh(); }
        }
      });
      card.append(cancel);
    }
    return card;
  }
  async function refresh() {
    if (!token || busy || refreshing) return;
    const currentGeneration = generation;
    refreshing = true;
    try {
      const [approvalData, sessionData] = await Promise.all([
        request('/internal/approvals', undefined, currentGeneration),
        request('/internal/sessions', undefined, currentGeneration),
      ]);
      if (currentGeneration !== generation || busy) return;
      if (!Array.isArray(approvalData.approvals) || !Array.isArray(sessionData.sessions)) throw new Error('管理接口返回了无法识别的数据。');
      const nextApprovals = JSON.stringify(approvalData.approvals);
      if (nextApprovals !== approvalSnapshot) {
        const liveIds = new Set(approvalData.approvals.map((item) => item.id));
        for (const id of drafts.keys()) if (!liveIds.has(id)) drafts.delete(id);
        $('approvals').replaceChildren(...approvalData.approvals.map((item) => renderApproval(item, currentGeneration)));
        if (!approvalData.approvals.length) $('approvals').append(element('p', '当前没有待审批的请求。', 'muted'));
        approvalSnapshot = nextApprovals;
      }
      const nextSessions = JSON.stringify(sessionData.sessions);
      if (nextSessions !== sessionSnapshot) {
        $('sessions').replaceChildren(...sessionData.sessions.map((item) => renderSession(item, currentGeneration)));
        if (!sessionData.sessions.length) $('sessions').append(element('p', '当前没有会话。', 'muted'));
        sessionSnapshot = nextSessions;
      }
      // Only the first successful refresh resolves the connection message.
      // Later polls must preserve approval/cancellation success and errors.
      if (!$('login').hidden) status('已连接。');
      $('login').hidden = true;
      $('workspace').hidden = false;
      $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString();
    } catch (error) {
      if (currentGeneration === generation) status(error.message, true);
    } finally {
      if (currentGeneration === generation) refreshing = false;
    }
  }
  $('login').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = $('token').value.trim();
    $('token').value = '';
    if (!value) { status('请输入 BRIDGE_ADMIN_TOKEN。', true); return; }
    lock('正在连接…');
    token = value;
    void refresh();
    timer = setInterval(() => void refresh(), 5000);
  });
  $('refresh').addEventListener('click', () => void refresh());
  $('lock').addEventListener('click', () => lock());
  window.addEventListener('pagehide', () => lock());
})();`;

const style = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
body { max-width: 960px; margin: auto; padding: 24px 20px 64px; }
h1 { margin-bottom: 8px; } h2 { margin-top: 32px; } h3 { margin: 0 0 10px; overflow-wrap: anywhere; }
p { margin: 8px 0; } .muted, small { opacity: .75; } .error { color: light-dark(#a31818,#ff9b9b); }
.card { border: 1px solid light-dark(#c8ced6,#46505f); border-radius: 10px; padding: 18px; margin: 14px 0; }
.identifier { overflow-wrap: anywhere; font: .85rem ui-monospace, monospace; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 14px; background: light-dark(#f2f4f7,#20262f); border-radius: 6px; max-height: 420px; overflow: auto; }
label { display: block; margin: 12px 0 6px; } input, textarea { display: block; width: 100%; box-sizing: border-box; margin: 8px 0; padding: 10px; font: inherit; }
textarea { font-family: ui-monospace, monospace; } button { cursor: pointer; border: 1px solid #1669bb; background: #1669bb; color: white; border-radius: 6px; padding: 10px 16px; font: inherit; }
button.secondary { color: inherit; background: transparent; border-color: light-dark(#768394,#a5b2c2); } button:disabled { cursor: wait; opacity: .55; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 16px; } summary { cursor: pointer; padding: 8px 0; }
:focus-visible { outline: 3px solid #59a6ff; outline-offset: 3px; } [hidden] { display: none !important; }
`;

/** Public shell only: credentials and session data are fetched separately. */
export function controlPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Relay Bridge · 执行审批</title><style>${style}</style></head>
<body>
<main>
<h1>执行审批</h1>
<p>查看 Claude Code 请求的操作，允许一次或拒绝，也可以取消正在执行的会话。</p>
<form id="login" class="card" autocomplete="off">
<label for="token">管理员令牌（BRIDGE_ADMIN_TOKEN）</label>
<input id="token" type="password" name="admin-token" autocomplete="off" autocapitalize="none" spellcheck="false" required>
<p class="muted">令牌只保留在此页面内存中，关闭或刷新页面后需重新输入。</p>
<button type="submit">连接</button>
</form>
<p id="status" role="status" aria-live="polite">连接后查看待审批请求。</p>
<div id="workspace" hidden>
<div class="actions"><button id="refresh" type="button" class="secondary">刷新</button><button id="lock" type="button" class="secondary">断开并清除令牌</button><small id="updated"></small></div>
<h2>待审批</h2><p class="muted">每个决定仅适用于显示的工具及输入。会话结束或请求过期后，决定不再生效。</p><div id="approvals"></div>
<h2>会话</h2><div id="sessions"></div>
</div>
</main><script>${script}</script>
</body></html>`;
}

/** Hashes permit only these fixed inline assets; tool data never becomes HTML. */
export function controlPageHeaders(): Record<string, string> {
  const hash = (value: string): string => `'sha256-${createHash("sha256").update(value).digest("base64")}'`;
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}
