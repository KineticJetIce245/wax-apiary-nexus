# Harness Adapter 契约

状态：草案（2026-10-30）。适用对象：为本项目实现 `HarnessAdapter` 的人，以及审阅适配器代码的人。

本文描述 **Workspace 与一个原生 Harness 之间必须成立的行为**。它不描述 ACP、Codex app-server 等具体协议；协议细节属于各适配器内部。类型定义以 [`src/adapters/harness.ts`](../src/adapters/harness.ts) 为准，本文解释其语义。

## 1. 适配器必须实现什么

```ts
interface HarnessAdapter {
  readonly capabilities: HarnessCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  createConversation(project: Project): Promise<string>;
  submit(nativeId: string, executionId: string, text: string): Promise<void>;
  cancel(nativeId: string): Promise<void>;
  respondToApproval(decision: ApprovalDecision): Promise<void>;
  closeConversation(nativeId: string): Promise<void>;
  onEvent(handler: (event: HarnessEvent) => void): () => void;
}
```

| 成员 | 要求 |
| --- | --- |
| `capabilities` | 只读、在实例生命周期内稳定；每项声明都必须有实测依据（见 §3） |
| `start()` | 启动原生运行时并完成握手；已启动时再次调用直接返回；失败时抛出可操作错误，且不留下半启动状态 |
| `stop()` | 停止原生运行时、清空本地会话状态、让此后所有操作失败；可重复调用 |
| `createConversation(project)` | 为该项目创建一个**新的**原生会话，返回原生 id；不得复用另一个会话的 id |
| `submit(nativeId, executionId, text)` | 在指定原生会话上开始一轮；`executionId` 由 Workspace 生成，适配器必须在后续所有事件中原样带回 |
| `cancel(nativeId)` | 请求原生层取消该会话当前的一轮；没有活跃轮次时可以 no-op |
| `respondToApproval(decision)` | 回答一个待决审批；未知或已结算的 `requestId` 必须拒绝 |
| `closeConversation(nativeId)` | 停止接受新工作、处理待决审批、中断或释放活跃轮次、释放本地会话状态；**不得删除原生历史**，除非另有明确文档 |
| `onEvent(handler)` | 订阅事件，返回取消订阅函数；取消后不得再向该 handler 投递事件 |

## 2. 分层约束

- 适配器可以 import 自己的协议类型、进程与文件工具；**不得**把协议类型泄漏进 `Workspace`、`kernel` 或 `HarnessEvent`。
- `Workspace` 不 import 任何具体适配器；适配器不依赖 `Workspace`。
- 一个适配器实例可以管理多个会话；不得把项目目录、当前会话等状态写成全局单例。

## 3. 能力声明必须诚实

```ts
interface HarnessCapabilities {
  approval: 'interactive' | 'policy-only' | 'none';
  cancel: boolean;
  streaming: boolean;
  resume: boolean;
}
```

| 字段 | 什么情况下可以为 true / 该取值 |
| --- | --- |
| `approval: 'interactive'` | 适配器会发出 `execution/approval-requested`，并真正执行 `respondToApproval` 的决定；仅“上游支持审批”不够 |
| `approval: 'policy-only'` | 原生层按策略自动决定，不向客户端提问；收到审批请求时 Workspace 会取消它并报错 |
| `approval: 'none'` | 没有审批机制 |
| `cancel: true` | `cancel()` 能让原生层停止当前轮次；只在本地丢弃状态不算 |
| `streaming: true` | 会通过 `execution/output` 增量输出；只在结束时一次性给全文则应为 false |
| `resume: true` | 适配器**自己实现并测试过**恢复操作；上游 Harness 声称支持恢复不构成依据 |

新增能力字段时，默认值必须是保守的 false / 最弱枚举，不能先声明再实现。

## 4. 会话身份与 Project

- 原生 id 是会话身份：同一会话跨轮次、跨提交保持不变。
- `createConversation` 每次调用都产生新身份；是否支持恢复由 `resume` 声明，不能靠“再次创建同一个 id”冒充。
- Project 的 `directory` 是该会话的工作目录。适配器必须使用它，而不是宿主进程的 cwd。
- 适配器应在创建和提交前确认目录存在且是目录；目录失效时拒绝操作，且不得提交半轮。

## 5. 一次执行的生命周期

```text
submit() 返回前开始
  execution/started                 （必须恰好一次）
  execution/output*                 （assistant / thought，可零次或多次）
  execution/tool*                   （可零次或多次）
  execution/approval-requested*     （仅在 approval = interactive 时）
  ── 恰好一个 ──>
  execution/completed | execution/failed | execution/cancelled | execution/unknown
```

规则：

