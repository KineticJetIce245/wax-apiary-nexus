# 声明式流程契约（G005，v1）

> **状态（2026-11-04）**：本文是 G005 原型契约；v3 模型未实现，v3 架构在本地 `docs/architecture-v3.md`。不要按本文实现 v3。

本文描述 `graph` 策略的流程文件格式、校验规则、执行语义和运行时 API。它是用户/工具生成流程 JSON 的依据；实现以 [`src/flow-definition.ts`](../src/flow-definition.ts) 与 [`src/flow-runtime.ts`](../src/flow-runtime.ts) 为准。

## 1. 它是什么

流程文件是**输入**，不是执行结果。它描述“谁先做、做完给谁、什么条件走哪条路”。执行结果由运行时返回：每个已完成节点的 assistant 文本、节点状态和整体状态。

第一版只有内置 `graph` 策略，不加载外部策略代码。

## 2. 文件结构

```json
{
  "version": 1,
  "id": "review-chain",
  "strategy": "graph",
  "input": "设计一个最小 CLI 日历",
  "participants": {
    "planner": { "connection": "dsh" },
    "reviewer": { "connection": "codex" }
  },
  "start": "plan",
  "nodes": {
    "plan": { "participant": "planner", "prompt": "为 {{input}} 写方案", "next": "review" },
    "review": {
      "participant": "reviewer",
      "prompt": "审查：{{plan}}",
      "next": { "contains": "APPROVED", "then": "done", "else": "revise" }
    },
    "revise": { "participant": "planner", "prompt": "根据审查修改：{{review}}", "next": "done" },
    "done": { "type": "end" }
  }
}
```

字段：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `version` | 是 | 固定 `1` |
| `id` | 否 | 流程标识；省略时运行时生成 |
| `strategy` | 是 | 固定 `"graph"` |
| `input` | 否 | 初始文本，模板里用 `{{input}}` 引用 |
| `participants` | 是 | 角色名 → `{ connection }`；连接名来自工作台（`dsh`、`codex`） |
| `start` | 是 | 起始节点 id |
| `nodes` | 是 | 节点 id → 节点 |

角色名、节点 id 必须匹配 `[A-Za-z0-9_-]+`，否则模板无法引用。

## 3. 节点类型

### submit（默认）

```json
{ "participant": "planner", "prompt": "...", "next": "review" }
```

- 在当前连接的原生 Conversation 上提交一轮。
- `prompt` 非空；模板只允许 `{{input}}` 与已完成 submit 节点的 id。
- `next` 是字符串或条件对象。
- 作为并行分支时不能有 `next`。
- `attachments` 可选，是上游 submit 节点 id 列表；把这些节点产生的附件作为本次输入。路径由 Execution 记录，不写进 JSON。

### parallel

```json
{ "type": "parallel", "branches": ["a", "b"], "next": "merge" }
```

- `branches` ≥ 2，必须指向**没有 next 的 submit 节点**。
- 分支之间必须使用不同连接；同一连接并行会在校验期报错。
- 所有分支完成后进入 `next`；任一失败/取消/unknown 会取消其他分支并停止流程。
- 第一版不支持嵌套并行。

### end

```json
{ "type": "end" }
```

流程到达 end 即 completed。

## 4. 条件

```json
{ "contains": "APPROVED", "then": "done", "else": "revise" }
```

或：

```json
{ "equals": "OK", "then": "done", "else": "retry" }
```

- 恰好提供 `contains` / `equals` 之一。
- 对本节点自己的 assistant 输出做大小写敏感的 `String.includes` / 严格相等。
- `then`/`else` 必须指向存在的节点。
- 第一版不支持正则、表达式或跨节点条件。

## 5. 校验规则（运行前）

流程在提交任何模型请求前全部检查：

- version/strategy/start/nodes/participants 合法；start 不是 end、不是并行分支。
- 节点 id、participant 名匹配 `[A-Za-z0-9_-]+`；id 唯一；节点 id `input` 保留给 `{{input}}`，不允许作为节点名。
- submit：participant 存在、prompt 非空、next 存在；并行分支叶子不得有 next；`attachments` 目标必须是存在的 submit 节点，不能引用自己。
- parallel：branches ≥ 2、不重复、目标为 submit 叶子、不同连接、每个分支只属于一个并行组、分支不能被其他 next 指向。
- next/then/else 目标存在；条件格式合法。
- 所有节点从 start 可达；存在 end；图中没有环。
- 模板占位符是 `input` 或存在且为 submit 的节点；引用自己、引用非 submit、缺少 `flow.input`、花括号不配对都拒绝。

## 6. 执行语义

| 情况 | 行为 |
| --- | --- |
| 顺序 | 节点 completed 后按 next 前进 |
| 条件 | 用本节点输出选 then/else，只走一条路径 |
| 并行 | 同时提交不同连接上的分支；全部 completed 后进入 next |
| 失败/unknown | 停止流程，不重试、不重放；已完成输出保留在结果 |
| 附件 | 节点引用上游附件并在提交时传给 Connection；缺失附件在提交前失败；不把二进制写进 JSON |
| 审批 | 复用 Workbench/Workspace；流程等待用户回答，不自动放行 |
| 取消 | 取消在飞节点；未开始的节点不再提交；状态 cancelled |
| 重启 | 状态只在内存，进程退出即丢失 |
| 同连接并行 | 校验拒绝，不排队 |

## 7. 运行时 API

```ts
const runtime = new FlowRuntime(workbench, definition, { pollIntervalMs?: number });
runtime.onEvent((event) => { /* flow/started, node/started, node/completed, node/failed, flow/completed|failed|cancelled */ });
const result = await runtime.run();
await runtime.cancel();
runtime.status; // idle | running | completed | failed | cancelled | unknown
runtime.result; // FlowResult | undefined
```

`FlowResult`：

```ts
{
  flowId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'unknown';
  outputs: Record<string, string>; // 已完成节点的 assistant 文本
  nodes: Record<string, {
    nodeId: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
    executionId?: string;
    connection?: string;
    output?: string;
    attachments?: Attachment[]; // 本节点执行产生的附件
    error?: string;
  }>;
  error?: string;
}
```

CLI：

```text
/flow run <file>
/flow status
/flow cancel
```

## 8. 演进规则

- `version` 变化表示不兼容；新增可选字段保持 v1 兼容。
- 先支持顺序/条件/单层并行；循环、嵌套并行、动态改图、持久化不在 v1。
- 如果引入第二种执行语义，先提 Strategy API 提案，不要把语义塞进流程 JSON。
- 本契约不定义富文本/图片结果；`outputs` 只有文本。执行结果的内容信封见 [result.md](result.md)。
