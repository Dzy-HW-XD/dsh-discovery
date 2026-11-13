# DSH Research Workspace — Architecture Audit

- 审计对象：DeepSeek Harness `0.2.2-rc.1`
- 对应源码标签：`dsh-v0.2.2-rc.1`（commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`）
- 本机运行版本：`dsh --version` → `0.2.2-rc.1`
- 审计日期：2026-11-13
- 审计方式：只读源码审计 + 本机运行时事实核对；未修改 DSH 源码，未创建插件，未创建数据库
- 审计源码位置（临时只读参考）：`/tmp/opencode/dsh-src`
- 审计工作区：`/home/duziyu/dsh-discovery`
- 修订：2026-11-13 Phase 0 Review — 增加 Agent Lifecycle 源码验证（4.5）与状态标记

> 上游当前已有更新的 `dsh-v0.2.2-rc.3`，但本机安装并运行的版本是 `rc.1`。本文件以本机实际运行版本为准；升级 DSH 后必须重新核对本文中的 API 与格式结论。

### 验证标记

- **Verified**：已在本机 `rc.1` 源码与测试中核对，并给出文件与行号。
- **Proposed**：设计建议，尚未实现或尚未在目标版本中验证。
- **Unverified**：源码顺序支持，但没有现有测试覆盖，或需要在 Phase 2 加测试后才能作为稳定依赖。
- **Deferred**：明确留到后续 Phase。

---

## 1. 结论摘要

1. **DSH 是彻底的 Cordis 插件系统。** Session、Agent Loop、Tool Registry、LLM Adapter、Persistence、Web UI 都是插件；没有必须 patch 的特权内核。
2. **Session 是 append-only 事件日志，不是聊天记录表。** LLM 的 message history 每次从事件日志派生（`deriveMessages()`），不是第二份持久化聊天历史。
3. **Session 没有“用户结束”事件。** 原生只有 `turn/start`、`turn/end`、`step/*`、`session/disposed` 等生命周期事实。`session/disposed` 表示 Session 离开进程内 Store，不等于用户完成研究。Research Workspace 必须定义自己的 Finalize 语义。
4. **SessionHeader 没有可扩展业务字段。** 不能把 `idea_id` 直接写进 Session metadata；需要外置 Research DB 的绑定表，或在 Session Event Log 中新增事件类型。第一阶段推荐外置绑定 + 可恢复的 Pending 记录，不改变 Session 格式。
5. **官方扩展点足以完成 Research Domain。** 关键扩展点是 `session/created`、`agent/created`、`AgentSetup`、`ctx.systemPrompt.section/context`、`ctx.tools.register`、`ctx.jobs.start`、`ctx.sessionQuery`、`session/flush`、Typert Remote、Web Client Slots 和 `main` keyed slot。
6. **不需要修改 Agent Loop。** Idea Memory 注入用 scoped system-prompt context 完成；研究产出用工具写入；Session 后处理用 `session/event` / `sessionQuery` / Jobs 完成。
7. **Web UI 有正式的整页扩展点。** `main` 是 root-scoped keyed slot，保留 key `conversation`；新增 `research` panel 后用 `ctx.layout.selectPanel('research')` 打开。侧边栏通过 `sidebar.panellist` 增加入口。打开原生会话用 `ctx.uiWorkspace.openSession(sessionId)`。
8. **API 需要显式装配。** Host 侧 Remote 服务用 `@Remote` 注册；Client 侧由 `packages/api/remotes` 选择并 `$mount`。新增 Research API 需要改动这个装配点，或由 Research UI 插件自行 `$mount` 其 contribution。两方案都不触碰 Agent Loop。
9. **一致性必须用“日志为准 + 幂等投影”解决。** Session Event Log 与 SQLite 无法共享事务。Research DB 应同时保存 `last_seen_seq`（读到哪）与 `last_successfully_processed_seq`（提交到哪）；所有自动提取使用确定性幂等键，失败后从成功水位重放；文件类产物用“数据库记录为权威 + 文件可重建”或 Outbox。
10. **Memory 与 LLM 解耦是可行的，也是必须的。** Knowledge、Idea、Memory、来源、审查历史全部存于 SQLite/文件；LLM 只参与提取、生成、评审。更换模型只需更换 `ctx.llm` adapter。

---

## 2. 仓库与运行时的真实结构

### 2.1 Monorepo 结构

DSH 是 pnpm monorepo，包位于 `packages/<group>/<name>`：

```text
packages/
  core/            session, system-prompt, tools, agent, agent-loop, scope
  session/         persistence, projections, query, titles, telemetry
  api/             gateway, remotes, session-controller, workspace-controller
  client/          Web Client 插件（slots, session, workspace, sidebar, chat ...）
  bundle/          base, web-app, headless, sdk-app, sdk-minimal, acp-app
  context/         agent-instructions, file-reference, time-context ...
  llm/             llm seam 与 provider adapters
  jobs/            jobs, jobs-local, tool-jobs
  preset/          agent-preset, agent-preset-registry
  ...
apps/
  cli/             `dsh` 启动器
  desktop/         Electron 应用
  desktop-host/
```

包名不是目录名的简单拼接，但基本遵循 `@deepseek-ai/dsh-<目录名>`。新增包必须满足根仓库的 workspace 约束、TypeScript project references、tsdown 构建和 README 规范。

### 2.2 Profile / Bundle 组装

运行中的 `dsh` 不是固定应用，而是按层组合出的 Cordis 插件树：

```text
profile 的 bundles（按顺序）
  → profile 的 cordis.patch.yml
  → home patch
  → 命令行 --patch overlay
```

- **Profile**：`~/.dsh/profiles/<name>/` 下的组合声明，列出 bundles、用户 patch、out-of-tree 插件。
- **Bundle**：一个 `cordis.patch.yml` + 代码依赖，向空插件树插入带 id 的配置行；上层 patch 可以按 id 覆盖或禁用。
- 本机 `web` profile 当前只列出：
  - `@deepseek-ai/dsh-base`
  - `@deepseek-ai/dsh-web-app`

`dsh-base` 已挂载：模型适配、工具、JSONL Session 持久化、Session Query、Storage、Jobs、Sandbox、Approval、Settings、Telemetry 等。`dsh-web-app` 增加 Web Server、Web Client、Workspace、UI 等。

**对 Research Workspace 的含义：**

- 新增能力应作为一个新 bundle（例如 `@deepseek-ai/dsh-research-workspace`）叠加在 `dsh-base` 之上，而不是修改 `dsh-base`。
- 本机 profile 的 `package.json` 增加该 bundle，或在 `cordis.patch.yml` 插入 Research 插件行即可启用。
- 不需要 fork DSH 核心包；但第一阶段开发很可能在 DSH 源码仓库内新增 `packages/research/*`，以便使用 workspace 构建和类型检查。

### 2.3 本机实际数据目录

```text
~/.dsh/
  profiles/web/                  profile 与 patch
  sessions/
    --home-duziyu-...--/         normalized cwd 的项目目录
      session-<id>/
        session.v4.jsonl.zstd    当前 JSONL 格式（zstd 压缩）
        session.lock             单写者锁
  storages/
    session_projcache/            Session 列表投影缓存
  .credentials.yaml
```

Session 原始事件由 DSH 原生持久化；Research DB 不应复制完整聊天记录。

### 2.4 关键包与服务

| 包 | 作用 | `ctx` key |
|---|---|---|
| `@deepseek-ai/dsh-session` | append-only SessionEvent 日志、内存 Store | `ctx.sessions` |
| `@deepseek-ai/dsh-agent` | Agent 接口、AgentRegistry、`agent/*` 事件 | `ctx.agents` |
| `@deepseek-ai/dsh-agent-loop` | 默认 Agent Loop 驱动 | `ctx.agentLoop` |
| `@deepseek-ai/dsh-system-prompt` | prompt section/context/tool schema 组装 | `ctx.systemPrompt` |
| `@deepseek-ai/dsh-tools` | 工具注册与执行管线 | `ctx.tools` |
| `@deepseek-ai/dsh-session-persistence` | Session 持久化抽象 seam | `ctx.sessionPersistence` |
| `@deepseek-ai/dsh-session-persistence-jsonl` | JSONL/zstd 持久化实现 | 无独立 key |
| `@deepseek-ai/dsh-session-query` | live-preferred 精确读取、过滤、搜索、谱系 | `ctx.sessionQuery` |
| `@deepseek-ai/dsh-jobs` | 后台任务抽象 seam | `ctx.jobs` |
| `@deepseek-ai/dsh-agent-preset-registry` | Agent preset 注册、恢复、选择 | `ctx.agentPresets` |
| `@deepseek-ai/dsh-api-session-controller` | Session Host API / `ctx.remote.session` | `ctx.sessionController` |
| `@deepseek-ai/dsh-api-remotes` | Client Remote 装配与事件转发白名单 | 无独立业务 key |
| `@deepseek-ai/dsh-client-ui-layout` | Web AppFrame 与 `main`/`sidebar` 等 root slots | `ctx.layout` |
| `@deepseek-ai/dsh-client-ui-workspace` | Session 导航、Workspace 浏览器 | `ctx.uiWorkspace` |

---

## 3. Cordis 插件模型

### 3.1 插件形态

一个 Cordis 插件通常是一个对象：

```ts
export const name = 'my-plugin'
export const inject = ['tools', 'sessions']

export function apply(ctx: Context): void {
  ctx.tools.register(/* ... */)
}
```

或是一个继承 `Service` 的类，由 Cordis 挂载为 `ctx.<key>` 服务。注册项通过 `ctx.effect()`、`ctx.on()` 等返回 disposer；插件卸载时自动回滚。

### 3.2 事件与扩展点

Cordis 事件有明确 dispatch mode：

| 模式 | 是否等待 | 顺序 | 返回值 |
|---|---|---|---|
| `emit` | 否 | 注册顺序 | 无 |
| `waterfall` | 否 | 注册顺序，必须 `next()` | 有 |
| `parallel` | 是 | 并行 | 无 |
| `serial` | 是 | 注册顺序 | 有 |
| `bail` | 否 | 直到某个 listener bail | 有 |

Research Workspace 主要使用：

- `emit`：`session/created`、`session/event`、`session/disposed`、`agent/status` 等观察。
- `serial`：`agent/created`（创建期间必须 await）。
- `parallel`：`session/flush`（持久化屏障）。
- 自己的 `research/changed`（emit，用于 UI 刷新）。

### 3.3 Capability Seam

DSH 的稳定扩展方式是 Service Definition / Service Provider / Consumer 三角：

- Session persistence 是 seam，JSONL 是 provider。
- Job runtime 是 seam，`jobs-local` 是 provider。
- LLM 是 seam，DeepSeek/pi-ai 是 provider。
- Tool Registry 是 seam，具体工具是 consumer。

Research Workspace 也应遵循：**不要直接 import 具体实现包；通过 `ctx` key 调用服务。** 研究域内部可以先用单实现，但服务边界要清晰，避免未来换 SQLite/向量库时重写上層。

---

## 4. Session 的实际生命周期

### 4.1 创建路径

普通 Web 创建会话的实际路径：

```text
Client ctx.remote.session.create(...)
  → SessionController.create()
  → SessionCommandController.create()
  → ApiSessionAgentController.createSession()
  → ctx.agents.create({ sessionId, cwd, meta, setup })
  → AgentLoop factory:
       ctx.sessions.prepare() / enter()
       session/created（同步、只读、不可 append）
       setup(agentCtx, agent)      ← 官方组合窗口
       ctx.agents.enter() / announce()
       agent/created（serial, awaited）
       loop 启动，等待输入
