// MCP Streamable HTTP 端点 —— 挂在 /mcp
// 业务：暴露 hndcw.com 全国政府招投标/建设项目库查询工具，供 WorkBuddy 连接器（oc_*）调用。
// 复用本站 node:sqlite 单例连接（db/db.js），只读查询，无副作用。
// 传输：POST /mcp 收 JSON-RPC；默认返回 application/json，仅当客户端 Accept 只声明 text/event-stream 时回 SSE。
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/db.js';
import { ipRateLimit } from './mcpCommon.js';

const router = Router();

// 宽松 CORS：远程 MCP 若由浏览器端发起会先发 OPTIONS 预检，此处放行避免被拒
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 安全：公开端点限流（每 IP 每分钟 60 次，防匿名滥用）
router.use(ipRateLimit());

const PROTOCOL = '2024-11-05';
const SERVER_INFO = { name: 'hndcw-mcp', version: '1.0.0' };
const sessions = new Set();

const TOOLS = [
  {
    name: 'search_bidding_projects',
    description: '查询 hndcw.com 全国政府招投标/建设项目库。可按关键词、省份、城市、行业大类、预算区间筛选，返回项目标题、地区、预算(万元)、业主单位、阶段、公告日期与原文链接。适合"帮我找XX招标项目""查海口社会调查类标的"等问法。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '标题或摘要关键词，如"社会调查""信息化""海南"' },
        province: { type: 'string', description: '省名，如"海南""广东""广西"' },
        city: { type: 'string', description: '城市名，如"海口""三亚"' },
        industry: { type: 'string', description: '行业大类 A/B/C（工程/货物/服务），可不填' },
        minBudget: { type: 'number', description: '最小预算(万元)' },
        maxBudget: { type: 'number', description: '最大预算(万元)' },
        limit: { type: 'number', description: '返回条数，默认 10，最大 50' },
      },
    },
  },
];

function buildResult(rows) {
  if (!rows.length) {
    return { content: [{ type: 'text', text: '未找到符合条件的项目。' }], isError: false };
  }
  const lines = rows.map((r) => {
    const region = [r.province, r.city, r.district].filter(Boolean).join('·');
    const budget = r.budget_amount != null ? `${r.budget_amount}万` : '预算未披露';
    return [
      `- ${r.title}`,
      `  地区:${region || '—'}  行业:${r.industry || '—'}  预算:${budget}`,
      `  业主:${r.owner_unit || '—'}  阶段:${r.stage || '—'}  公告:${r.publish_date || '—'}`,
      `  原文:${r.source_url || '—'}`,
    ].join('\n');
  });
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
}

