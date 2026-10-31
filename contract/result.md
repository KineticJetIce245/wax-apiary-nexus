# 执行结果内容契约（G006 Phase 1 + 3，v1）

本文描述一次 Execution 的结果如何携带文本、图片、文件和链接。它是 **Execution 结果**，不是流程卡（见 [`flow.md`](flow.md)），也不是 Web 渲染协议。

## 1. 范围

Phase 1 做到：

- `Execution` 保留 `output: string`，新增 `attachments`；
- `execution/attachment` 事件；
- Codex `imageGeneration` / `imageView` 映射为本地附件；
- CLI 打印附件；
- `Workbench.getResultEnvelope` 返回文本 + 附件的统一信封；
- Phase 3：`submit`/`transfer` 接受附件；Codex `localImage`；DSH 在 initialize 声明 `promptCapabilities.image` 时发送 ACP image，否则回退文本清单；Flow 节点可用 `attachments` 引用上游附件。

**不做**：Web 服务器（Phase 2 另做）、图片复制/托管、浏览器渲染、持久化；文件附件没有原生通用输入通道，只保留文本路径清单。

## 2. 类型

```ts
export type AttachmentKind = 'image' | 'file';

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  path: string;        // 本地路径；不是浏览器 URL
  mimeType: string;
  name?: string;
  byteLength?: number;
}

export type ResultPart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: Attachment }
  | { type: 'file'; attachment: Attachment }
  | { type: 'link'; href: string; title?: string };

export interface ResultEnvelope {
  version: 1;
  parts: ResultPart[];
  source: {
    connection: string;
    executionId: string;
    nativeId: string;
  };
}
```

规则：

- 文本 part 在 `output !== ''` 时放第一位；附件按到达顺序跟在后面。
- 附件的 `path` 是本地文件路径；**Phase 2 之前不得直接交给浏览器**。
- 不内嵌二进制；不把图片转成 base64 塞进事件。
- `link` part 已保留在类型中，但 Phase 1 没有适配器产生它。
- 未知类型不静默字符串化；联合类型是闭合的。

## 3. 事件与 Execution

```ts
// HarnessEvent（适配器 → Workspace）
{ type: 'execution/attachment'; executionId: string;
  attachment: { kind; path; mimeType; name?; byteLength? } }
```

Workspace：

- 只接受 running execution 的附件；迟到事件丢弃；
- 给每个附件分配 `id`，存入 `Execution.attachments`；
- 对查询返回快照，外部修改不会污染内部状态；
- 重新发出带完整附件的 `execution/attachment` 事件给 Workbench/UI。

`Execution` 新增：

```ts
attachments: readonly Attachment[];
```

`output` 保持原样，现有 Flow/Transfer/CLI 行为不变。

## 4. Codex 映射

只在 `item/completed` 处理：

| item 类型 | 字段 | 结果 |
| --- | --- | --- |
| `imageGeneration` | `savedPath` | 文件存在且是普通文件 → image/file 附件 |
| `imageView` | `path` | 同上 |
| 其他 / 缺路径 / 失败 | — | 不产生附件 |

MIME 只按扩展名保守映射：`.png`、`.jpg`/`.jpeg`、`.webp`、`.gif`；其他为 `application/octet-stream`，kind 记为 `file`。`byteLength` 来自本地 `stat`。

真实探测（2026-10-31，Windows，Codex 0.166.0-alpha.5.1）：请求生成 64x64 红色方块后，Codex 产生 `imageGeneration`，适配器发出 1 个 PNG 附件（1,171,149 bytes），文本回复包含 `IMAGE-DONE`；`getResultEnvelope` 返回 text + image 两个 part。输出尾部被截断，terminal state 字段没有逐字保留，因此不把它当作状态断言。

DSH/ACP：本阶段仍只处理文本。ACP content block 是否包含图片、DSH 是否发出，**未验证**；不写猜测映射。

## 5. API

```ts
const tagged = workbench.getExecution('codex', executionId);
const envelope = workbench.getResultEnvelope('codex', executionId);
```

- `getResultEnvelope` 要求连接仍存在；连接关闭后历史 Execution 仍在，但当前无法补 nativeId，返回 `undefined`（Phase 1 限制）。
- CLI 在收到附件时打印：

```text
[codex] attachment image generated.png (image/png)
```

## 6. 附件输入与转交（Phase 3）

```ts
workspace.submit(conversationId, text, attachments?);
workbench.submit(text, target?, attachments?);
workbench.transfer(source, executionId, target, instruction?, explicitAttachments?);
```

- `transfer` 收集源 Execution 的 `attachments`，在文本里追加附件清单（name、mime、本地路径），并把附件传给目标 `submit`。
- `transfer` 的第五个参数可补充显式附件（CLI：`--attach <path>`）；与源附件按 kind/mime/path 去重。显式附件用于工具生成但未被 Harness 登记为 Execution attachment 的本地文件。
- Codex：image/* 且 kind=image 的附件映射为 `turn/start.input` 的 `{type:'localImage', path}`；其他附件只走文本清单。
- DSH：初始化响应 `agentCapabilities.promptCapabilities.image === true` 时，把 image/* 附件编码成 ACP `{type:'image', data, mimeType}`；否则/读取失败时只发文本清单。
- Flow：submit 节点的 `attachments: ["upstreamId"]` 会把上游已产生的附件作为本次输入；引用不可用时在提交前失败。
- 附件不复制、不重试；目标 Harness 必须能访问该本地路径。文件附件没有统一的原生输入块，路径清单是回退。

真实探测（2026-10-31）：

- Codex 收到 `localImage` 后回答 `RED`；DSH 直接图片输入回答 `RED`。
- fake source → DSH transfer 返回 `submitted`、1 个附件、输入含路径、目标回答 `RED`。
- DSH 生成 `blue.png` 时 DSH 自身 `attachments` 为空；显式 `--attach blue.png` 后 transfer 输入包含附件清单，Codex 回答 `COLOR: blue`。**DSH 工具生成文件不会自动变成附件；必须显式选择，或等 DSH 协议提供文件元数据。**

## 7. 安全与 Web 边界

当前 `path` 直接来自原生 Harness，可能是项目外路径。Phase 2 要上 Web 前必须补：

1. 受控 artifact 目录/内容寻址，复制或导入附件；
2. MIME/大小/扩展名校验，SVG 等主动内容特殊处理；
3. 浏览器只能拿带鉴权的 artifact URL，不能拿任意本地路径；
4. 访问控制、清理策略、结果生命周期；
5. 大文件不 base64 内联。

## 8. 演进

- 新增 part 类型必须提升 `version` 或明确向后兼容；
- 文件附件的原生输入、附件复制/持久化、Web 写操作仍未做；
- 不把内容类型塞进流程卡；Composition/Strategy 语义不变。