1. `submit` 在原生层**接受**这一轮后即可返回，不等待完成；完成通过事件表达。
2. 每个 execution 必须恰好收到一个终态事件。终态之后的事件必须被忽略或不再发出。
3. 适配器不得自行重试、重放或重新提交一轮；不确定的失败只能报 `unknown`。
4. **必须区分“原生明确拒绝”与“提交结果不确定”。** 原生返回错误响应是明确拒绝（普通 `Error`）。响应超时或连接中断时：
   - 若尚未观察到 `turn/started`，视为结果不确定，必须抛出 [`SubmitOutcomeUnknownError`](../src/adapters/harness.ts)，并在原生会话上保留活跃关联；Workspace 会把该执行结算为 `unknown` 并保持会话 busy，直到收到该执行的终态事件或关闭/停止。
   - 若已经观察到 `turn/started`，说明原生已接受这一轮：不得报 failed，应继续等待终态（`execution/started` 已发出，后续输出/终态仍归属该执行）。
   适配器不得在另一层释放这个关联。原生明确拒绝仍由适配器抛普通 `Error`；Workspace 会把它包装成带 `executionId` 的 `SubmitFailedError`，供需要关联失败尝试的调用方使用。
5. `execution/output` 的 `channel` 为 `assistant` 时计入 Workspace 输出；`thought` 只用于展示。
6. `stop()` 或进程/连接丢失时，仍在运行的 execution 必须报 `execution/unknown`，并附上原因。
7. 原生层的“完成”不等于“成功”：`completed` 只用于原生明确结束；失败、取消、未知必须分开报。
8. 终态和输出的身份必须取自协议规定的位置（例如 `params.turnId` 与嵌套的 `params.turn.id`），并只与当前活跃轮次比较。旧轮次的迟到事件不得结算新执行，也不得作为新执行的审批呈现。

## 6. 并发与关闭

- 同一原生会话同一时间只允许一个活跃 execution。适配器必须拒绝重叠的 `submit`（Workspace 也会挡，但适配器不能依赖上层）。
- 关闭开始时先标记 closing，再 await 任何原生调用；closing 期间 `submit` 必须拒绝。
- **关闭活跃轮次必须以原生终态为证据。** `turn/interrupt` 的响应、`thread/unsubscribe` 的成功都不是“轮次已终止”的证明；必须等到原生终态事件后再退订/释放。超时仍无终态时，关闭失败并保留 closing + 活跃关联，由 Workspace 把执行标为 `unknown`。
- 关闭时如果活跃轮次连 turn id 都未知（提交结果不确定且没有 `turn/started`），无法安全中断：关闭必须失败并保留状态，调用方只能等待或 `stop()`。
- `closeConversation` 失败时：保留会话状态与 closing 标记，不宣告 cancelled；由 Workspace 决定把运行中的 execution 标为 unknown。
- `closeConversation` 成功时：释放本地状态；有待决审批时先拒绝/取消它们；活跃轮次应已有原生终态。
- 取消、关闭、停止都属于**本地解除关联**，与原生中断/终止是两件事：`cancel()` 必须到达原生层，`close` 必须确认原生终态；三者都不自动删除原生历史，除非另有明确文档。

## 7. 审批

仅在 `capabilities.approval === 'interactive'` 时使用。

- 请求必须带：`requestId`（连接内唯一、可用于回答）、`executionId`（当前运行中的执行）、`summary`（人可读）、`options`（至少一个可决定项）。
- `options.kind` 的语义：`allow_once` / `reject_once` 是单次决定；`allow_always` / `reject_always` 表示原生层支持会话级记忆。Workspace 目前只会回传 `allow_once`、`reject_once`、`cancelled`，因此适配器不应只提供“永远允许”。
- `respondToApproval` 收到 `cancelled` 时，必须中断原生轮次（不只是丢掉请求）。
- 审批超时由 Workspace 处理：先回 `cancelled`，再调用 `cancel()`；适配器必须能承受这一顺序。
- execution 已结算后才到达的审批请求，必须被拒绝或取消，不能挂起。

## 8. 取消

- `cancel(nativeId)` 的目标是当前活跃轮次；无活跃轮次时允许 no-op。
- 取消应尽快产生终态（通常是 `execution/cancelled`）；如果原生层最终报告 `completed`，就如实报 `completed`。
- 取消必须幂等：重复调用不产生第二个终态，也不报致命错误。
- 不得把“杀掉本地进程”当作已验证的原生取消；两者证据要分开记录。

## 9. 错误与诊断

- 启动失败、协议错误、未知 id 都以 rejected Promise 返回；不得让宿主进程退出。
- 错误消息要可操作：指出缺什么（程序、版本、登录、目录）以及怎么修。
- 适配器可以保留有界的 stderr 摘要用于诊断，但不得假设 stderr 不含敏感信息；不得把凭据写入日志或事件。
- 事件回调不得因单个监听器抛错而中断适配器。

## 10. 资源与隐私

- 不写全局环境变量、全局配置或原生工具的配置文件；需要覆盖时用一次性参数（例如子进程参数），并在文档中说明。
- 不复制、扫描或落盘用户凭据；登录交给原生授权入口。
- 不拼接 shell 字符串启动原生程序；argv 由驱动构造。
- 连接描述只保存驱动标识、可执行文件覆盖路径等非私有信息；绝对路径与账号状态只留在本机。