function callTool(name, args = {}) {
  if (name !== 'search_bidding_projects') {
    return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true };
  }
  const db = getDb();
  const clauses = ['status = 1'];
  const params = [];
  if (args.keyword) {
    clauses.push('(title LIKE ? OR summary LIKE ?)');
    params.push(`%${args.keyword}%`, `%${args.keyword}%`);
  }
  if (args.province) {
    clauses.push('province = ?');
    params.push(args.province);
  }
  if (args.city) {
    clauses.push('city = ?');
    params.push(args.city);
  }
  if (args.industry) {
    clauses.push('industry = ?');
    params.push(args.industry);
  }
  if (typeof args.minBudget === 'number') {
    clauses.push('budget_amount >= ?');
    params.push(args.minBudget);
  }
  if (typeof args.maxBudget === 'number') {
    clauses.push('budget_amount <= ?');
    params.push(args.maxBudget);
  }
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 50);
  const sql = `SELECT id, title, province, city, district, industry, owner_unit, stage, publish_date, budget_amount, source_url
    FROM projects WHERE ${clauses.join(' AND ')} ORDER BY publish_date DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit);
  return buildResult(rows);
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleRpc(body) {
  const list = Array.isArray(body) ? body : [body];
  const out = [];
  for (const msg of list) {
    const { id, method, params } = msg || {};
    if (!method) {
      out.push(fail(id, -32600, 'Invalid Request'));
      continue;
    }
    if (method === 'notifications/initialized') continue; // 通知，无响应
    switch (method) {
      case 'initialize':
        sessions.add(id);
        out.push(ok(id, {
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }));
        break;
      case 'ping':
        out.push(ok(id, {}));
        break;
      case 'tools/list':
        out.push(ok(id, { tools: TOOLS }));
        break;
      case 'tools/call':
        try {
          out.push(ok(id, callTool(params && params.name, (params && params.arguments) || {})));
        } catch (e) {
          out.push(fail(id, -32603, String((e && e.message) || e)));
        }
        break;
      default:
        out.push(fail(id, -32601, `Method not found: ${method}`));
    }
  }
  return out;
}

router.post('/', (req, res) => {
  const body = req.body;
  if (!body || (typeof body === 'object' && !body.jsonrpc && !Array.isArray(body))) {
    return res.status(400).json(fail(null, -32700, 'Parse error'));
  }
  const responses = handleRpc(body);
  if (responses.length === 0) return res.status(202).end(); // 纯通知

  const accept = req.get('accept') || '';
  const wantSSE = accept.includes('text/event-stream') && !accept.includes('application/json');
  const sid = randomUUID();
  res.setHeader('Mcp-Session-Id', sid);

  if (wantSSE) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    for (const r of responses) {
      res.write('event: message\n');
      res.write('data: ' + JSON.stringify(r) + '\n\n');
    }
    return res.end();
  }
  res.setHeader('Content-Type', 'application/json');
  if (Array.isArray(body)) res.json(responses);
  else res.json(responses[0]);
});

router.get('/', (req, res) => {
  // SSE 探测：声明 event-stream 的 GET 按规范保持流（本服务器无服务端主动推送，立即结束）
  const accept = req.get('accept') || '';
  if (accept.includes('text/event-stream') && !accept.includes('text/html')) {
    res.setHeader('Content-Type', 'text/event-stream');
    return res.end();
  }
  // 浏览器访问：友好介绍页（避免看起来像故障）
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toolRows = TOOLS.map(t => `
      <tr><td class="tn">${esc(t.name)}</td><td>${esc(t.description || '')}</td></tr>`).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(SERVER_INFO.name)} · MCP Server</title>
<style>
body{font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;background:#f6f7fb;color:#1f2430;margin:0;padding:40px 16px}
.card{max-width:760px;margin:0 auto;background:#fff;border-radius:14px;padding:32px;box-shadow:0 2px 12px rgba(20,30,60,.08)}
h1{font-size:22px;margin:0 0 4px}
.badge{display:inline-block;background:#e8f7ee;color:#0a7d43;border:1px solid #bfe8cf;border-radius:999px;padding:2px 12px;font-size:13px;margin:6px 0 18px}
table{width:100%;border-collapse:collapse;margin:14px 0;font-size:14px}
td{border-top:1px solid #eceff4;padding:9px 8px;vertical-align:top}
.tn{font-family:Consolas,monospace;color:#6d28d9;white-space:nowrap;width:34%}
pre{background:#14181f;color:#d7e2f0;border-radius:10px;padding:14px;overflow:auto;font-size:12.5px}
a{color:#2563eb;text-decoration:none}
.muted{color:#687182;font-size:13px}
</style></head><body><div class="card">
<h1>${esc(SERVER_INFO.name)}</h1>
<div class="badge">● MCP Streamable HTTP · 在线</div>
<p class="muted">海南社会调查网（hndcw.com）开放 MCP 端点 · 全国政府招投标/建设项目库查询 · 只读数据服务</p>
<h3>提供的工具 / Tools</h3>
<table>${toolRows}</table>
<h3>接入方式 / Usage</h3>
<pre>POST /mcp HTTP/1.1
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}

# Claude / Cursor 等客户端直接配置 remote MCP URL 即可</pre>
<p class="muted">开源仓库：<a href="https://github.com/mmcaoge/huage-mcp-servers">github.com/mmcaoge/huage-mcp-servers</a> · 官方 Registry：io.github.mmcaoge</p>
</div></body></html>`);
});

router.delete('/', (req, res) => {
  const sid = req.get('mcp-session-id');
  if (sid) sessions.delete(sid);
  res.status(202).end();
});

export default router;
