# P2 交付形态实现计划（Docker/NAS + npm + 部署文档）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「所有人都能自己部署」成立：可发布的 core/daemon npm 包、多架构 Docker 镜像与 NAS compose 模板、三路线部署文档。

**Architecture:** 零运行时依赖不变。npm 侧把两个 workspace 包从 `private` 改为可发布，daemon 依赖 core 的版本范围；Docker 侧用多阶段构建先把两个本地包 `npm pack` 成 tarball，再在干净 node:22-alpine 里安装，避免把整个 monorepo 带进镜像。文档把 PVE/systemd、NAS/Docker、Windows 三条路径分开写，并明确「本机未装 Docker、未执行 npm publish」的事实。

**Tech Stack:** Node 22、npm workspaces、Docker buildx（镜像需多架构）、Markdown/YAML（无新增运行时依赖）。

**Spec:** `docs/superpowers/specs/2026-11-03-saigai-bot-daemon-design.md` §9（P2）

## Global Constraints

- **零新增运行时依赖**（core/daemon 仍只依赖 Node 内建与彼此）。
- 服务端 `server/` 零改动；现有部署模型（`npm install && npm run build && npm start`）不变。
- API key 红线（A1/A3）不变：镜像、compose、文档都只能用 `KUO_LLM_KEY` 环境变量占位，不得内联任何 key。
- 本机没有 Docker：镜像/ compose **不得宣称已本地验证**；文档与提交说明如实写「未实测」。
- 本机 npm 未登录：**不执行 `npm publish`**；只准备可发布元数据 + `npm pack --dry-run` 证据。
- 仓库没有 LICENSE 文件：包元数据写 `"license": "UNLICENSED"`，文档把「发布前先选许可证」列为人工前置条件。
- 质量门：daemon 测试（含新 packaging 测试）、`npm test`、`npm run build`、`npm run lint` 全绿；`npm pack --dry-run` 两个包内容正确。

## Review Focus

1. **发布物泄漏/缺失**：包 `private` 未去除、`files` 漏掉运行时文件（尤其 P4 新增的 `humanize*.js`）、daemon 依赖 core 仍写 `*`、发布顺序（core 先于 daemon）未写清。
2. **容器数据不持久/权限错**：`/data` 未 chown 给 node 用户、compose 未把宿主 `./data` 挂到 `/data`、config 挂载非只读、容器以 root 运行。
3. **API key 进镜像/文档**：Dockerfile、compose、部署文档出现明文 key，或样例配置把 `process.env.KUO_LLM_KEY` 换成字面量。
4. **NAS 可用性**：compose 的 `restart: unless-stopped`、Uid/Gid 映射说明、镜像需 amd64+arm64、buildx 命令缺失。
5. **文档承诺超前于现实**：把未实测的 Docker 构建/未执行的 npm 发布写成「已验证」；Windows 计划任务被写成已实现。

---

### Task 1: npm 包可发布化 + 包内 README + 元数据测试

**Files:**
- Modify: `packages/bot-core/package.json`
- Modify: `packages/bot-daemon/package.json`
- Create: `packages/bot-core/README.md`
- Create: `packages/bot-daemon/README.md`
- Test: `packages/bot-daemon/tests/packaging.test.js`

**Interfaces:**
- Produces: core 包 `name/version/description/license/repository/files/engines/main/exports`；daemon 包同套字段 + `bin` + `files` + `dependencies.kuoluosaigai-bot-core = "^0.1.0"`。两个包都不再有 `"private": true`。

- [ ] **Step 1: 写失败测试**：读两个 package.json，断言 `private` 不为 true、`license` 为 `UNLICENSED`、`repository.directory` 分别为 `packages/bot-core` / `packages/bot-daemon`、core 的 `files` 覆盖全部 `.js`（含 `humanize.js`/`humanize-corpus.js`）、daemon 的 `files` 含 `bin` 与 `deploy`、daemon 依赖为 `^0.1.0`、两份 README 存在且含 `saigai-bot` / 用法命令。
- [ ] **Step 2: 运行确认失败**：`npm test --workspace kuoluosaigai-bot-daemon` → packaging.test.js 断言失败。
- [ ] **Step 3: 实现元数据与 README**：填字段、去 `private`、依赖改 `^0.1.0`；README 写安装/运行/配置/权限与文档链接，不写未验证承诺。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`feat(bots): npm 包可发布化与包内 README（P2）`。

