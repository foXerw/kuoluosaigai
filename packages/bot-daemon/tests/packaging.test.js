// P2 发布物契约：两个 workspace 包的元数据必须能让 `npm publish` 产物可用，
// 且不能把测试/私有标记/错误依赖带出去。这里只做静态契约；真实 pack 内容由
// `npm pack --dry-run --json` 人工核对（本机 npm 未登录，不执行 publish）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DAEMON_DIR = path.resolve(HERE, '..')
const CORE_DIR = path.resolve(DAEMON_DIR, '..', 'bot-core')
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const readText = (p) => fs.readFileSync(p, 'utf8')

function rootJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name)
}

function filesCovers(files, name) {
  return (files || []).some((f) => f === name || f === '*.js')
}

describe('packaging：core 包', () => {
  const pkg = readJson(path.join(CORE_DIR, 'package.json'))

  it('不是 private，字段齐全', () => {
    expect(pkg.private).not.toBe(true)
    expect(pkg.name).toBe('kuoluosaigai-bot-core')
    expect(pkg.version).toBe('0.1.0')
    expect(pkg.description).toBeTruthy()
    expect(pkg.license).toBe('UNLICENSED')
    expect(pkg.engines.node).toBeTruthy()
    expect(pkg.repository.directory).toBe('packages/bot-core')
    expect(pkg.main).toBe('./index.js')
    expect(pkg.exports['.']).toBe('./index.js')
  })

  it('files 覆盖全部运行时 .js（含 P4 新模块）', () => {
    const js = rootJsFiles(CORE_DIR)
    expect(js).toContain('humanize.js')
    expect(js).toContain('humanize-corpus.js')
    for (const name of js) {
      expect(filesCovers(pkg.files, name), `files 漏了 ${name}`).toBe(true)
    }
  })

  it('包内 README 说明公开面与用法', () => {
    const readme = readText(path.join(CORE_DIR, 'README.md'))
    expect(readme).toContain('createDeck')
    expect(readme).toContain('saigai-bot')
  })
})

describe('packaging：daemon 包', () => {
  const pkg = readJson(path.join(DAEMON_DIR, 'package.json'))

  it('不是 private，字段齐全', () => {
    expect(pkg.private).not.toBe(true)
    expect(pkg.name).toBe('kuoluosaigai-bot-daemon')
    expect(pkg.version).toBe('0.1.0')
    expect(pkg.description).toBeTruthy()
    expect(pkg.license).toBe('UNLICENSED')
    expect(pkg.engines.node).toBe('>=22')
    expect(pkg.repository.directory).toBe('packages/bot-daemon')
    expect(pkg.bin['saigai-bot']).toBe('./bin/saigai-bot.js')
  })

  it('files 覆盖运行时入口与部署材料', () => {
    for (const required of ['bin', 'deploy', 'cli.js', 'config.js', 'host.js', 'rpc.js', 'state.js', 'watch.js']) {
      expect(pkg.files).toContain(required)
    }
    for (const name of rootJsFiles(DAEMON_DIR)) {
      if (name === 'vitest.config.js') continue // 测试配置不进发布物
      expect(filesCovers(pkg.files, name), `files 漏了 ${name}`).toBe(true)
    }
  })

  it('依赖 core 用确定范围而不是 *（发布顺序：core → daemon）', () => {
    expect(pkg.dependencies['kuoluosaigai-bot-core']).toBe('^0.1.0')
    expect(pkg.private).not.toBe(true)
  })

  it('包内 README 给出运行命令', () => {
    const readme = readText(path.join(DAEMON_DIR, 'README.md'))
    expect(readme).toContain('saigai-bot run')
    expect(readme).toContain('KUO_LLM_KEY')
  })
})

describe('packaging：Docker / NAS', () => {
  const ROOT = path.resolve(HERE, '..', '..', '..')
  const DEPLOY = path.join(DAEMON_DIR, 'deploy')
  const dockerfile = readText(path.join(DEPLOY, 'Dockerfile'))
  const compose = readText(path.join(DEPLOY, 'compose.yaml'))
  const dockerignore = readText(path.join(ROOT, '.dockerignore'))

  it('Dockerfile 用 Node 22、非 root、pack 本地包并给出固定入口', () => {
    expect(dockerfile).toContain('FROM node:22-alpine')
    expect(dockerfile).toContain('npm pack')
    expect(dockerfile).toContain('USER node')
    expect(dockerfile).toContain('/data')
    expect(dockerfile).toContain('ENTRYPOINT ["saigai-bot"]')
    expect(dockerfile).toContain('"run", "--config", "/config/saigai-bot.config.js", "--data-dir", "/data"')
  })

  it('Dockerfile / compose 给出多架构构建线索', () => {
    const both = dockerfile + '\n' + compose
    expect(both).toContain('linux/amd64')
    expect(both).toContain('linux/arm64')
  })

  it('compose 可常驻、挂载配置只读与数据可写、key 只走环境变量', () => {
    expect(compose).toContain('restart: unless-stopped')
    expect(compose).toContain('./config:/config:ro')
    expect(compose).toContain('./data:/data')
    expect(compose).toContain('KUO_LLM_KEY')
    expect(compose).toContain('TZ=')
    expect(compose).toContain('command:')
    expect(compose).toContain('run')
    expect(compose).toContain('/config/saigai-bot.config.js')
    expect(compose).toContain('/data')
  })

  it('.dockerignore 排除依赖/构建/工作树，避免镜像上下文膨胀', () => {
    for (const line of ['node_modules', '.git', 'dist', '.claude']) {
      expect(dockerignore).toContain(line)
    }
  })

  it('Docker 材料不含明文 API key', () => {
    for (const text of [dockerfile, compose, dockerignore]) {
      expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
    }
  })
})
