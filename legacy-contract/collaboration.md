# Native Collaboration 契约（Legacy prototype）

> **Status**: legacy prototype contract. Current design: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) and [`../CONTRACT.md`](../CONTRACT.md).

本文描述最小 Native Harness Collaboration：Host 通过原生 MCP 工具调用把任务交给 Worker，拿回 Worker Result 后继续自己的原生会话。G010 在同一条路径上补了确定性授权、工作项记录与可靠投递。实现以 [`src/collaboration-gateway.ts`](../src/collaboration-gateway.ts)、[`src/mcp-delegate-bridge.ts`](../src/mcp-delegate-bridge.ts)、[`src/delegation-ledger.ts`](../src/delegation-ledger.ts) 与 [`src/delegation-policy.ts`](../src/delegation-policy.ts) 为准。

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
- 没有队列、重试、异步回调或 handoff；每次成功委派都记入 append-only ledger。

## 2. Gateway

`CollaborationGateway(workbench, { workerConnection?, port?, pollIntervalMs?, maxTaskChars?, policy?, stateDirectory?, allowStaleLedgerLock?, asyncTimeoutMs?, resultMaxBytes? })`

- 只绑定 `127.0.0.1`，端口默认 `0`（系统分配）。
- `start()` 返回 `{url, token, workerConnection, mandate}`；token 与 mandate 每次实例生成一次。
- `policy` 必须是 [`delegation-policy.ts`](../src/delegation-policy.ts) 定义的对象；未知字段拒绝。缺省策略只允许 `workerConnection` 一个 worker，`maxConcurrent` 为 1。
- `stateDirectory` 缺省为 `~/.wax/<projectId>/`（`WAX_STATE_DIR` 可覆盖根目录；projectId 不匹配白名单时改用哈希目录）。
- 端点：
  - `POST /delegate`：同步委派，等到 Worker 终态才响应；
  - `POST /delegations`：异步委派，提交成功后立即返回 202；
  - `GET /delegations/<workItemId>`：读取异步（或同步）委派的当前状态与已存结果。
  - 三个端点共用同一套认证、Gate 与 ledger；`Authorization: Bearer <token>` 与 `Host: 127.0.0.1:<port>` 都必须匹配。
  - POST body 仅允许 `{task: string, worker?: string}`；未知字段拒绝（包括任何自称的授权字段）；可选请求头 `Idempotency-Key`，1–128 个 `[A-Za-z0-9._:-]`；`task` 非空，上限 `policy.maxTaskChars`；`worker` 上限 64 字符。
  - 错误：400 输入/JSON/未知字段/非法幂等键/非法 work item id、401 认证、403 Host 或策略拒绝或 mandate 过期、404 路径或 work item 不存在、405 方法、409 worker 不可用/并发上限/重复幂等键/提交被明确拒绝、413 body 超限、499 客户端已断开（不返回响应体）、500 内部错误、502 Worker 明确失败或非 completed、503 提交结果未知或 ledger 需要人工修复。
- 同步成功响应：`{worker, executionId, output, workItemId, mandateId}`；不返回本地附件路径。
- 异步成功响应（202）：`{workItemId, executionId, state:'accepted', mandateId}`。
- Gateway 不记录 task 内容；ledger 只保存任务长度与 sha256 摘要，错误文本最多 2000 字符。异步完成后的 Worker 输出写入受控结果文件（见 2.4）。

### 2.4 异步委派与结果取回