### Task 2: Docker 镜像 + NAS compose

**Files:**
- Create: `.dockerignore`
- Create: `packages/bot-daemon/deploy/Dockerfile`
- Create: `packages/bot-daemon/deploy/compose.yaml`
- Test: `packages/bot-daemon/tests/packaging.test.js`（追加 Docker describe）

**Interfaces:**
- Produces: 镜像入口 `saigai-bot`，默认 `run --config /config/saigai-bot.config.js --data-dir /data`；容器内 `/data` 归 uid 1000（node）；compose 服务名 `saigai-bot`，`restart: unless-stopped`，`./config:/config:ro`、`./data:/data`、`KUO_LLM_KEY`/`TZ` 环境变量。

- [ ] **Step 1: 写失败测试**：Dockerfile 存在且含 `FROM node:22-alpine`、`USER node`、`ENTRYPOINT ["saigai-bot"]`、`/data`、`npm pack`；compose 含 `restart: unless-stopped`、两个 volume、`KUO_LLM_KEY`、`saigai-bot run`；`.dockerignore` 排除 `node_modules`/`.git`/`dist`/`.claude`；Dockerfile **不得**出现 `sk-` 或明文 key 样例。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现三个文件**：多阶段 pack→install；`mkdir/chown /data`；`USER node`；compose 镜像名 `kuoluosaigai/saigai-bot:latest`，注释给出 buildx 多架构命令与 NAS 使用说明。
- [ ] **Step 4: 运行确认通过 + `npm pack --dry-run` 检查 deploy 文件入包**。
- [ ] **Step 5: 提交**：`feat(bots): Docker 多架构镜像与 NAS compose 模板（P2）`。

### Task 3: 三路线部署文档

**Files:**
- Create: `docs/saigai-bot-deploy.md`
- Modify: `README.md`（部署段与路线图链接）
- Modify: `packages/bot-daemon/deploy/README.md`（顶部加链接与 P2 状态）
- Test: `packages/bot-daemon/tests/packaging.test.js`（追加 docs describe）

**Interfaces:**
- Produces: 文档含三个二级标题（PVE/systemd、NAS/Docker、Windows）、key 承诺、成本/静默窗、FAQ（重启清缓冲、数据目录持久、npm registry 坑）、未实测声明、发布前置（许可证/登录/顺序）。

- [ ] **Step 1: 写失败测试**：文档存在，含 `PVE`/`NAS`/`Windows` 三路径、`KUO_LLM_KEY`、`quietHours`、`重启`+`缓冲`、`未实测`、`npm publish` + `kuoluosaigai-bot-core`（顺序）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 写文档并加链接**：三路径各自「前置/步骤/验证/停止」；NAS 段含权限与多架构；Windows 段明确计划任务未内置；发布段只给命令不宣称已发布。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**：`docs(bots): 三路线部署文档与链接（P2）`。

### Task 4: 全门 + 独立审查

- [ ] **Step 1: 跑门**：`npm test`、`npm run build`、`npm run lint`、两个包的 `npm pack --dry-run --json` 人工核对。
- [ ] **Step 2: 独立审查**（fresh reviewer，opus）：按 Review Focus 逐条；0 Critical/Important 才结束。
- [ ] **Step 3: 修复轮**（如有）：每个 Critical/Important 先写失败测试再修，全门重跑。
- [ ] **Step 4: 文档如实收尾**：spec §9 标注实现状态与未实测项；README 路线图勾选 P2。

## Self-Review 备注

- 覆盖 spec §9：Docker 多架构、compose、npm 包、三路线文档、registry 坑；可选的 bun 单文件二进制明确不做。
- 发布动作（`npm publish`、推镜像到 registry）不在本计划内——需要用户账号与许可证决定，属人工步骤。
- Docker 构建/运行在本机无法验证；测试只做静态契约，文档如实标注。