```

关键事实：

1. `session/created` 触发时 Session 已进入 Store，但**在同步 listener 全部返回前不能 append 新事件**。
2. `setup(agentCtx, agent)` 是官方推荐的每次 Agent 创建/恢复的组合窗口；可以在其中注册 scoped prompt、工具、监听器。
3. `agent/created` 是 serial 且被 await；在它完成前，队列中的输入不会开始执行。
4. `AgentRegistry.create` 返回 `AgentHandle`；普通调用方通常只持有 `agent` 或 handle。
5. `SessionStore.create()` 是更底层的 primitive；Agent 创建应使用 `ctx.agents.create()`，不要绕过 Agent Loop 的创建事务。

### 4.2 Turn / Step

一次 turn 是零个或多个 step。一个 step 是一次模型请求 + 它请求的工具执行。

```text
turn/start
  claim input
  system-prompt/assemble
  agent/pre-step            waterfall，可 reject / enter(messages)
  step/start
  agent/request             waterfall（旧的控制点）
  prepareCall()
  system/message
  user/message
  request/header
  request/context
  llm/stream
  assistant/message | assistant/attempt
  tool/call
  tools/pre-execute → tools/execute → tools/post-execute
  tool/result
  step/end
  （工具要求继续 / 新输入 → 下一个 step）
  agent/turn-stopping       serial，最后一个 checkpoint
turn/end
```

`turn/end` 的 reason 包括：`completed`、`aborted`、`blocked`、`error`、`max-tokens`、`interrupted`、`forked`。其中 `interrupted` 由恢复逻辑补写，`forked` 由 fork seed 构造补写，正常 live loop 不会产生。

### 4.3 Session “结束”的真实含义

DSH 没有 `session/end` 事件，也没有“用户完成研究”的业务概念。可观察到的事实只有：

- `turn/end`：一次执行回合结束。
- `agent/status = idle`：Agent 当前没有运行中的 turn/maintenance。
- `session/disposed`：Session 从进程内 Store 移除（Agent dispose、Host 关闭、创建回滚等）。
- Session 文件仍在磁盘上；随时可以通过 `ctx.agents.resume()` 恢复。

**因此 Research Workspace 必须自己定义 Finalize：**

1. **推荐主路径**：用户或 Agent 显式调用 `research_session_finalize`（工具/命令/UI 按钮），执行总结、提取、Idea Memory 更新。
2. **增量路径**：监听 `turn/end`，在 debounce 后做一次增量 checkpoint（只处理新增事件），避免会话很长时最后一次性失败。
3. **尽力而为路径**：`session/disposed` 时 flush 并尝试 finalize；失败则写入待处理队列，下次启动重放。
4. **绝不**把 `session/disposed` 当作唯一触发点；Host 崩溃或强制退出时它可能不会发生。

### 4.4 恢复路径

```text
ctx.agents.resume({ resumeSessionId })
  → sessionPersistence.open(id, 'write')
  → 读取完整日志
  → 计算 interruptedTurnClosers（缺失 tool result、open step、synthetic turn/end{interrupted}）
  → 通过同一 write handle 追加 closers
  → ctx.sessions.prepare() / enter() / announce()
  → setup(agentCtx, agent)   ← 恢复时同样执行
  → agent/created(source: 'resume')