- `POST /delegations` 通过同一 Gate 后立即提交 Worker 并返回 202；HTTP 连接结束**不取消** Worker。
- 后台最长运行 `asyncTimeoutMs`（默认 30 分钟）；到点取消 Worker，Work Item 记为 `failed`，错误文本含 `timed out`。
- Worker completed 时，输出写入 `<stateDirectory>/results/<workItemId>.txt`（目录 0700、文件 0600），最多 `resultMaxBytes`（默认 256 KiB）；超出部分按 UTF-8 码点边界截断（不会切坏多字节字符），`settled` 记录带 `resultFile`、`resultBytes`、`resultTruncated`。
- 结果文件的读取只允许 `results/<uuid>.txt` 这一种布局，且必须落在 state 目录内；ledger 里被篡改的 `resultFile` 不会让 GET 读到兄弟目录或外部文件。
- 文件权限：POSIX 上目录 0700、文件 0600；Windows 上 Node 的 `mode` 只映射只读位，实际访问由 ACL 决定（本机实测为 666），不要依赖 Windows 的 mode 值。
- `GET /delegations/<id>` 返回 `{workItemId, state, executionId?, error?, output?, truncated?}`；只有 `completed` 且结果文件存在时才带 `output`。id 必须是严格的 UUID 形状（8-4-4-4-12），非法 id 返回 400，未知 UUID 返回 404。
- 结果取回是 **Host 的责任**：Gateway 不推送。Host 若在拿到 workItemId 后结束 turn，就只能由人或后续 turn 再取。
- 重启后未结算的异步 Work Item 与同步记录一样进入恢复报告；不自动重放。已完成项的结果文件保留在状态目录，可继续读取。
- `stop()` 会中止本进程内的后台委派：abort 等待中的任务，给“仍在 submit 内”的接受过程一个有界窗口（默认 2 秒，可用 `stopDrainMs` 覆盖）自行取消并结算；窗口过后仍未结算的项记为 `unknown`（`gateway stopped before the delegation settled`），然后关闭 ledger。cancel 调用另受 `cancelTimeoutMs`（默认 1 秒）约束，两者都必须是正整数，避免关闭流程被永不返回的 cancel 挂住。若 submit 在 ledger 关闭后才返回，Gateway 仍会 best-effort 取消该 Worker，但这次取消不会再写进已关闭的 ledger——这类迟到启动的 Worker 由“unknown + 恢复报告”体现。

### 2.1 授权（Mandate 与确定性 Gate）

- 授权事实**只**来自 Gateway 配置中的 `DelegationPolicy` 与实例启动时生成的 mandate：`{id, requester, basis:'policy', policyVersion, issuedAt, expiresAt, allowedWorkers}`。
- 工具参数、Host 模型文本、Worker 输出都不是授权来源；`basis` 固定为 `policy`，模型不能自述“已获明确授权”。
- Gate 顺序固定：Host → 方法/路径 → bearer → JSON/字段白名单 → worker 在 `allowedWorkers` → task 长度 → mandate 未过期 → 幂等键未占用 → 并发未超限 → worker 连接 ready。白名单在 task 长度之前，未授权 worker 不能借超长 task 拿到不同的错误码。
- 通过认证后的策略拒绝会写成 `gate/rejected` 记录：`code` 加最长 64 字符的 `detail`，不含 task 内容；未认证请求不写。
- Gateway 不做模型 Assessment；本版本没有“升级为 auto”的路径。

### 2.2 工作项与 Outbox

- 每次通过 Gate 的委派创建一个 Work Item，并在 append-only ledger 中按顺序记录：`work-item/created` → `delivery/intent` → `delivery/submitted`（仅在拿到 execution 时）→ `delivery/settled`。提交被明确拒绝或结果无法确认时可能没有 execution，因此只有 `created`、`intent`、`settled` 三段。
- Work Item 字段：`id`、`mandateId`、`requester`、`basis`、`policyVersion`、`worker`、`taskLength`、`taskDigest`、`idempotencyKey?`、`state`、`executionId?`、`error?`、`createdAt`、`updatedAt`。
- 状态由 ledger 折叠得出，不另存副本：`created` → `in-flight` → `completed | failed | cancelled | unknown`。`unknown` 是一次尝试的终点，但按恢复语义仍需人工检查。
- 并发上限按**本进程**正在执行的委派计数；历史未结算记录不占用新的并发名额。
- 同一 `Idempotency-Key` 的第二次投递返回 409 并指出原 Work Item；本版本不缓存 Worker 输出，因此不重放结果。
- `delivery/intent` 在提交前写入；拿到 execution 后**先写 `delivery/submitted`**，再处理断线。这样提交阶段断开也能从 ledger 认出可能已启动的 Worker。
- 提交结果的三种语义必须分开：明确拒绝（未创建 execution，409）、明确失败（`SubmitFailedError`，502，`settled` 记录带 `executionId`）、结果未知（`SubmitOutcomeUnknownError`，503，记为 `unknown`，Workspace 已创建 execution 时同样带 `executionId`）。不得把“未知”折叠成“失败”。
- 断线时取消失败会写进 `delivery/settled` 的 `error`，状态记为 `unknown`；`executionId` 仍在 `delivery/submitted`/`settled` 里可查。

