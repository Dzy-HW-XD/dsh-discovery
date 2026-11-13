# DSH Research Workspace — 长期执行治理与开发授权规范

- 文档类型：项目执行治理规范
- 项目：DSH Research Workspace
- 目标仓库：DeepSeek DSH（`0.2.2-rc.1` 基线）
- 开发环境：OpenCode + DeepSeek Flash
- 架构审计：Phase 0 已完成
- 开发授权：Phase 1–9 整体授权
- 执行模式：分批次自主执行 + 验收门禁 + 自动推进

> 本文是执行治理规则，不取代五份权威架构文档。若本文与架构文档冲突，按第 1.1 节处理。

## 1. 授权与权威文档

已获得 Phase 1–9 整体开发授权；按 Batch A–E 顺序执行。每批通过验收门禁后可自动进入下一批，不需要逐批请求用户批准。

权威文档：

- `ARCHITECTURE_AUDIT.md`
- `IMPLEMENTATION_PLAN.md`
- `DATA_MODEL.md`
- `MEMORY_DESIGN.md`
- `CHANGE_IMPACT_ANALYSIS.md`

冲突处理：指出冲突、标记 Phase/组件、分析影响、提出最小兼容修正；涉及已确认架构决策时暂停并等待确认。禁止静默忽略或修改架构。

## 2. 批次

| 批次 | 阶段 | 目标 |
|---|---|---|
| A | Phase 1–2 | Idea 与 Session 基础设施 |
| B | Phase 3–4 | 研究数据系统与 Workspace UI |
| C | Phase 5–6 | 长期记忆与上下文组装 |
| D | Phase 7–8 | 知识图谱与科学发现 |
| E | Phase 9 | 自主研究执行引擎 |

顺序不可改变；前一批未通过验收，不得进入下一批。

## 3. 强制工程规范

- 源码优先：改动前阅读真实源码、接口、类型、依赖、测试和运行行为；禁止臆测 DSH API。
- Change Impact Analysis：识别 Packages、Services、API、Remote API、DB、Data Models、UI、Session Lifecycle、Plugins、Event Processing、兼容性、Tests 的影响。
- 测试：Unit / Integration / UI / Migration / Restart / Failure / Recovery；使用 Mock LLM；GPU-free；只有实际执行后才能报告通过。
- 禁止虚假完成：不得用硬编码、静态数据、空 Stub、Mock 内部调用冒充真实功能；不得静默吞异常；持久化失败不得推进状态。
- 向后兼容：优先保留 DSH 原生行为；不改 Agent Loop、Session Event Format、Session Header Schema、现有 Conversation UI、现有扩展机制，除非完成影响分析并等待确认。
- 数据完整性：Stable IDs、显式状态流转、Versioning、Supersession、Timeline、Provenance、Idempotency；禁止破坏性覆盖。
- 文档同步：每批生成 `reports/BATCH_<A-E>_COMPLETION.md`，并更新 `EXECUTION_STATUS.md`。

## 4. 暂停条件

遇到以下情况必须暂停并提交完整分析：

1. DSH 行为与已批准架构根本冲突。
2. 需要改变 Core Session 或 Agent Loop 语义。
3. 需要破坏性或不可逆数据迁移。
4. 权威文档之间存在未解决的重大冲突。
5. 安全或数据完整性问题无法在现有设计内解决。
6. 当前功能无法在 Phase 边界内实现。
7. 合理调试后当前批次仍无法通过验收门禁。

暂停报告必须包含：精确阻塞、源码/测试证据、受影响组件、无法继续的原因、最小可行修正、可选方案与代价、推荐决策。

## 5. 执行状态

维护 `docs/research-workspace/EXECUTION_STATUS.md`，至少跟踪：

- 当前 Batch / Phase
- 已完成 / 待完成 Phase
- 验收门禁结果
- 已知阻塞
- 架构决策
- 数据库 Migration 版本
- 最新完成报告
- 下一步授权执行内容

只有通过验收门禁，才能标记 Phase 完成。

## 6. 最终验收目标

系统必须能完整演示：

1. 创建长期 Idea。
2. 在 Idea 下创建 Session。
3. Agent 跨 Session 持续研究。
4. 研究产出结构化 Artifact。
5. Session 信息提取到 Memory。
6. Context Assembly 检索历史研究。
7. Knowledge Graph 关联 Claim/Evidence/Concept/Idea。
8. Discovery Engine 发现 Gap/Contradiction。
9. Scientific Critic 审核 Hypothesis。
10. Orchestrator 有预算地规划与执行。
11. 多 Research Branch 可比较。
12. 可暂停、重启恢复。
13. 每个重要结论可追溯到 Evidence。
14. 研究历史保留而非覆盖。

最终在无 GPU 条件下，通过 Literature-driven Research 与 Mock LLM 测试验证完整流程。
