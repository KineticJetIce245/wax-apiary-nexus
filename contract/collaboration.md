# Native Collaboration 契约（G009，v1）

本文描述最小 Native Harness Collaboration：Host 通过原生 MCP 工具调用把任务交给 Worker，拿回 Worker Result 后继续自己的原生会话。实现以 [`src/collaboration-gateway.ts`](../src/collaboration-gateway.ts) 与 [`src/mcp-delegate-bridge.ts`](../src/mcp-delegate-bridge.ts) 为准。

## 1. 拓扑

```text
Codex native turn
  -> MCP tool delegate_to_worker
    -> mcp-delegate-bridge (stdio, child of Codex)
      -> POST http://127.0.0.1:<port>/delegate  (loopback + bearer token)
        -> CollaborationGateway
          -> Workbench.submit(task, workerConnection)
            -> DSH native turn
          <- completed worker output
      <- MCP tool result text
  <- Codex continues its native turn
```

- Host 与 Worker 都是既有原生会话；Gateway 不新建 Host 会话，也不复制 Host 上下文。
- Worker 默认 `dsh`；一个请求只提交一次，等待终态。
- 同步：Host 的工具调用在 Worker 完成前不返回。
- 没有队列、重试、持久化、异步回调或 handoff。

## 2. Gateway

`CollaborationGateway(workbench, { workerConnection?, port?, pollIntervalMs?, maxTaskChars? })`

- 只绑定 `127.0.0.1`，端口默认 `0`（系统分配）。
- `start()` 返回 `{url, token, workerConnection}`；token 每次实例生成一次。
- 端点仅 `POST /delegate`：
  - `Authorization: Bearer <token>` 必须匹配；
  - `Host` 必须是 `127.0.0.1:<port>`；
  - body 仅允许 `{task: string, worker?: string}`；未知字段拒绝；
  - `task` 非空，默认上限 20,000 字符；`worker` 上限 64 字符；
  - 错误：400 输入/JSON、401/403 认证或 Host、405 方法、409 worker 不可用/提交冲突、502 Worker 非 completed。
- 成功响应：`{worker, executionId, output}`；不返回本地附件路径。
- Gateway 不记录 task/output 内容。

## 3. MCP bridge

- stdio JSON-RPC（一行一条消息）；工具名 `delegate_to_worker`。
- `initialize`、`tools/list`、`tools/call`、`ping`；未知方法返回 JSON-RPC error。
- `tools/call` 参数：`{task: string, worker?: string}`；返回 MCP text content。
- 通过 `UW_GATEWAY_URL`、`UW_GATEWAY_TOKEN`、`UW_WORKER` 连接 Gateway。
- Gateway 非 2xx 或 Worker 失败时返回 `isError: true` 的 text content。
- bridge 不写 stdout 日志（stdout 只跑 JSON-RPC）。

## 4. 适配器接入

- Codex `thread/start` 支持 `config`；可传 `mcp_servers.<name>`（command/args/env）让 Codex 启动 bridge。
- DSH `session/new` 支持 `mcpServers` stdio/HTTP 声明；本目标只实现配置透传，未做 DSH-host 真实委派验收。
- Codex 的 MCP elicitation 请求会转成普通 approval；allow 返回 `{action:'accept',content:{}}`，reject 返回 decline。只适用于不需要表单内容的 MCP 工具调用。
- Codex 的 `item/permissions/requestApproval` 也会转成普通 approval；allow 授予请求的 permission profile（scope=turn）。

## 5. 验收证据

- Codex 原生 MCP 工具调用 `delegate_to_worker`，参数 `task=Reply with exactly WORKER-OK.`、`worker=dsh`；
- DSH 产生一条独立原生 execution，输出 `WORKER-OK`；
- Codex 收到工具结果后继续，最终输出 `DELEGATE-DONE` + `WORKER-OK`；
- Codex/DSH 均未重建；Host 的 native conversation 保持原 thread。

## 6. 限制

- 只有 Codex-host 完成真实验收；DSH-host 的 `mcpServers` 只做了声明透传。
- MCP elicitation 只按 approval 处理，不能填写表单；接受时 content 为空。
- 没有异步/后台任务、handoff、worker 选择策略、多 worker 编排、重试或持久化。
- 没有 Web/CLI 配置入口；当前由 API/probe 组装 Codex MCP config。
- Gateway 与 bridge 都只用于本机受控环境；token 在本地环境变量中传递。
- 没有超时上限；Worker 长时间运行会阻塞 Host turn，需由 Host/Gateway 取消。