### 2.3 恢复（Recovery Note）

- 启动时读取 ledger。需要人工结算的记录（`created` / `in-flight` / `unknown`）进入 `getRecoveryReport()`：`{note, items, tornTail}`。`unknown` 虽然是一次尝试的终态，却表示结果无法判定，正是最需要人工检查的状态。
- 启动**不会**自动重投或重放任何委派；`note` 明确要求先检查 Project 文件、git 历史与 Worker 原生会话，再人工结算。
- 最后一行不完整（进程在写记录时被杀）：读取时保留原字节、丢弃该片段并标记 `tornTail`。完整但缺少换行的记录可以安全补行；无法解析的片段会阻止后续 append，Gateway 仍可启动并给出恢复报告，但对新委派返回 503。
- 残尾被人工修好之后，同一 Gateway 实例会在下一次委派时重新读取并**重开文件句柄**，恢复写入（不需要重启）。原地截断与“写临时文件后原子替换”两种修法都支持；重开失败则保持 degraded 并继续返回 503。
- `tornTail` 在恢复报告里按磁盘当前状态重新计算，补行成功后会变为 false。
- 文件中间出现无法解析或序号不连续的行时拒绝启动（`LedgerCorruptError`），不静默修复。

## 3. MCP bridge

- stdio JSON-RPC（一行一条消息）；工具：`delegate_to_worker`（同步等待）、`start_delegation`（异步，返回 `workItemId`）、`get_delegation_result`（按 id 取状态/结果）。
- `initialize`、`tools/list`、`tools/call`、`ping`；未知方法返回 JSON-RPC error。
- `delegate_to_worker` / `start_delegation` 参数：`{task: string, worker?: string}`；`get_delegation_result` 参数：`{workItemId: string}`。
- 异步工具返回 JSON 文本：`start_delegation` → `{workItemId, state, executionId}`；`get_delegation_result` → `{workItemId, state, executionId?, error?, output?, truncated?}`。
- 每次 POST `tools/call` 生成一个新的 `Idempotency-Key` 请求头；bridge 不自行重试。
- 通过 `UW_GATEWAY_URL`、`UW_GATEWAY_TOKEN`、`UW_WORKER` 连接 Gateway；`start_delegation` / `get_delegation_result` 由 `UW_GATEWAY_URL` 推导同源 `/delegations` 路由。
- Gateway 非 2xx 或 Worker 失败时返回 `isError: true` 的 text content。
- bridge 不写 stdout 日志（stdout 只跑 JSON-RPC）。

## 4. 适配器接入

- Codex `thread/start` 支持 `config`；可传 `mcp_servers.<name>`（command/args/env）让 Codex 启动 bridge。
- DSH `session/new` 支持 `mcpServers` stdio/HTTP 声明；G012 已在真实 DSH-host 会话上验证：DSH 声明 bridge、调用 `start_delegation`/`get_delegation_result`、委派给 Codex Worker 并取回 `WORKER-OK`。
- 两种注入形状不同，必须按各自的 Harness 声明：
  - Codex：`thread/start` 的 `config.mcp_servers.<name> = { command, args, env: { KEY: value } }`（env 是对象）；
  - DSH ACP：`session/new.mcpServers = [{ name, command, args, env: [{ name, value }] }]`（env 是数组）。
