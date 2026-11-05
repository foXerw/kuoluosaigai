// P2 发布物契约：两个 workspace 包的元数据必须能让 `npm publish` 产物可用，
// 且不能把测试/私有标记/错误依赖带出去。这里只做静态契约；真实 pack 内容由
// `npm pack --dry-run --json` 人工核对（本机 npm 未登录，不执行 publish）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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

  it('files 覆盖运行时入口与四份部署材料（不整目录收 deploy）', () => {
    for (const required of [
      'bin', 'cli.js', 'config.js', 'host.js', 'rpc.js', 'state.js', 'watch.js',
      'deploy/Dockerfile', 'deploy/compose.yaml', 'deploy/README.md', 'deploy/saigai-bot.service',
    ]) {
      expect(pkg.files).toContain(required)
    }
    expect(pkg.files).not.toContain('deploy') // 整目录会把 deploy/config、deploy/data、.env 收进发布物
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

  it('真实 npm pack：deploy 下的 .env/config/data 绝不进 tarball', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saigai-pack-'))
    try {
      fs.cpSync(DAEMON_DIR, tmp, {
        recursive: true,
        filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.includes(`${path.sep}tests`),
      })
      // 模拟 NAS 用户按文档把运行期材料放进了 deploy/（发布/重建镜像时最危险的形态）
      fs.mkdirSync(path.join(tmp, 'deploy', 'config'), { recursive: true })
      fs.mkdirSync(path.join(tmp, 'deploy', 'data'), { recursive: true })
      fs.writeFileSync(path.join(tmp, 'deploy', '.env'), 'KUO_LLM_KEY=sk-LEAK\n')
      fs.writeFileSync(path.join(tmp, 'deploy', 'config', 'saigai-bot.config.js'), 'export default {}\n')
      fs.writeFileSync(path.join(tmp, 'deploy', 'data', 'state.json'), '{}')
      fs.writeFileSync(path.join(tmp, 'deploy', 'data', 'rpc.json'), '{}')

      const args = ['pack', '--dry-run', '--json']
      const raw = process.env.npm_execpath
        ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: tmp, encoding: 'utf8' })
        : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
          cwd: tmp,
          encoding: 'utf8',
          shell: process.platform === 'win32',
        })
      const parsed = JSON.parse(raw)
      // npm 10 的 workspace 模式返回数组；在包目录直接 pack 时返回 { <name>: {...} }
      const entry = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]]
      const files = entry.files.map((f) => f.path)

      for (const required of ['deploy/Dockerfile', 'deploy/compose.yaml', 'deploy/README.md', 'deploy/saigai-bot.service']) {
        expect(files).toContain(required)
      }
      for (const leaked of files) {
        expect(leaked).not.toMatch(/(^|\/)\.env($|\.)/)
        expect(leaked).not.toMatch(/^deploy\/(config|data)\//)
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('packaging：三路线部署文档', () => {
  const ROOT = path.resolve(HERE, '..', '..', '..')
  const doc = readText(path.join(ROOT, 'docs', 'saigai-bot-deploy.md'))

  it('三条部署路径都有独立小节', () => {
    expect(doc).toMatch(/## .*PVE|## .*systemd/)
    expect(doc).toMatch(/## .*NAS/)
    expect(doc).toMatch(/## .*Windows/)
  })

  it('key 承诺、成本刹车与重启语义写清楚', () => {
    expect(doc).toContain('KUO_LLM_KEY')
    expect(doc).toContain('quietHours')
    expect(doc).toContain('globalHourlyMessages')
    expect(doc).toContain('重启')
    expect(doc).toContain('缓冲')
  })

  it('如实标注未实测项与发布前置', () => {
    expect(doc).toContain('未实测')
    expect(doc).toContain('npm publish')
    expect(doc).toContain('kuoluosaigai-bot-core')
    expect(doc).toContain('许可证')
    // 发布顺序：core 先于 daemon
    const coreAt = doc.indexOf('kuoluosaigai-bot-core')
    const daemonAt = doc.indexOf('kuoluosaigai-bot-daemon')
    expect(coreAt).toBeGreaterThan(-1)
    expect(daemonAt).toBeGreaterThan(coreAt)
  })

  it('多架构与 NAS 权限提示在场', () => {
    expect(doc).toContain('linux/amd64')
    expect(doc).toContain('linux/arm64')
    expect(doc).toMatch(/1000/)
  })

  it('README 与 deploy/README 都链接到部署文档', () => {
    const readme = readText(path.join(ROOT, 'README.md'))
    const deployReadme = readText(path.join(DAEMON_DIR, 'deploy', 'README.md'))
    expect(readme).toContain('saigai-bot-deploy.md')
    expect(deployReadme).toContain('saigai-bot-deploy.md')
  })

  it('PVE 段与 systemd unit 对齐：env 文件、HOME 派生数据目录、无驻留账号', () => {
    expect(doc).toContain('/etc/saigai-bot/saigai-bot.env')
    expect(doc).toContain('/var/lib/saigai-bot/.config/saigai-bot')
    expect(doc).not.toContain('sudo -u saigai-bot')
    expect(doc).not.toContain('chown -R saigai-bot')
    expect(doc).toContain('DynamicUser')
  })

  it('容器异常停机的残留锁有专门 FAQ', () => {
    expect(doc).toContain('saigai-bot.lock')
  })

  it('deploy/README 不再宣称 core 是 private / 依赖 "*"', () => {
    const deployReadme = readText(path.join(DAEMON_DIR, 'deploy', 'README.md'))
    expect(deployReadme).not.toContain('private: true')
    expect(deployReadme).not.toContain('kuoluosaigai-bot-core "*"')
  })
})