```

只读观察者（`session-query`）也会在内存中平衡中断 turn，但不写回。

---

### 4.5 Agent Lifecycle Validation（Phase 0 修订）

本节回答 Phase 0 Review 要求的七个问题。除特别标注外，均为 **Verified**。

#### 4.5.1 实际执行顺序（Verified）

源码：`packages/core/agent-loop/src/index.ts:621-640`、`717-742`、`819-827`。

```text
initializeAgent()
  → appendUnstoredSuffix()
  → ctx.sessions.enter(session)
  → ctx.sessions.announce(session)        // session/created
  → await setup?.(agent.ctx, agent)        // AgentSetup
  → setupCommit?.commit()
  → ctx.agents.enter(agent, owner)         // 校验 agent.id === session.id
  → await ctx.agents.announce(agent, source) // agent/created，serial
  → ready = true
  → return AgentHandle
```

关键点：

- `session/created` 在 `setup` **之前**触发；此时 Session 已进入 Store，但同步 listener 返回前不能 append。
- `setup` 在 Agent 发布 **之前**执行；`agent/created` 在 `setup` **之后**触发。
- `agent/created` 是 serial 且被 `await`；在它完成前，队列中的输入不会开始 turn。
- `setup` 失败、`setupCommit` 抛错、`agent/created` listener 抛错，都会回滚 Agent/Session 创建，且不会产生模型请求。

源码注释也明确说明：**通过 `agentCtx` 注册的 scoped tools、prompt sections/variables、restrict、listeners、awaited child plugins，都在 `agent/created` 与第一次 prompt assembly 之前存在**（`packages/core/agent/src/index.ts:104-116`）。

#### 4.5.2 新建与恢复是否都会执行 setup（Verified）

**`setup` 与 `agent/created` 在新建和恢复时都会执行。**

- 新建：`createAgent()` 把 `options.setup` 传给 `initializeAgent()`（`agent-loop/src/index.ts:734-742`），`source: 'startup'`；`initializeAgent` 随后调用 `agents.announce()` 触发 `agent/created`。
- 恢复：`resumeWith()` 读取持久化日志、补 interrupted closers、prepare 后，同样把 `options.setup` 传给 `initializeAgent()`（`agent-loop/src/index.ts:819-827`），`source: 'resume'`；同样触发 `agent/created`。
- 测试：`packages/core/agent-loop/tests/resume.spec.ts:635-653` 验证新建 `agent/created` 的 source 是 `startup`，恢复是 `resume`。
- 测试：`tests/resume.spec.ts:656-714` 验证恢复时顺序为 `session/created → setup:start → setup:end → setup:commit → agent/created`，并且 `agent.id === resumeSessionId`。

#### 4.5.3 System Prompt / scoped tools 应在哪个阶段注册（Verified for setup）

**结论：主要安装位置应是 `setup(agentCtx, agent)`，不是 `agent/created`。**

证据：

1. `packages/core/agent/src/index.ts:104-116`：setup 中通过 `agentCtx` 注册的 scoped tools、prompt sections/variables、listeners 都在 `agent/created` 和第一次 prompt assembly 之前存在。
2. `packages/core/agent-loop/tests/scope-lifecycle.spec.ts:359-380`：测试名即 “runs setup in the guaranteed slot: scoped world complete before agent/created and the first assembly”；在 setup 注册的 `systemPrompt.section` 在 `agent/created` 时已可被 assembly 看到，顺序为 `setup → agent/created → persona:You are the child.`。
3. `tests/scope-lifecycle.spec.ts:728-753`：在 setup 中 `agentCtx.tools.register(...)` + `agentCtx.systemPrompt.section(...)`，创建完成后 assembly 同时包含该 tool 和 section。
4. `tests/interception.spec.ts:578-587`：新建完成后、首次 `followup` 前没有任何 `turn/start`。
5. `tests/serial-listener-review.spec.ts:111-157`：`agent/created` serial listener 阻塞期间，队列中的 work 不开始；在 listener 完成前 `turns === 0`。

因此：

- **`systemPrompt.section` / `systemPrompt.context` / `tools.register` 放在 setup：Verified 保证第一次 LLM 请求可见。**
- 放在 `agent/created`：源码顺序上仍在首次请求前，但当前没有 “在 agent/created 注册 prompt/tools 并检查首次请求” 的测试；标为 **Unverified**。Phase 2 必须新增该测试后才能把它作为稳定 fallback。

#### 4.5.4 安装失败能否阻断 Agent 启动（Verified）

**能，而且有两种边界：**

- `setup` 抛错：创建 reject；已 announce 的 Session 被 dispose；unpublished Agent scope 被 unwind；不会发出 `agent/created`；无模型请求。
  - 测试：`tests/scope-lifecycle.spec.ts:899-920`。
  - 测试：`tests/serial-listener-review.spec.ts:77-95`（重复 prompt section 导致 setup 失败并回滚）。
- `agent/created` listener 抛错（同步或异步）：创建 reject；Agent/Session 从 registry 移除；无模型请求。
  - 同步：`tests/interception.spec.ts:613-623`。
  - 异步：`tests/scope-lifecycle.spec.ts:134-155`。
- 失败顺序：`scope-disposed → agent-disposed → session-disposed`（`scope-lifecycle.spec.ts:125`、`151`）。

**设计选择（Proposed）：**

- Research 自己创建的 Session：**fail-closed**。setup 失败则创建失败，绑定行标 `failed`，不产生“没有研究上下文”的 Session。
- 标准 UI 恢复的已绑定 Session：如果 `agent/created` fallback 安装失败，**fail-open with warning**：Session 仍可打开，但研究工具/Context 缺失，UI 显示降级提示，并写入 `last_error`。不能让 Research DB 故障阻断用户恢复会话。

#### 4.5.5 恢复时重复注册是否会产生重复监听器/工具（Verified）

**跨恢复不会重复；同一 live Agent 上重复安装会抛错。**

- 每次 create/resume 都构造新的 `ReactLoopAgent`，其构造函数调用 `createScope()` 创建新的 agent scope（`agent-loop/src/agent.ts:137-153`）。旧 Agent dispose 时 scope 被 unwind（`scope-lifecycle.spec.ts:100-151`）。
- `agent/created` 每个 Agent entry 只 announce 一次；`announce()` 有 `announced` / `announcing` guard（`packages/core/agent/src/index.ts:562-584`）。
- 同一 id 的并发 resume 被两层阻止：
  - persistence write ownership 先取得（`agent-loop/src/index.ts:787-794`）；
  - `AgentRegistry.enter()` 对 duplicate id 直接抛错（`packages/core/agent/src/index.ts:490-492`）。
- 同一 scope 内重复注册会抛错：
  - `tools.register` 重复名称：`packages/core/tools/src/index.ts:67-70`、`121-153`；
  - `systemPrompt.section` 重复名称：`packages/core/system-prompt/src/index.ts:480-494`，测试 `serial-listener-review.spec.ts:77-95`。

**因此：**

- `setup` 在每次恢复时重新运行是安全的：它在新 scope 中注册，旧 scope 已卸载。
- 如果同时使用 `setup` 和 `agent/created` 两个安装点，必须有一个幂等 guard。建议使用 `Symbol.for('dsh.research.installed')` 标记在 `agent` 对象上（HMR 后仍可识别），再加模块内 `WeakSet<Agent>` 作为快速路径；否则同一次创建会在同一 scope 注册两次并抛错。
- 不要用全局监听器累加而不 dispose；Research 的 installer 必须把每个 `ctx.effect`/`register` 的结果交给 agent scope 生命周期。

#### 4.5.6 agent.id 与 session_id 是否始终一致（Verified）

**在 new / resume / recreate 场景始终一致；fork 产生新的 child session id，Agent 使用 child id。**

- `initializeAgent()` 使用 `const id = session.id`（`agent-loop/src/index.ts:470`）。
- `ReactLoopAgent` 的 `id` 就是构造参数 `id`（`agent-loop/src/agent.ts:137-141`），由 `initializeAgent` 以 `session.id` 构造。
- `AgentRegistry.enter()` 强制 `agent.id === agent.session.id`，不一致直接抛错（`packages/core/agent/src/index.ts:484-488`）。
- 恢复测试明确断言 `agent.id === resumeSessionId`（`tests/resume.spec.ts:678-680`）。
- fork 通过 `ctx.sessions.fork()` 创建新 Session（新 id）；新 Agent 使用新 Session id。Research DB 应以 `session_id` 作为唯一业务标识，不以 `agent.id` 另建一套主键。

#### 4.5.7 推荐安装策略与最小调整（Proposed）

**原设计中 “调用 SessionController.create + 从 agent/created 安装” 需要修正。**

原因：

- `SessionController.create` 的公开请求类型不包含 `setup`（`packages/api/session-controller/src/types.ts:266-275`）；它内部调用 `ctx.agents.create` 时传的是 preset composition（`src/commands.ts:103-142`、`src/agent.ts:271-284`）。
- 我们不能修改 SessionController 来塞入 Research setup（会扩大 core API 影响面）。
- 但 `ctx.agents.create` / `ctx.agents.resume` 本身是公开 API，支持 `setup`（`packages/core/agent/src/index.ts:416-441`）。

最小调整：

1. **Research-created Session 使用自己的 `ResearchSessionCreator`：**
   - 预生成 `session_id`，写 `research_sessions(status='pending')`；
   - 调用 `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: <current defaults>, setup: installResearchComposition })`；
   - `installResearchComposition` 在 setup 中查绑定、注册 prompt section/context 和 scoped tools；
   - 创建成功后，如指定 Workspace，调用 `workspace.attachSession(sessionId)`；
   - 成功后绑定置 `active`；setup 失败则置 `failed`。
   - 这是对原方案的最小调整：**不用 SessionController.create，改为直接使用官方 AgentRegistry API**。
2. **标准 UI 创建的 Inbox Session：**
   - 不安装 Research composition；
   - 用户链接到 Idea 后，如果 Agent 仍 live，直接调用同一个 live installer（不是重新触发 `agent/created`）；
   - 如果 Agent 冷启动，标准 SessionController.resume 不传 setup；这是唯一需要 fallback 的场景。
3. **标准 UI 恢复已绑定 Research Session：**
   - 使用 `agent/created` fallback 安装；Phase 2 必须先加测试验证 prompt/tools 在首次请求可见（当前 **Unverified**）。
   - 如果测试失败，则：
     - Research UI 改用 `ctx.agents.resume({ resumeSessionId, setup })` 打开研究 Session；
     - 标准侧边栏打开的会话可能缺少研究 composition，需要 UI 提示或限制；
     - 或者向 DSH 上游提出一个 additive 的 SessionController setup hook（Deferred，需单独评审）。
4. **agent/created 的其他用途：**
   - Inbox 登记、状态观察、`research/changed`、非关键副作用；
   - 不把关键 prompt/tools 安装只放在这里，除非 Phase 2 测试通过。

#### 4.5.8 结论

- **setup 是唯一由源码和测试共同保证的“首次请求前组合窗口”。**
- **新建和恢复都会执行 setup。**
- **安装失败可以阻断启动；Research 应选择 fail-closed 或 fail-open。**
- **跨恢复不会重复注册；同一 Agent 上重复安装会抛错，必须有幂等 guard。**
- **agent.id 与 session_id 始终一致；Research DB 使用 session_id 作为业务标识。**
- **需要修改原设计的一处：Research 创建路径从 `SessionController.create` 改为 `ctx.agents.create` + setup；标准恢复路径依赖 `agent/created` fallback（Phase 2 验证）。**

---

## 5. Session Event Log 的存储与恢复

### 5.1 内存模型

`Session` 是 append-only 的 `SessionEvent[]`。每个事件：

```ts
{
  type: string
  seq: number        // 单调、连续，seq = log.length
  time: number       // epoch ms
  data: unknown      // 必须可无损 JSON 序列化
  surfaceOp?: ...    // 仅 message-producing 事件
  sourceEventSeqs?: number[]
  ignorable?: true
}
```

核心事件类型：

- `turn/start`、`turn/end`
- `step/start`、`step/end`
- `user/message`
- `system/message`
- `developer/message`
- `assistant/message`、`assistant/attempt`
- `tool/call`、`tool/result`
- `request/header`、`request/context`
- `session/end-seed`

插件可以通过 declaration merging 增加 `SessionEventMap` 成员，但新增事件类型会进入当前格式的已知词汇表；对旧 reader 的兼容性必须逐项评估。**Research Workspace 第一阶段不需要新增 SessionEventMap 成员。**

### 5.2 Surface 与历史派生

`SurfaceEventType` 是会产生 LLM message 的事件子集：`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`。

`surfaceOp` 决定事件如何进入有序 surface：

- `'append'`：追加。
- `{ op: 'replace', startSeq, endSeq }`：替换指定范围（compaction 使用）。

`deriveMessages()` 从 surface 派生模型历史；原始事件里的非 surface 事件（turn/step/tool call/request header 等）不会直接变成消息。压缩会 shadow 旧节点，但日志仍保留。

**对 Research Workspace 的含义：**

- 读取 Session 时，既要读 raw log（provenance、tool calls、turn 边界），也要读 current surface（模型实际看到的内容）。
- `ctx.sessionQuery.readSession()` 提供完整 raw log；`readSurface()` 提供 current surface；`filterEvents()` 提供语义文本和 seq。
- 研究实体应引用 `session_id + event_seq`，不要复制整段聊天。

### 5.3 持久化

默认 provider 是 `@deepseek-ai/dsh-session-persistence-jsonl`：

- 根目录：`$DSH_HOME/sessions`（本机 `~/.dsh/sessions`）。
- 每个 Session 一个目录：
  ```text
  <root>/<normalized-cwd>/<encoded-session-id>/
    session.v4.jsonl.zstd
    session.lock
  ```
- 当前格式版本是 v4；历史版本有相邻迁移链。
- 物理格式是 checksummed concatenated Zstandard frames；默认压缩，可配置 raw lines。
- 逻辑事件是 append-only；写入按 batch fsync；torn tail 在第一次新写入前截断。
- `SessionHandle` 是唯一读写入口：
  - `read(offset, length)`
  - `append(events)`
  - `flush()` ← 唯一 durability barrier
  - `close()`
- 单写者：同一 id 的第二个 write handle 会得到 `SessionAlreadyOwnedError`。

### 5.4 Flush、崩溃与恢复

- `session/event` 是同步通知，但持久化后端可以 write-behind buffer。
- `ctx.sessions.flush(session)` 是官方 durability checkpoint；Agent Loop 在每个普通 turn 前也会使用它。
- 崩溃后日志可能以 open `turn/start` 结束；持久化不自动修复，`agent-loop` resume 会补 `interrupted` closers。
- `session-query` 冷读会在内存中平衡 turn，不写回。

**对 Research Workspace 的含义：**

- 在做任何“从 Session 提取”之前，先 `await ctx.sessions.flush(session)`（live session）或确认写入已经 flush。
- 提取器必须以 `last_successfully_processed_seq` 为恢复游标；`last_seen_seq` 只表示读到哪。崩溃后从最后一个已提交的 seq 重放。
- 不要通过读取 `.jsonl.zstd` 文件来绕过 DSH；除非做离线备份工具，并显式处理格式版本。

### 5.5 格式与插件事件兼容性

- `SessionEventMap` 是可合并的。
- `KNOWN_SESSION_EVENT_TYPES` 由仓库内所有声明生成；当前格式读取时，遇到未知且没有 `ignorable: true` 的事件会拒绝重建。
- `ignorable: true` 的未知事件可以保留并跳过，但只适合“丢失不影响重建”的记录。
- 第一方插件要新增事件，必须同时处理格式目录、reader compatibility 和旧版本行为；不能只 declaration merge。
- `appendPluginRecord()` / `plugin:` 命名空间是 experimental 通道，不应作为生产 Research 数据的唯一来源。

**决策：Research 业务数据不进入 Session Event Log。** Session Log 只保存会话事实；Research DB 保存 Idea、Claim、Hypothesis、Memory 等业务实体。两者通过 `session_id + event_seq` 关联。这样不需要 v5 Session 格式，不影响旧 reader，也不复制聊天历史。

---

## 6. 官方扩展点清单

| 目标 | 官方机制 | 备注 |
|---|---|---|
| 创建/恢复 Agent 前组合 scoped 能力 | `ctx.agents.create/resume({ setup })` | 最可靠的 pre-publication 窗口 |
| 观察新 Session | `ctx.on('session/created', ...)` | 同步；不能 append；listener throw 会 veto 创建 |
| 观察恢复/创建完成 | `ctx.on('agent/created', ...)` | serial，await；在首个 prompt 前 |
| 观察每条事件 | `ctx.on('session/event', ...)` | post-commit，fire-and-forget |
| 持久化屏障 | `ctx.sessions.flush(session)` / `session/flush` | 读取前必须 flush |
| 读取历史 | `ctx.sessionQuery.readSession/readSurface/filterEvents/listSessions` | live-preferred；无需自己解析 JSONL |
| 注入稳定 prompt | `agentCtx.systemPrompt.section()` | scoped；随 Agent 卸载 |
| 注入动态 Idea Memory | `agentCtx.systemPrompt.context()` | 作为 durable user-role snapshot，变化才追加 |
| 让模型调用研究能力 | `agentCtx.tools.register()` | 可只对 research sessions 注册 |
| 拦截/改写模型请求 | `agent/pre-step`、`agent/request` | 不需要改 Agent Loop；优先少用 |
| 让模型追加 context | `agent.inject()` | 不唤醒空闲 Agent；下一次 admitted request 可见 |
| 后台任务 | `ctx.jobs.start()` | 支持 owner/unowned、取消、输出环 |
| 人类命令 | `ctx.commands.register()` | 不产生模型 turn |
| 定时研究循环 | `ctx.schedule` 或自有 scheduler + Jobs | Schedule 可投递 prompt 到 Session |
| Host API | `@Remote` + `TypertRemoteService` | 需要 `api-remotes` 装配 Client contribution |
| Web 整页 | `main` keyed slot + `ctx.layout.selectPanel()` | 保留 key `conversation` |
| 侧边栏入口 | `sidebar.panellist` list slot | 与 Plugins 页面同模式 |
| 会话导航 | `ctx.uiWorkspace.openSession(sessionId)` | 切回 Conversation |
| 实时 UI 刷新 | 自己的 `research/changed` + `api-remotes` 白名单 | 或轮询 |
| Agent preset（可选） | `@deepseek-ai/dsh-agent-preset` + registry | 可标记研究会话；不是注入 Idea Memory 的必要条件 |

---

## 7. 12 个问题的直接回答

### Q1. DSH Session 的实际生命周期是什么？

**创建：**

```text
SessionStore.prepare → enter → session/created → AgentSetup → Agent enter/announce → agent/created
```

**运行：**

```text
turn/start → [step/start → prompt assemble → LLM stream → tool calls → step/end]* → turn/end
```

**空闲/恢复：**

```text
agent/status idle → （可 resume）→ 读取持久化日志 → 补 interrupted closers → 重新创建 live Session/Agent
```

**销毁：**

```text
agent.dispose → 停止/等待 loop → session/disposed → 从 Store 移除
```

关键点：没有 `session/end`；Session 可以无限次 resume；`session/disposed` 不是业务结束。

### Q2. Session Event Log 如何存储和恢复？

- 内存：append-only `SessionEvent[]`，`seq` 连续。
- 磁盘：JSONL provider，当前 v4，`session.v4.jsonl.zstd`，每 Session 一个目录。
- 读取：通过 `SessionHandle.read()`；`session-query` 提供更高层 `readSession/readSurface/filterEvents`。
- 恢复：`ctx.agents.resume` 打开 write handle，补中断 turn 的 closers，然后 `prepare/enter/announce`。
- 一致性：`flush()` 是 durability barrier；`session/event` 不是。
- 格式：v4；历史格式迁移链；未知必需事件 fail-closed。

### Q3. 如何通过官方扩展点为 Session 关联 Idea？

**推荐：外置绑定表 + Pending 创建账本。**

1. Research DB 建 `research_sessions(session_id PK, idea_id, status, ...)`。
2. 创建研究会话时，先预生成 `session_id`，插入 `status='pending'` 的绑定行（包含 idea_id、workspace、cwd；可选 agent preset）。
3. 调用 `ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup: installResearchComposition })`（**Proposed，Phase 2 验证**）。不要用 `SessionController.create` 承载 Research setup，因为它的公开请求没有 setup 参数；直接使用官方 AgentRegistry API 是影响面最小的方案。
4. 在 setup 中根据 `session_id` 查绑定，注册 Research prompt section/context/tools。setup 是源码与测试共同保证的“首次请求前组合窗口”（Verified）。
5. 创建成功后把行改为 `active`；setup 失败则创建失败并置 `failed`，保留审计。需要 Workspace 时，创建成功后调用 `workspace.attachSession(sessionId)`。
6. 标准 UI 恢复已绑定 Session 时，SessionController 不传 setup，使用 `agent/created` fallback；该 fallback 的 prompt/tools 首次请求可见性目前为 **Unverified**，Phase 2 必须加测试。
7. 如果进程在“Session 已创建”与“行改 active”之间崩溃，启动时用 `sessionQuery`/persistence 检查 pending 行对应的 Session 是否存在，恢复为 active。
8. 标准 UI 创建的 Session：`session/created` listener 以 best-effort 插入 `status='inbox', idea_id=NULL` 行；启动时扫描持久化 Session 补齐缺失的 Inbox 行。
9. 允许一个 Session 有一个 primary Idea；其他 Idea 的知识引用写入 `research_session_idea_links`，不改变 primary 归属。

**不推荐：**

- 把 `idea_id` 塞进 `SessionHeader`：当前 header 没有自定义字段，修改会触及 core/format。
- 仅依赖 `sessionId` 字符串前缀编码 idea：不可查询、不可迁移、容易冲突。
- 新增 `research/session-bound` SessionEvent：会把业务绑定耦合进 Session 格式，并触发 reader compatibility 评审。

### Q4. 如何在创建 Session 时注入 Idea Memory？

**推荐分层：**

1. **稳定研究协议**：在 `AgentSetup(agentCtx, agent)` 中注册 `agentCtx.systemPrompt.section()`，内容固定（如何做研究、如何使用工具、禁止伪造来源、epistemic status 规则）。setup 是 Verified 的首次请求前组合窗口。
2. **Idea Brief**：在同一 setup 中从 Research DB 读取当前 Idea 状态，组装一次文本，注册为 `agentCtx.systemPrompt.context({ name: 'research:idea-brief', required: true, text: fixedText })`。
   - `PromptContext` 会作为 durable user-role snapshot 注入到 retained history 之后。
   - 在安装时固定文本，避免每轮都因 DB 变化追加新 snapshot，导致 context 膨胀。
   - 恢复会话时，如果是 Research 自己的 `ctx.agents.resume({ setup })` 路径，会重新组装当前 Brief；标准 SessionController resume 则依赖 `agent/created` fallback（Unverified，Phase 2 测试）。
3. **按需检索**：提供 `research_context_preview` / `research_memory_search` 工具，让模型在会话中主动拉取更细的知识，而不是一次性塞入全部历史。
4. **重大变化通知**：如果研究过程中创建了关键 contradiction / rejected hypothesis，可以用 `agent.inject()` 追加一条 notice（不唤醒空闲 Agent；下一次请求可见），但不要滥用。

**不要：**

- 把完整 Idea 历史、全部 Session 摘要、全部 Claim 一次性注入。
- 每次模型请求都重新生成完整 Idea Brief（会造成重复 snapshot / token 膨胀）。
- 把 Session 摘要当作结构化知识；摘要只是 L1/L2 的导航层。

### Q5. 如何在 Session 结束后获取研究产出？

三条路径并用：

1. **会话内显式工具（主路径）**：Agent 调用 `research_claim_create`、`research_hypothesis_create` 等工具，立即写入 Research DB，并携带 `origin_session_id`、`origin_event_seq`、`source_ids`、`tool_call_id`。这是最高质量、最可追溯的产出。
2. **Turn 结束后的增量提取**：监听 `session/event` 的 `turn/end`，debounce 后 `flush`，用 `ctx.sessionQuery.readSession/readSurface/filterEvents` 读取自 `last_successfully_processed_seq + 1` 以来的事件；`last_seen_seq` 只记录读到哪。生成 Session Summary 和候选 Memory/Claim。所有候选标记 `candidate` + `inferred/speculative`，等待审查。
3. **显式 Finalize**：`research_session_finalize` 执行完整总结、去重、更新 Idea Summary、Open Questions、Hypotheses、Timeline、Global Memory promotion 评估。
4. **Dispose 兜底**：`session/disposed` 时 flush 并尝试 finalize；失败则记录 `research_jobs` / `research_outbox`，下次启动恢复。

**不要**把“最后一条 assistant message”当作研究产出；它可能只是解释性文字。结构化实体必须由工具或经验证的提取器创建。

### Q6. Cordis Plugin 应该如何组织？

- 一个包一个明确职责；服务通过 `ctx.<key>` 暴露；依赖用 `inject` 声明。
- 领域包不依赖 UI；UI 包只通过 Remote 和 slots 访问 Host。
- 工具定义与工具注册分离：定义可以是纯数据/函数，注册发生在 Agent scope。
- 需要按会话组合的能力优先通过 `AgentSetup` 做 scoped 注册；`agent/created` 用于 fallback、状态观察和非关键副作用。
- 需要后台长任务的能力使用 `ctx.jobs`，不要阻塞 event listener。
- 需要人类命令的能力用 `ctx.commands`，不要伪装成模型 turn。
- 数据库写入集中在一个 writer 服务，其他包只调用服务方法；不要让多个包各自打开 SQLite 连接。
- 所有注册都返回/使用 disposer，保证 HMR 和卸载可回滚。

### Q7. 哪些能力必须新增？

必须新增：

- Idea 生命周期与关系。
- Session–Idea binding、Inbox、Finalize。
- Research SQLite schema 与迁移。
- Context Assembly Engine（Idea Brief、检索、token budget、explainability）。
- Memory Extraction / Validation / Deduplication / Promotion / Versioning。
- Knowledge entities：Source、Concept、Claim、Evidence、Relation、Contradiction。
- ResearchQuestion、ResearchGap、Hypothesis、Discovery、ResearchBranch、Decision、Artifact。
- Discovery Engine（Gap/Bridge/Contradiction/Counterfactual/Novelty）。
- Hypothesis Generator + 独立 Scientific Critic。
- Research Cycle Orchestrator（预算、checkpoint、pause/resume/recovery）。
- Research UI（Dashboard、Workspace、tabs、graph、timeline）。
- Research Remote API 与工具。
- 备份、对账、Outbox、恢复逻辑。

### Q8. 哪些能力可以复用？

直接复用：

- DSH Session Event Log、Session Persistence、Session Query。
- Agent Loop、turn/step 生命周期、工具执行管线。
- Agent Registry、Agent preset、`AgentSetup`、`agent/created`。
- `ctx.systemPrompt.section/context`。
- `ctx.tools` 与 `defineTool`。
- `ctx.jobs` 后台任务。
- `ctx.commands` 人类命令。
- `ctx.schedule` 定时投递（用于周期研究提醒）。
- `ctx.llm` adapter seam（模型无关）。
- `ctx.web`（论文/网页抓取）。
- Typert Remote、API Gateway、Connection。
- Web Client Slots、`main`/`sidebar` slots、`ctx.uiWorkspace.openSession`。
- `node:sqlite`（DSH 已有先例：session-query-sqlite、storage-sqlite）。
- DSH 的 JSONL/zstd 持久化、原子写入、锁与恢复机制。
- Agent preset 机制（可选；用于标记 research session，不是核心依赖）。

### Q9. UI 应该通过什么扩展点接入？

**整页入口：**

- `main` 是 `@deepseek-ai/dsh-client-ui-layout` 声明的 root-scoped **keyed** slot；`conversation` 是保留 key。
- 新包声明并注册 `main` 的 `key: 'research' as MainPanelId`，渲染 Idea Dashboard / Workspace。
- 用 `ctx.layout.selectPanel('research')` 打开；`ctx.layout.selectPanel(null)` 回到 Conversation。
- 在 `sidebar.panellist` 注册入口（参考 `ui-plugin-manager` 的实现）。

**会话导航：**

- `ctx.uiWorkspace.openSession(sessionId)` 切回 Conversation 并打开指定 Session。
- 不要自己实现聊天视图；复用原生 `conversation` panel。

**数据：**

- Host 侧 `@Remote` 暴露 Research API；Client 通过 `ctx.remote.research.*` 调用。
- 实时刷新用 `research/changed` 事件 + `api-remotes` 白名单，或先轮询。
- 不要复制 Session 列表/状态；用 `useSessions`/`useSession` 标准 hooks，研究面板只保存筛选和选中 Idea。

**限制：**

- 当前 Web Client 没有通用 URL router；Research panel 的“当前 Idea/子 tab”默认是内存状态，刷新后需要恢复（localStorage 或 Remote 读取最近状态）。这是 Phase 4 要明确的产品行为。

### Q10. 如何避免修改核心 Agent Loop？

全部通过事件/服务扩展：

- Idea 绑定：外置 DB + `ctx.agents.create({ setup })` 创建 + `agent/created` fallback。
- Idea Memory：`systemPrompt.section/context`。
- 研究工具：`ctx.tools.register`。
- 会话后处理：`session/event` + `sessionQuery` + Jobs。
- 长时间任务：`ctx.jobs`。
- 人类命令：`ctx.commands`。
- 定时：`ctx.schedule`。
- UI：slots + Remote。
- LLM：`ctx.llm` seam。

不需要改 `packages/core/agent-loop`、`packages/core/agent`、`packages/core/session` 的代码。唯一可能的非 Research 包改动是 `packages/api/remotes` 的装配与事件白名单；这是应用组合层，不是 Agent Loop。

### Q11. 如何保证 Session Event 和 SQLite Research DB 的一致性？

采用 **“Session Log 为会话事实权威；Research DB 为研究业务权威；幂等投影 + 对账”**：

1. **绑定账本**：先写 `research_sessions(status='pending')`，再创建 Session；创建成功后置 `active`；启动时对账。
2. **处理游标**：`research_session_checkpoints.last_successfully_processed_seq` 决定从哪重放；`last_seen_seq` 只用于诊断。
3. **幂等键**：
   - 自动提取实体：`idempotency_key = hash(session_id, event_seq, entity_type, normalized_content_hash)`，唯一约束。
   - 工具创建实体：`origin_tool_call_id` 唯一（`exec.callId`），同一 tool call 重放不会重复创建。
4. **单事务**：在同一个 SQLite transaction 中写实体 + 更新 checkpoint；失败一起回滚。
5. **Outbox**：跨介质副作用（写 artifact 文件、发通知、重建 FTS/向量）走 `research_outbox`，至少一次执行 + 幂等消费。
6. **启动对账**：
   - `pending` 绑定 vs `sessionQuery`/persistence。
   - `last_seen_seq` / `last_successfully_processed_seq` vs Session 最新 seq。
   - Artifact DB 行 vs 文件 hash。
7. **不复制聊天记录**：DB 只存结构化实体和 `session_id + event_seq` 引用；原始事件仍由 DSH 持久化。

### Q12. 如何保证未来更换 LLM 不影响 Memory？

- Memory/Knowledge/Idea 全部是 provider-neutral 的 SQLite/文件数据；不包含 LLM 上下文或 provider 私有结构。
- 所有 LLM 调用通过 `ctx.llm`；记录 `provider`、`model`、`prompt_version`、`extractor_version`，但不把 provider 作为业务主键。
- 检索默认用 SQLite FTS5；embedding 是可选索引，记录 `embedding_model`/`dimension`/`version`，可后台重建。
- Context Assembly 是确定性数据库查询 + 排序 + 模板，不依赖某个模型的 tokenizer；token 估算使用保守字符/token 比或可选 tokenizer，budget 可配置。
- Critic 与 Generator 是独立调用；更换模型只改变质量，不改变数据模型。
- 所有模型输出先进入 `candidate` / `inferred/speculative`，经审查才升级；模型替换不会“改写”已确认知识，只会产生新版本/新证据。
- Session Event Log 与 Research DB 的关联只使用 `session_id + event_seq`，与模型无关。

---

## 8. 复用 / 新增矩阵

| 能力 | 复用 DSH | 必须新增 | 说明 |
|---|---|---|---|
| Session 生命周期 | ✅ | — | 不改 loop |
| Session 事件日志 | ✅ | — | 不复制聊天 |
| Session 持久化 | ✅ | — | JSONL/zstd |
| Session 查询 | ✅ | — | 冷读/热读 |
| Agent 创建/恢复 | ✅ | — | `ctx.agents` |
| Idea 生命周期 | — | ✅ | SQLite + service |
| Session–Idea 绑定 | 部分 | ✅ | 外置表 + pending 账本 |
| Idea Memory | 部分 | ✅ | prompt context + DB |
| 结构化知识 | — | ✅ | SQLite schema |
| Context Assembly | 部分 | ✅ | 优先级/预算/解释 |
| 研究工具 | ✅ registry | ✅ 工具定义 | scoped |
| 后台任务 | ✅ jobs | ✅ 研究 job 状态 | checkpoint |
| 定时循环 | ✅ schedule | ✅ cycle 语义 | 预算/分支 |
| LLM 调用 | ✅ | — | provider-neutral |
| 网页/论文抓取 | ✅ web | 部分适配 | arXiv 等 |
| UI 整页 | ✅ slots | ✅ 组件 | `main` panel |
| UI 会话导航 | ✅ | — | `uiWorkspace` |
| Remote API | ✅ Typert | ✅ 服务 | 需装配 |
| SQLite | ✅ node:sqlite | ✅ schema | 已有先例 |
| 向量检索 | — | 可选 | v1 用 FTS5 |
| 备份/对账 | 部分 | ✅ | Research 专用 |

---

## 9. 与原始设计文档的冲突与修正

| 设计假设 | 实际 DSH | 修正 |
|---|---|---|
| 有明确的 Session 结束事件 | 没有 | 定义 `research_session_finalize` + turn checkpoint + dispose 兜底 |
| Session 可以带任意 metadata | `SessionHeader` 固定字段 | 外置 `research_sessions` 绑定表 |
| 可以直接把 Idea ID 写进 Session | 需要新增事件/格式变更 | 第一阶段不改 Session 格式 |
| 用 DSH Storage 存 Research DB | `storage` 是 document-per-row KV，不适合复杂关系查询 | 直接用 `node:sqlite`，并保留自己的迁移 |
| 需要向量数据库 | DSH 没有内建 embedding seam | v1 用 SQLite FTS5；embedding 可选、可重建 |
| UI 是路由页面 | Web Client 是 slot 组合，无通用 router | `main` keyed panel + 内存/localStorage 状态 |
| 研究产出可以从 Session 摘要直接生成 | 摘要不是结构化知识 | 工具优先；提取器只产生 candidate |
| 修改 SessionController 来传 Idea ID | 会把业务耦合进 core API | 预生成 session ID + pending 绑定 + `ctx.agents.create({ setup })`；恢复用 `agent/created` fallback |
| `session/disposed` 可靠触发 | 崩溃时可能不触发 | 不能作为唯一 finalize 触发点 |
| 插件事件可以随意加 | v4 读取对未知必需事件 fail-closed | 不加 SessionEventMap；用外置 DB |

---

## 10. 推荐的高层组件关系

```text
┌──────────────────────────────────────────────────────────────┐
│ Web Client                                                   │
│  ui-research-workspace (main panel + sidebar entry)          │
│    ├─ Idea Dashboard / Workspace tabs                        │
│    ├─ ctx.remote.research.*                                   │
│    └─ ctx.uiWorkspace.openSession(sessionId)                 │
└───────────────────────────┬──────────────────────────────────┘
                            │ Typert Remote / events