- Codex 的 MCP elicitation 请求会转成普通 approval；allow 返回 `{action:'accept',content:{}}`，reject 返回 decline。请求带 `turnId` 时必须匹配当前 turn；缺省时挂到当前活跃 turn。只适用于不需要表单内容的 MCP 工具调用。
- Codex 的 `item/permissions/requestApproval` 也会转成普通 approval；approval 摘要包含请求的 permission profile，allow 授予该 profile（scope=turn）。
- 客户端在 Worker 完成前断开时，Gateway 会 best-effort 取消 Worker execution；取消不保证原生侧立刻停止。断线监听在提交之前安装，因此提交阶段的断开也会被捕获并写入 ledger，不会留下“无人知晓”的运行中 Worker。
- 忙时再输入（G014 真实探针，绕过适配器守卫直接说协议）：
  - DSH ACP：第二次 `session/prompt` 被原生拒绝，错误 `-32602 Invalid params: a prompt is already in flight for this session`；没有 `session/steer`（`-32601 Method not found`）。
  - Codex app-server：`turn/steer` 存在且生效，参数需 `{ threadId, expectedTurnId, input }`；探针把运行中的“数到 500”改为 `STEER-OK`，模型输出确实变成 `STEER-OK`。`turn/steer` 返回 `{ turnId }`。
  - 两个适配器目前都在本地拒绝第二次提交（“already has an active execution”），Workspace 也保持单活跃执行；原生 steer 能力尚未通过 Workspace 暴露。
  - 决定（2026-11-01，所有者确认）：**不引入 steer / 输入队列**。理由：DSH 无原生能力，两 Harness 语义不一致；引入会改变并发语义与审计边界，而当前场景以短回合为主，收益不足。忙时行为保持“拒绝第二次提交”。
- 强制转换（G015）：`Workspace.replace(executionId, text)` 的语义：
  - 空文本在 cancel 之前拒绝；
  - 已确认终态（`completed`/`failed`/`cancelled`）直接提交；
  - 运行中先 `cancel`，等待终态（默认 10 秒），再提交；
  - `unknown`（结果无法确认，native 可能仍在跑）抛 `ReplaceUnknownError` 且不提交；
  - 超时抛 `ReplaceTimeoutError` 且不提交。
  以上保证两个 prompt 不并发。`Workbench.replace` 与 `workbench-cli` 的 `/replace <connection> <execution-id> <instruction...>` 使用同一语义。Codex/DSH 真实验证：取消到新 execution 完成约 73ms/32ms，新输出 `REPLACED-OK`，旧 execution 为 `cancelled`。
- 原生 resume（G016 探针，跨进程验证）：
  - Codex：`thread/resume { threadId }` 在新 app-server 进程中被接受，返回旧 thread（含 turns 计数），随后 `turn/start` 能答出上一进程留下的口令。
  - DSH：`session/load` 不存在（`-32601`）；`session/resume { sessionId, cwd }` 被接受，新进程追问同样答出旧口令。
  - 产品化（G017）：两个适配器声明 `resume: true` 并实现 `resume(nativeId, cwd)`；`Workspace.resumeConversation(project, nativeId, conversationId?)` 接回旧会话；`ConversationStore` 把 `conversationId ↔ nativeId ↔ project` 落盘到 `~/.wax/conversations.json`（可 `--conversation-store` 覆盖）；`workbench-cli --resume <id>` 使用该映射恢复，启动时打印每个连接的 conversation id。恢复不重放历史，只接回 native 会话本体。
- 本地 API（G018、2026-11-04 拆出 UI）：`/web start` 启动的 HTTP 服务只提供 `GET /api/state`、`/artifacts/<id>` 与可选的 `POST /api/prompt`；`/` 返回 404 并提示 UI 在 `wax-web` 目录（未入库）。默认只读，仅当启动时提供 `controlToken` 才开放写接口，要求 `Authorization: Bearer <token>`。只监听 `127.0.0.1` 并校验 Host；审批和取消仍只在 CLI。每次 `/web start` 生成新 token，打印 API 基址和 token；页面快照在 `wax-web` 目录（仓库外，未入库，不能独立运行）。

