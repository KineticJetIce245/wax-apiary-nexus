# Unified Workspace

**Composable Native AI Harness Workspace**

以 Project 为中心，通过插件接入原生 AI Harness，并让持续存在的 Conversation 在不同协作结构之间组合和切换。

当前阶段：Phase 0 — Research & Architecture Validation。v2.0 是产品愿景与研究章程，技术选型仍待源码研究和 PoC 验证。

## 文档入口

- [AI 工程契约与反过度工程规则](AGENTS.md)：项目内 AI 工作规范，保留项目所有者的重大决策权。
- [完整愿景与研究章程 v2.0](docs/vision.md)：原样保存用户提供的讨论结果。
- [整体设计大纲](docs/architecture.md)：模块边界与需要回答的设计问题。
- [当前小目标 G001 与 DeepSeek 交接](docs/current-goal.md)：引用泄漏已修正并补回归测试，待 Codex 再复核。
- [内核技术决定](docs/adr/0001-kernel-language.md)：TypeScript + Node.js 26 LTS + npm，已采纳。
- [Git 追踪约定](docs/git-trace.md)：目标、提交与验收证据的关联。
- [Cordis 初步研究](docs/research/cordis.md)：独立插件运行时、DSH vendoring、生命周期和能力边界。
- [AionUi / AionCore 初步研究](docs/research/aionui.md)：原生会话接入、恢复、团队通信与复用边界。
- [研究索引与下一步](docs/research/README.md)：证据状态、研究顺序、实验验收条件。
- [工作记录](LOG.md)：已完成事项及未验证事项。

核心研究命题：能否在保留不同 AI Harness 原生 Agent Loop 和 Conversation 的前提下，通过插件化 Adapter 与可组合的协作运行时，实现跨 Harness 的统一管理、动态协作及运行时重组？

## 当前边界

已确定 Project-first、Native Harness First、Conversation 与协作角色解耦，以及安全执行边界上的动态重组方向。当前内核采用 TypeScript + Node.js 26 LTS + npm。Cordis 选用、已有项目的复用路线、数据库及前端框架仍待验证和决定。

目前只有 G001 的最小内存内核实现，没有已通过的 Harness 实测。先读官方源码，再用最小实验验证；不把项目宣传、接口声明或上游测试文件当成本地运行结果。

## 本地研究材料

`.research-sources/` 保存官方源码参考材料，默认排除出未来的主项目版本控制；版本与路径见研究索引。研究材料不属于产品依赖，未安装这些项目的依赖，未启动其服务。