## 11. 新适配器检查清单

**必须**

- [ ] 实现全部 8 个成员，且 `capabilities` 与真实行为一致
- [ ] `start` 幂等；`stop` 后所有操作失败
- [ ] 每个 execution 恰好一个终态；终态后无事件
- [ ] 同一会话拒绝重叠 `submit`；closing 期间拒绝新提交
- [ ] 区分原生明确拒绝与提交结果不确定：未见 `turn/started` 的响应超时抛 `SubmitOutcomeUnknownError` 并保留活跃关联；已见 `turn/started` 则继续等待终态，不报 failed、不解除互斥
- [ ] 未知 `nativeId` 的 `submit` 拒绝；未知 `requestId` 的审批拒绝
- [ ] 审批请求的 `turnId` 必须属于当前活跃轮次；旧轮审批必须拒绝
- [ ] 审批的 `cancelled` 会中断原生轮次；未结算审批不会永久挂起
- [ ] `cancel` 幂等，且能到达原生层
- [ ] `close` 等到原生终态再释放；没有终态时关闭失败并保留状态，不报 cancelled
- [ ] 终态/输出/审批按协议身份字段关联当前轮次；旧轮迟到事件不影响新执行
- [ ] 进程/连接丢失时，活跃 execution 报 `unknown`
- [ ] 不重放、不重试有副作用的操作
- [ ] 目录失效时拒绝操作；使用 Project 的目录而不是宿主 cwd
- [ ] Windows 上只接受原生可执行文件；`.cmd`/`.bat` 等 shim 明确拒绝并给出可操作错误，不能“定位成功、启动失败”
- [ ] 通过 `tests/support/harness-adapter-contract.ts` 的一致性检查
- [ ] 至少一个真实原生集成测试（同一会话两轮、终态、取消、进程丢失）

**应当**

- [ ] `closeConversation` 未知 id 明确拒绝（当前 DSH 适配器把未知 id 交给原生 `session/close`，可能以超时失败告终；Codex 适配器立即拒绝）
- [ ] 审批只提供实际能被执行的决定
- [ ] 在 `docs/` 之外提供可公开的能力矩阵与已知限制

## 12. 可执行一致性测试

```ts
import { assertHarnessAdapterContract } from './support/harness-adapter-contract.js';

await assertHarnessAdapterContract({
  adapter,
  project: { id: 'contract-project', directory: projectDir },
  secondProject: { id: 'contract-project-2', directory: secondProjectDir },
});
```

当前检查项：能力字段形状、`start` 幂等、两个会话得到不同原生 id、`execution/started` 送达、重叠提交被拒、取消订阅后不再收到事件、未知 `nativeId` 提交被拒、未知审批被拒、`stop` 后提交被拒。DSH 与 Codex 两个适配器都通过同一套检查（各自的假服务端）。

**不覆盖**：审批真实放行/拒绝、取消的真实语义、关闭失败与超时、进程丢失、跨轮上下文、能力声明的真实性、提交结果不确定时的阻塞与释放、旧轮次事件的隔离。这些必须在各自适配器的测试中用协议假服务端和真实原生集成验证。

## 13. 参考实现对照

| 契约点 | DSH ACP 适配器 | Codex app-server 适配器 |
| --- | --- | --- |
| 传输 | ACP NDJSON JSON-RPC（带 `jsonrpc` 字段） | JSON-RPC over stdio（**不带** `jsonrpc` 字段） |
| 创建会话 | `session/new` | `thread/start` |
| 提交一轮 | `session/prompt` | `turn/start` |
| 完成依据 | `prompt` 响应的 `stopReason` | `turn/completed` 的 `turn.status` |
| 审批 | `session/request_permission` 服务端请求 | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` |
| 取消 | `session/cancel` 通知 | `turn/interrupt` 请求 |
| 关闭 | `session/close` | `turn/interrupt`（若有活跃轮次）→ 等 `turn/completed` → `thread/unsubscribe` |
| `resume` | `session/resume`（G017） | `thread/resume`（G017） |

## 14. 已知边界

- 两个适配器已实现原生恢复（G017）：DSH 用 `session/resume`、Codex 用 `thread/resume`；恢复只接回原生会话，不重放历史；跨进程映射由 `ConversationStore` 负责。macOS/Linux 未实测。
- 未验证单个适配器进程内多会话并发执行；当前 Workspace 是“单会话单执行”，但契约要求每个会话各自互斥。
- 远端连接、受管引擎下载、插件动态加载不在本契约范围。
- 提交结果不确定且连 turn id 都未知时，会话会保持 busy 且无法安全关闭；当前只能等待或 `stop()`。这是有意的保守行为，不是完整恢复方案。
- Windows 上 npm 常见的 `codex.cmd` shim 不被接受；需要指向原生 `codex.exe`。这是“宁可不启动，也不悄悄用 shell 拼接”的取舍。
- 本契约是行为约束，不是对上游 Harness 稳定性的承诺；`codex app-server` 仍标记为 experimental。
