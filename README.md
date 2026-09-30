# 华哥 · 官方 MCP 服务器（huage-mcp-servers）

海南铎鸣社会调查网（hndcw.com）对外提供的 **Model Context Protocol (MCP)** 开放端点集合。
所有服务器均指向已部署在公网的统一端点 `https://hndcw.com/mcp`（Streamable HTTP 传输）。

## 包含的服务器
| 目录 | 服务器名 | 业务 |
| --- | --- | --- |
| `servers/huage-bidding-data` | io.github.mmcaoge/huage-bidding-data | 全国政府招投标 / 建设项目库查询 |
| `servers/huage-hainan-policy` | io.github.mmcaoge/huage-hainan-policy | 海南政策法规 / 惠企政策检索 |
| `servers/huage-minger-qa` | io.github.mmcaoge/huage-minger-qa | 「鸣儿」招投标智能问答 |
| `servers/huage-dev-service` | io.github.mmcaoge/huage-dev-service | 社会调查 / 现场执行服务咨询 |

## 端点
- 协议：MCP Streamable HTTP（`POST /mcp`）
- 公网地址：`https://hndcw.com/mcp`
- 传输：JSON-RPC 2.0；默认 `application/json`，客户端声明 `text/event-stream` 时回 SSE
- 已开启 CORS（浏览器 / 跨域客户端可直接调用）

## 客户端接入（以 Claude Desktop / Cursor / VS Code 为例）
在 MCP 配置中加入：
```json
{
  "mcpServers": {
    "huage-bidding-data": {
      "url": "https://hndcw.com/mcp"
    }
  }
}
```
或直接引用本仓库各 `servers/*/server.json`（符合官方 MCP Registry `server.json` 规范，Glama / PulseMCP 等聚合站会自动抓取）。

## 本地运行（开发用）
端点代码见根目录 `mcpServer.js`，依赖 Express 与 Node 22 内置 `node:sqlite`：
```bash
node --version   # >= 22
npm i express
# 将 mcpServer.js 挂到你的 Express 应用： app.use('/mcp', (await import('./mcpServer.js')).default)
```

## 安全与限流
- 端点只读查询招投标库，无写入、无副作用。
- 服务端已配置基础限流，禁止匿名滥用。
- Token / 凭据仅存于部署侧，本仓库不包含任何密钥。

## 许可
代码以 MIT 许可开源；数据版权归海南铎鸣社会调查网所有。
