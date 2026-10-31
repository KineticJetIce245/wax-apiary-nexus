# Unified Workspace

**Composable Native AI Harness Workspace**

以 Project 为中心，通过插件接入原生 AI Harness，并让持续存在的 Conversation 在不同协作结构之间组合和切换。

当前阶段：Phase 0 — Research & Architecture Validation。v2.0 是产品愿景与研究章程，技术选型仍待源码研究和 PoC 验证。

## 项目规范与本地文档

[AI 工程契约与反过度工程规则](AGENTS.md)规定项目内 AI 工作方式及敏感信息检查要求。

实现或审阅原生 Harness 适配器时，先读 [Harness Adapter 契约](contract/README.md)：能力声明、执行终态、并发与关闭、审批与取消的行为要求，以及可执行一致性检查的入口。

愿景草稿、设计提案、研究笔记、实验报告保存在本地 `docs/`，工作记录保存在本地 `LOG.md`；这些文件可能包含私人上下文，不纳入后续 Git 跟踪。`doc/` 同样被忽略。仓库的新检出不包含这些本地文件。

G001 最小内存内核的登记与查询已通过独立复核。G002 单 Harness 内核在 Windows 范围通过验收；G003 的 Codex app-server 驱动实现与自测已完成，等待独立复核。Git 保存代码、测试、必要配置及经过检查的公开说明；本地记录补充详细过程。

核心研究命题：能否在保留不同 AI Harness 原生 Agent Loop 和 Conversation 的前提下，通过插件化 Adapter 与可组合的协作运行时，实现跨 Harness 的统一管理、动态协作及运行时重组？

## 当前边界

已确定 Project-first、Native Harness First、Conversation 与协作角色解耦，以及安全执行边界上的动态重组方向。当前内核采用 TypeScript + Node.js 26 LTS + npm。Cordis 选用、已有项目的复用路线、数据库及前端框架仍待验证和决定。

目前已有内存内核、DSH ACP 适配器和 Codex app-server 适配器的实现与自测；真实原生集成只在 Windows 上运行过。先读官方源码，再用最小实验验证；不把项目宣传、接口声明或上游测试文件当成本地运行结果。

## 本地研究材料

`.research-sources/` 保存官方源码参考材料，默认排除出未来的主项目版本控制；版本与路径见研究索引。研究材料不属于产品依赖，未安装这些项目的依赖，未启动其服务。