┌───────────────────────────▼──────────────────────────────────┐
│ Host: research-tools (Remote + session registry)             │
│  ├─ ResearchController (@Remote namespace "research")        │
│  ├─ setup → Idea context + scoped tools                     │
│  ├─ agent/created → fallback / observation                   │
│  └─ startup reconciliation                                   │
└───────┬───────────────────┬───────────────────┬──────────────┘
        │                   │                   │
┌───────▼──────┐   ┌────────▼────────┐   ┌──────▼─────────────┐
│ research-    │   │ research-       │   │ research-          │
│ core         │   │ knowledge       │   │ memory             │
│ Idea/Session │   │ Source/Claim/   │   │ Extract/Validate/  │
│ Artifact/DB  │   │ Evidence/Graph  │   │ Context Assembly   │
└───────┬──────┘   └────────┬────────┘   └──────┬─────────────┘
        │                   │                   │
        └───────────────────┴───────────────────┘
                            │
                 ┌──────────▼──────────┐
                 │ research-discovery  │
                 │ Gap/Bridge/Critic   │
                 │ Hypothesis/Cycle    │
                 └──────────┬──────────┘
                            │
                 ┌──────────▼──────────┐
                 │ SQLite + files      │
                 │ $DSH_HOME/research  │
                 └─────────────────────┘

