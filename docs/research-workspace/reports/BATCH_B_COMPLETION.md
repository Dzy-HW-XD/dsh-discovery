# Batch B — Research Artifacts and Idea Workspace Completion Report

- 日期：2026-11-14
- 批次：Batch B（Phase 3–4）
- 状态：Phase 3 / Phase 4 功能与自动化验收通过；Batch B 验收门禁通过
- 下一批次：Batch C / Phase 5（未在本批次实现）
- 数据库：Research schema v3

## 1. Phase 3 — Research Artifact Database

- Migration v3 新增 Sources、Idea-Source links、Source locators、Concepts、Claims + versions、Evidence、Knowledge relations、Questions、Gaps、Hypotheses + versions + evidence links、Discoveries、Decisions、Artifacts、Branches、Session Summaries。
- `ResearchArtifactStore` 校验 Idea 归属、实体存在性、epistemic 输入与 provenance。
- Claim / Hypothesis 更新追加不可变版本；Question / Gap / Branch 使用 version 列。
- Source 按 DOI / arXiv / canonical URL 复用，并可跨 Idea 共享。
- Artifact 内容写临时文件、rename、SHA-256、再提交数据库；`verifyArtifact` 检测缺失与篡改。
- 绑定 Research Session 的模型工具：`research_source`、`research_concept`、`research_claim`、`research_evidence`、`research_graph`、`research_question`、`research_gap`、`research_hypothesis`、`research_discovery`、`research_artifact`、`research_branch`、`research_decision`。
- 所有工具从运行中的 Agent 与 `exec.callId` 记录 provenance。

## 2. Phase 4 — Idea Workspace UI

- 新增 `research.getWorkspace` Remote 投影：counts、entities、knowledge relations、Sessions、timeline。
- Idea 详情增加 7 个标签页：Overview、Sessions、Knowledge、Graph、Artifacts、Memory、Timeline。
- Overview 展示 Host 计数与最近事件；Knowledge 展示 Source / Concept / Claim / Evidence / Question / Gap / Hypothesis / Discovery / Decision / Branch。
- Graph 展示 Phase 3 知识关系；Artifacts 展示产出状态；Memory 是 Phase 5 前的明确空状态。
- 保留 Phase 1 的 Idea 创建、状态、父子、归档、关系编辑与 Phase 2 的 Session 创建/打开/解绑/finalize/Inbox 绑定。
- 不伪造数据：所有标签页读取 Remote 投影，空状态明确。
- UI 文案全部进入 8 种语言字典；新增 locale 元数据继续通过 `verify-locale-metadata`。

## 3. 修改的文件

- `packages/research/research-core/src/database.ts` — schema v3 migration。
- `packages/research/research-core/src/artifact-types.ts` — Phase 3 领域类型与品牌。
- `packages/research/research-core/src/artifacts.ts` — artifact store、版本、校验、文件写入。
- `packages/research/research-core/src/index.ts` — 暴露 `ctx.researchCore.artifacts`。
- `packages/research/research-core/tests/artifacts.spec.ts` — Phase 3 服务测试。
- `packages/research/research-core/tests/sessions.spec.ts` — v2→v3 迁移测试。
- `packages/research/research-tools/src/artifact-tools.ts` — 12 个 Session-scoped 工具。
- `packages/research/research-tools/src/composition.ts` — 安装 artifact 工具。
- `packages/research/research-tools/src/index.ts` — `getWorkspace` Remote。
- `packages/research/research-tools/src/types.ts` — Workspace wire types。
- `packages/research/research-tools/tests/session-lifecycle.spec.ts` — 真实 Agent 工具执行与 Workspace Remote 覆盖。
- `packages/client/ui-research-workspace/src/client/ResearchPanel.tsx` — Workspace 标签页。
- `packages/client/ui-research-workspace/src/client/index.ts` — `getWorkspace` 注入。
- `packages/client/ui-research-workspace/src/client/locales.ts` — 8 种语言标签页文案。
- `packages/client/ui-research-workspace/tests/research-panel.client.spec.tsx` — Workspace 标签页测试。
- `packages/experimental/liveshare/src/endpoint-classification.ts` — `research/getWorkspace` owner-only。
- 研究包 README 与中文配对、Phase 3 完成报告、本报告、状态文档。

## 4. 实际执行的测试

```sh
corepack pnpm exec vitest run \
  packages/research/research-core/tests \
  packages/research/research-tools/tests \
  packages/client/ui-research-workspace/tests
```

结果：**10 个测试文件，54 个测试全部通过**。

覆盖：

- Source 复用、Idea 关联、locator。
- reported Claim / Evidence 的引用校验。
- Claim / Hypothesis 版本历史。
- 知识关系端点、跨 Idea 拒绝、重复关系幂等。
- Question / Gap / Discovery / Decision / Branch。
- Artifact 原子写入、SHA-256、篡改与缺失检测。
- Session Summary 版本与事件范围。
- v1→v2→v3、v2→v3 迁移。
- 真实 Agent + `ctx.tools.execute` 创建全部 Phase 3 实体。
- Workspace Remote 投影与 UI 标签页、空状态、Session 操作。

```sh
corepack pnpm run typecheck      # 5 gates passed
corepack pnpm run build:lib:host
corepack pnpm run build:lib:client
corepack pnpm run build:check    # 2 gates passed
corepack pnpm run lint           # warning only: pre-existing cot-translation directive
corepack pnpm run hygiene        # 23 gates passed
corepack pnpm run verify-md-links
corepack pnpm run verify-client-ui-i18n
corepack pnpm run verify-package-readme-model-experience
corepack pnpm run verify-package-readme-limitations
corepack pnpm run verify-tool-catalog
corepack pnpm run verify-translation-pairing <README pairs>
```

## 5. Batch B 验收门禁

| 验收项 | 结果 |
|---|---|
| Phase 3 Services 与迁移测试 | Passed |
| Claim / Hypothesis 版本历史 | Passed |
| Provenance 与来源追溯 | Passed |
| Artifact 文件与 hash 校验 | Passed |
| 按 Idea 查询全部实体 | Passed（`research_graph` / `getWorkspace`） |
| Phase 4 Workspace 标签页 | Passed（jsdom） |
| 空状态与无假数据 | Passed |
| 原生 Conversation / Session 导航兼容 | Passed |
| Typecheck / Build / Lint / Hygiene | Passed |

Batch B 验收门禁通过。

## 6. 已知限制

- 真实 Web 浏览器 E2E 未执行；UI 证据为 jsdom 组件测试与真实 Cordis/SlotRegistry 注册测试。
- Memory 标签页是 Phase 5 占位，不展示伪造记录。
- UI 只读 Phase 3 实体；创建/更新由 Session-scoped 工具完成。
- Artifact 只支持文本内容；二进制附件属于后续阶段。
- 未实现 Hypothesis review、Discovery engine、Context Assembly、Orchestrator。
- SQLite 为同步单连接；关系端点由 service 层校验。

## 7. 下一批次准入

Batch B 通过全部验收门禁，按整体授权进入 Batch C / Phase 5（Memory Manager）。
