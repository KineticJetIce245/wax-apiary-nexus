# Unified Workspace

**Composable Native AI Harness Workspace**

以 Project 为中心，通过插件接入原生 AI Harness，并让持续存在的 Conversation 在不同协作结构之间组合和切换。

当前阶段：Phase 0 — Research & Architecture Validation。v2.0 是产品愿景与研究章程，技术选型仍待源码研究和 PoC 验证。

## 项目规范与本地文档

[AI 工程契约与反过度工程规则](AGENTS.md)规定项目内 AI 工作方式及敏感信息检查要求。

实现或审阅原生 Harness 适配器时，先读 [Harness Adapter 契约](contract/README.md)：能力声明、执行终态、并发与关闭、审批与取消的行为要求，以及可执行一致性检查的入口。

愿景草稿、设计提案、研究笔记、实验报告保存在本地 `docs/`，工作记录保存在本地 `LOG.md`；这些文件可能包含私人上下文，不纳入后续 Git 跟踪。`doc/` 同样被忽略。仓库的新检出不包含这些本地文件。

G001 最小内存内核的登记与查询已通过独立复核。G002 单 Harness 内核、G003 的 Codex app-server 驱动、G004 双 Harness 工作台均已通过独立复核并在 Windows 范围验收。Git 保存代码、测试、必要配置及经过检查的公开说明；本地记录补充详细过程。

核心研究命题：能否在保留不同 AI Harness 原生 Agent Loop 和 Conversation 的前提下，通过插件化 Adapter 与可组合的协作运行时，实现跨 Harness 的统一管理、动态协作及运行时重组？

## 当前边界

已确定 Project-first、Native Harness First、Conversation 与协作角色解耦，以及安全执行边界上的动态重组方向。当前内核采用 TypeScript + Node.js 26 LTS + npm。Cordis 选用、已有项目的复用路线、数据库及前端框架仍待验证和决定。

目前已有内存内核、DSH ACP 适配器、Codex app-server 适配器和双 Harness CLI 工作台，均在 Windows 范围完成实现与验收；真实原生集成只在 Windows 上运行过。先读官方源码，再用最小实验验证；不把项目宣传、接口声明或上游测试文件当成本地运行结果。

## CLI 工作台（G004）

一个进程内同时保留 DSH 与 Codex 两个命名连接，各自维持自己的原生 Conversation：

```bash
npm run build
node dist/src/workbench-cli.js <project-dir> --dsh-root <dsh-checkout> --codex-exe <codex-exe>
```

命令：`/use` 切换输入目标，`/status` 查看连接，`/approvals` 与 `/approve` 处理审批，`/cancel` 取消执行，`/transfer <source> <execution-id> <target> [instruction...] [--attach <path>]...` 显式转交一次已完成的 assistant 结果（可补充源 Execution 未登记的附件），`/records` 查看内存转交记录，`/flow run|status|cancel` 运行声明式流程，`/web start [port]|stop|status` 打开只读本地视图，`/close` 关闭单个连接，`/quit` 全部退出。缺少一侧时另一侧仍可单独使用。本实验只在 Windows 实测，没有持久化、自动多轮协作或共享文件并发写保证。

只读 Web 视图绑定 `127.0.0.1`，附件复制到受控临时目录，浏览器只拿 artifact id；不能提交、审批或取消。页面视觉沿用 DSH 的深色主题 token 与布局语言，但没有加载 DSH/Cordis 运行时。`/flow` 的格式、校验与执行语义见 [声明式流程契约](contract/flow.md)；执行结果信封见 [结果内容契约](contract/result.md)。

声明式流程用 JSON 描述，不写 TypeScript：

```bash
/flow run examples/flows/review-chain.json
/flow status
/flow cancel
```

支持顺序、条件分叉和跨连接的单层并行汇合；流程数据校验会拒绝环、未知引用、同连接并行分支等。没有循环、嵌套并行、运行中改图或跨重启恢复。示例见 `examples/flows/`，格式、校验与执行语义见 [声明式流程契约](contract/flow.md)。执行结果可通过 `Workbench.getResultEnvelope` 取得文本与本地附件；CLI 会打印附件，但当前没有 Web 展示或附件托管，见 [结果内容契约](contract/result.md)。手动 transfer 会携带源 Execution 的附件；Codex 图片走 `localImage`，DSH 在声明图片能力时走 ACP image，否则保留文本路径清单；Flow 节点可用 `attachments` 引用上游附件。

Composition Runtime（API，G007）：在既有 DSH/Codex 原生会话上运行 `single-chat` 或简单 `debate`，切换策略只增加 Composition 版本、不新建会话；当前没有 CLI/Web 入口，契约见 [composition.md](contract/composition.md)。

Native Collaboration（API，G009）：Codex 通过原生 MCP 工具 `delegate_to_worker` 调用 localhost Gateway，把任务交给 DSH，拿回 Worker Result 后继续自己的原生 turn；当前没有 CLI/Web 配置入口，契约见 [collaboration.md](contract/collaboration.md)。

## 本地研究材料

`.research-sources/` 保存官方源码参考材料，默认排除出未来的主项目版本控制；版本与路径见研究索引。研究材料不属于产品依赖，未安装这些项目的依赖，未启动其服务。
