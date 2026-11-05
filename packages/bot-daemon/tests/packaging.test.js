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