DSH native (reused, unchanged):
  Session Event Log / Persistence / Query
  Agent Loop / Agents / Tools / Jobs / System Prompt
  LLM seam / Web / Schedule / Remote / Slots
```

---

## 11. 关键运行时事实与证据索引

| 事实 | 源码/文档 |
|---|---|
| Session 是 append-only event log | `packages/core/session/src/types.ts:287`（`SessionEventMap`）, `src/index.ts:806`（`append`） |
| `SessionHeader` 固定字段 | `packages/core/session/src/types.ts:95-140` |
| Session 格式 v4 | `packages/core/session/src/types.ts:90` |
| `session/created` / `session/event` / `session/flush` | `packages/core/session/src/index.ts:56,76,84,1297,1345` |
| `session/created` 期间禁止 append | `packages/core/session/src/index.ts:878` |
| `ctx.sessions` API | `docs/subsystems/session.md#ctxsessions--sessionstore` |
| `session/created` / `session/event` / `session/flush` | `docs/subsystems/session.md#session-events` |
| JSONL 持久化与恢复 | `docs/subsystems/persistence.md`, `packages/session/session-persistence-jsonl/README.md` |
| Agent 创建与 setup | `docs/subsystems/core.md`, `packages/core/agent/src/index.ts` |
| `agent/created` serial | `docs/subsystems/core.md#agentcreated--serial` |
| System prompt section/context | `packages/core/system-prompt/src/index.ts:485-535`；`docs/subsystems/system-prompt.md` |
| Tool registry | `packages/core/tools/src/index.ts:121-153`；`docs/subsystems/tools.md` |
| Jobs | `docs/subsystems/jobs.md` |
| Session Query | `docs/subsystems/session-query.md` |
| Agent preset | `packages/preset/agent-preset/README.md` |
| Remote API | `packages/api/remotes/src/client/index.ts:191-199`（装配）；`docs/api-gateway.md`, `docs/cookbook/adding-a-remote-api.md` |
| Web Client slots | `docs/subsystems/slots.md`, `docs/subsystems/web-client.md` |
| `main` keyed slot 渲染 | `packages/client/ui-layout/src/client/AppFrame.tsx:49` |
| `main` keyed panel / `selectPanel` | `packages/client/ui-layout/README.md`, `packages/client/ui-layout/src/client/AppFrame.tsx` |
| 会话导航 | `packages/client/ui-workspace/README.md`, `src/client/navigation.ts` |
| `node:sqlite` 先例 | `packages/session-query/session-query-sqlite`, `packages/storage/storage-sqlite` |
| setup 在 `session/created` 之后、`agent/created` 之前 | `packages/core/agent-loop/src/index.ts:621-640` |
| setup 在新建和恢复都执行 | `packages/core/agent-loop/src/index.ts:717-742`, `819-827` |
| setup 注册的 prompt/tools 在首次请求前可见 | `packages/core/agent-loop/tests/scope-lifecycle.spec.ts:359-380`, `728-753` |
| `agent/created` serial 且阻塞队列工作 | `packages/core/agent/src/index.ts:562-584`; `tests/serial-listener-review.spec.ts:111-157` |
| setup 抛错回滚创建 | `tests/scope-lifecycle.spec.ts:899-920` |
| `agent/created` 抛错回滚创建、无模型请求 | `tests/interception.spec.ts:613-623` |
| `agent.id === session.id` | `packages/core/agent-loop/src/index.ts:470`; `packages/core/agent/src/index.ts:484-488`; `tests/resume.spec.ts:678-680` |
| 重复注册在同一 scope 抛错 | `packages/core/tools/src/index.ts:67-70`; `packages/core/system-prompt/src/index.ts:480-494` |
| SessionController.create 不接受 setup | `packages/api/session-controller/src/types.ts:266-275`; `src/commands.ts:103-142` |