## 5. 验收证据

- Codex 原生 MCP 工具调用 `delegate_to_worker`，参数 `task=Reply with exactly WORKER-OK.`、`worker=dsh`；
- DSH 产生一条独立原生 execution，输出 `WORKER-OK`；
- Codex 收到工具结果后继续，最终输出 `DELEGATE-DONE` + `WORKER-OK`；
- Codex/DSH 均未重建；Host 的 native conversation 保持原 thread；
- G010 追加：ledger 里出现该次委派的 `work-item/created` → `intent` → `submitted` → `settled` 四条记录，且记录中的 `mandateId` 与 Gateway 启动时返回的 mandate 一致。
- G011 追加：Codex 调用 `start_delegation` 拿到 `workItemId` 后继续自己的 turn，再用 `get_delegation_result` 取回 `WORKER-OK`；`GET /delegations/<id>` 在完成后带 `output`，结果文件位于 `<stateDirectory>/results/<id>.txt`。
- G012 追加：DSH 作为 Host 的对称方向已验证 —— DSH 会话通过 `session/new.mcpServers` 声明 bridge，调用 `start_delegation` → `get_delegation_result`，委派给 Codex Worker，最终输出 `DELEGATE-DONE` + `WORKER-OK`；Gateway 记录的 `worker` 为 `codex`，ledger 四段齐全。

## 6. 限制

- Codex-host 与 DSH-host 都完成了真实验收（各自方向见 §5），但都只是单 Worker、单任务；没有多 Worker 编排或并发委派压测。
- MCP elicitation 只按 approval 处理，不能填写表单；接受时 content 为空。带 `turnId` 且不匹配当前 turn 的请求直接 decline，不产生 approval。
- 没有 handoff、worker 选择策略、多 worker 编排或自动重试；投递失败不重放。
- 异步委派依赖 Host 主动取回结果：Gateway 不推送；Host 在拿到 id 后结束 turn 时，结果只能由人或后续 turn 再取。
- 没有模型 Assessment 层；授权只有确定性 Gate，`observe`/`auto` 两档未实现。
- 没有 Web/CLI 配置入口；当前由 API/probe 组装 Codex MCP config 与 policy。
- Gateway 与 bridge 都只用于本机受控环境；token 在本地环境变量中传递。token 可能被 Codex 写入 thread config/rollout；token 随 Gateway 实例失效，更换 Gateway 后需要重建带新 env 的 thread。mandate 与 token 同生命周期，因此审计记录不能跨实例证明“谁曾经授权”，只能证明“这一实例按该策略执行过”。
- 同步委派没有总超时上限；Worker 长时间运行会阻塞 Host turn，需由 Host 取消或断开客户端触发 Gateway 取消。异步委派受 `asyncTimeoutMs` 约束。超时取消失败时原生会话仍可能 busy，下一次委派会得到 409（`Conversation already has a running execution`），这不是 Gateway 的并发上限，需要先停掉或释放该原生会话。
- 同一 state 目录只允许一个写者（`writer.lock`）。锁属于已死亡的本机进程时，必须显式 `allowStaleLedgerLock` 才能接管；来自**其他主机**的锁一律按“已占用”处理，不自动判定陈旧。关闭时只删除自己持有的锁。
- 陈旧锁接管不是强互斥：删除旧锁到写入新锁之间存在一个很短的时间窗，两个进程同时接管时理论上可能都拿到写权。本版本靠重试时的 `EEXIST` + pid 检查把冲突暴露出来，但不提供跨进程的原子接管；需要强保证时应先停掉旧进程再启动。
- ledger 不保存 task 全文；异步结果保存在受控结果文件里（0600、有上限），同步委派的结果不落盘。错误文本最多 2000 字符（含省略号），`gate/rejected` 的 detail 最多 64 字符。
- bridge 对无法解析的 JSON 行返回 `-32700`；不支持的方法返回 `-32601`。每次 `tools/call` 生成新幂等键只用于识别“同一次调用被重复投递”，不提供跨重试去重（bridge 本身不重试）。
