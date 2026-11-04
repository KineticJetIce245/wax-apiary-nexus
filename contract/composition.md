# Composition Runtime 契约（G007，v1）

> **状态（2026-11-04）**：本文是 G007 原型契约；v3 单 cursor 模型未实现，v3 契约草案在本地 `docs/contracts/composition-runtime-v1.md`。不要按本文实现 v3。

本文描述最小 Composition Runtime：Composition 是结构，Strategy 是语义。实现以 [`src/composition.ts`](../src/composition.ts) 为准。

## 1. 模型

```ts
interface Composition {
  id: string;
  version: number;
  participants: Record<string, { connection: string }>;
  strategyId: 'single-chat' | 'debate';
  config?: Record<string, string>;
}
```

- `participants` 是角色名 → 既有 Workbench 连接名；当前一连接一条原生 Conversation，因此 Binding 不额外存 conversationId。
- `version` 从 1 开始；每次 `switchStrategy` 自增，并追加一条变更历史。
- `config` 是策略参数；切换时可整体替换，未提供时沿用旧 config。

## 2. Strategy

```ts
interface CollaborationStrategy {
  id: StrategyId;
  handleUserMessage(text: string): Promise<void>;
}
```

内置：

- `single-chat`：`config.participant` 指定角色，缺省第一个角色；只提交一次。
- `debate`：`config.first` / `config.second` 指定两个角色（缺省前两个）；第一个角色先发言，第二个角色收到第一个角色的原文后要求简短反驳；两个角色必须使用不同连接。

没有 Strategy 注册表/插件；新增策略需要先改这个模块。等第二个真实策略验证后再抽 API 注册机制。

## 3. Runtime API

```ts
const runtime = new CompositionRuntime(workbench, composition, { pollIntervalMs? });
await runtime.start();
await runtime.send(text);
runtime.switchStrategy('debate', { first, second });
await runtime.cancel();
await runtime.stop();

runtime.composition; runtime.version; runtime.strategyId; runtime.status;
runtime.turns; runtime.history; runtime.error;
runtime.onEvent(handler);
```

状态：`idle | running | failed | cancelled`。

规则：

- 同一时间只允许一个 `send`；运行中 `send` 抛 `CompositionBusyError`。
- 运行中 `switchStrategy` 抛 `CompositionBusyError`；必须先完成或取消。
- 每个 turn 通过 `Workbench.submit` 发到绑定连接，等待终态；只接受 completed，否则抛 `CompositionExecutionError`。
- cancel 取消在飞 execution；未开始的后续 turn 不再提交。
- 取消的 `composition/cancelled` 在在飞 turn 进入终态之后只发一次；取消不会再发 `composition/failed`。
- 不重试、不新建原生 Conversation、不复制上下文。
- 没有持久化；进程退出即丢失。

## 4. 版本与历史

- 初始 version 1；
- `switchStrategy` → version+1；
- `history` 记录 version/strategyId/时间；
- 切换不改 participants，不改 native conversation id。

## 5. 验收

真实探测（2026-10-31，Windows）：

- 两条原生会话 DSH/Codex；
- version 1 single-chat（DSH）→ version 2 debate（DSH→Codex）→ version 3 single-chat（Codex）；
- 四个 turn 均 completed；
- DSH/Codex native id 前后不变；
- final status idle。

## 6. 限制

- 一连接一 Conversation；没有多 Conversation/动态参与。
- 没有持久化、跨重启恢复。
- 没有 Web 写操作或 Composition 编辑器。
- 没有 Cordis/Strategy 插件注册。
- Debate 只是两段式：第一个发言，第二个反驳；没有多轮/裁判。
- 没有任务队列；运行中只能取消，不能切策略。
