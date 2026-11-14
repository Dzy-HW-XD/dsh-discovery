# Phase 3 — Research Artifact Database Completion Report

- 日期：2026-11-14
- 阶段：Phase 3（Batch B 第一阶段）
- 状态：功能与服务层验收通过；Batch B 继续进行 Phase 4
- 数据库：Research schema v3

## 1. 实现范围

- 新增共享 `research_sources`、`research_idea_sources`、`research_source_locations`。
- 新增 `research_concepts`、`research_claims` + `research_claim_versions`、`research_evidence`、`research_relations`。
- 新增 `research_questions`、`research_gaps`、`research_hypotheses` + versions + evidence links。
- 新增 `research_discoveries`、`research_decisions`、`research_artifacts`、`research_branches`、`research_session_summaries`。
- 扩展 `research_sessions` 与 `research_timeline_events` 的 `branch_id`。
- `ResearchArtifactStore` 统一校验 Idea 归属、实体存在性、epistemic 输入与 provenance。
- Claim / Hypothesis 更新追加不可变版本快照。
- Source 按 DOI / arXiv / canonical URL 复用；Source 可跨 Idea 共享。
- Artifact 内容写临时文件、rename、计算 SHA-256、再提交数据库；`verifyArtifact` 检测缺失与篡改。
- Timeline 在 Source、Claim、Evidence、Relation、Question、Gap、Hypothesis、Discovery、Decision、Artifact、Branch 写入时追加。
- Session Summary 按事件范围追加快照并 supersede 旧版本。

## 2. 模型工具

绑定 Research Session 后提供：

- `research_source`
- `research_concept`
- `research_claim`
- `research_evidence`
- `research_graph`
- `research_question`
- `research_gap`
- `research_hypothesis`
- `research_discovery`
- `research_artifact`
- `research_branch`
- `research_decision`

所有工具从运行中的 Agent 与 `exec.callId` 记录 provenance，不接受模型提供的 origin 字段。

## 3. 数据库迁移

- `RESEARCH_SCHEMA_VERSION = 3`，`RESEARCH_DATABASE_LAYOUT_VERSION = 3`。
- 新增 migration v3，已验证从 Phase 2 数据库升级，`research_schema_migrations` 记录 1/2/3。
- 所有 Phase 3 表使用 `STRICT`、外键与受控 CHECK 枚举。

## 4. 实际执行的测试

```sh
corepack pnpm exec vitest run \
  packages/research/research-core/tests \
  packages/research/research-tools/tests \
  packages/client/ui-research-workspace/tests
```

结果：**10 个测试文件，53 个测试全部通过**。

新增覆盖：

- Source 复用、Idea 关联、locator。
- reported Claim 必须有 Source。
- Claim 版本历史与乐观校验。
- Evidence 的 reported quote 校验、Claim/Source/locator 归属校验。
- 知识关系端点存在性、跨 Idea 拒绝、重复关系幂等。
- Question / Gap / Hypothesis / Discovery / Decision / Branch 的创建、更新与版本。
- Hypothesis ↔ Evidence 链接。
- Artifact 原子写入、SHA-256 校验、篡改检测、pending 状态。
- Session Summary 版本与事件范围校验。
- v1 → v2 → v3 与 v2 → v3 迁移。
- 通过真实 Agent 与 `ctx.tools.execute` 创建 Source、Claim、Evidence、Relation、Hypothesis、Artifact、Question、Gap、Discovery、Decision、Branch，并验证 provenance。

## 5. 已知限制

- Phase 3 只提供模型工具与服务层；浏览器尚无 artifact 读取/编辑 Remote 面，Phase 4 补充。
- 未实现 Hypothesis review、Discovery engine、Memory extraction、Context assembly。
- Artifact 只接受文本内容；二进制附件属于后续阶段。
- SQLite 仍为同步单连接；适合研究工作区规模，不适合批量导入。
- 关系端点由 service 层校验，SQLite 无法跨表外键。