---

## 12. 未决问题（需要在 Phase 1 前确认）

1. **研究数据根目录**：默认 `$DSH_HOME/research`，还是允许每个 Workspace 使用 `<workspace>/.dsh/research`？本审计建议默认 `$DSH_HOME/research`，配置可覆盖；理由是与 DSH 数据约定一致，且不污染代码仓库。
2. **多 Host 并发**：Desktop 与 CLI 是否可能同时打开同一 `$DSH_HOME`？Research DB 需要单写者假设或跨进程锁。Phase 1 先按单 Host 设计，用 `BEGIN IMMEDIATE` + busy_timeout；多 Host 作为显式限制。
3. **是否使用 Research preset（可选）**：若使用，`research` 是否与用户已有 preset 冲突？需要命名空间或启动时检测；当前推荐不依赖 preset。
4. **Inbox 语义**：标准 UI 创建的 Session 是否自动进入 Inbox（建议是），还是只有用户手动“Link to Idea”才进入？
5. **Finalize 的产品语义**：是用户显式按钮，还是每个 turn 后自动增量？建议两者都有，但“Finalize”只由用户/Agent 显式触发。
6. **Global Memory 自动提升**：建议默认关闭自动 promotion，必须有独立 Review；否则会重蹈“LLM 自评创新性”的问题。
7. **远程/多用户**：当前 Remote Access 按 Peer 授权；Research API 需要定义资源策略（Idea 归属、共享 Workspace）。Phase 1 单用户本地优先。
8. **agent/created fallback（Unverified）**：当前没有测试证明在 `agent/created` 中注册 `systemPrompt.section/context` 与 scoped tools 能被首次请求看到；Phase 2 必须先加测试。失败时的最小调整见 4.5.7。
9. **Workspace attach（Proposed）**：Research 自建 `ctx.agents.create` 后调用 `workspace.attachSession` 的顺序/失败语义需要在 Phase 2 验证；`attachSession` 会校验 Session header 的 cwd（`packages/workspace/workspace/src/entity.ts:110-135`）。

---

## 13. 审计结论

Research Workspace 可以完全建立在 DSH 的官方扩展点上：

- **不改 Agent Loop。**
- **不改 Session 格式。**
- **不复制聊天历史。**
- **不引入额外服务依赖。**
- **不把 LLM 变成 Memory 的拥有者。**

真正的工程难点不在“能不能接”，而在：

1. Session 没有业务结束语义，必须设计 Finalize/checkpoint/recovery。
2. Session Log 与 SQLite 没有共享事务，必须做幂等投影与对账。
3. Idea Memory 不能一次性全量注入，必须做 Context Assembly 与预算。
4. Hypothesis/Critic 必须逻辑分离，不能把模型自评当证据。
5. UI 是 slot 组合而非路由，Idea 入口需要显式导航设计。

**Phase 0 修订发现的唯一路径性冲突：**

- 原计划用 `SessionController.create` 创建 Research Session，再在 `agent/created` 安装 Research prompt/tools。
- 源码验证表明：`SessionController.create` 不暴露 `setup`；`setup` 才是源码/测试保证的首次请求前组合窗口；`agent/created` 的 prompt/tools 首次请求可见性尚无测试覆盖（Unverified）。
- 因此 Phase 2 采用：**Research 自建 Session 走 `ctx.agents.create({ setup })`；标准恢复走 `agent/created` fallback（Phase 2 先验证）**。这不是架构推翻，而是创建路径的最小修正。

这些都在 `IMPLEMENTATION_PLAN.md`、`DATA_MODEL.md`、`MEMORY_DESIGN.md`、`CHANGE_IMPACT_ANALYSIS.md` 中展开。
