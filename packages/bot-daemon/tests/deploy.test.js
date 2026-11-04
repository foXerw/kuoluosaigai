// Task 12：部署产物测试——systemd unit 与 deploy/README.md 的**文本钉**。
//
// —— 为什么是文本测试而不是语法校验 ——
// 开发机没有 systemd，`systemd-analyze verify` 只能在目标 VM 上跑（README 里给了命令）。
// 本测试的职责是另一头：§8.5 的钉死键（Restart/RestartSec/MemoryMax/DynamicUser/
// ProtectSystem/ReadWritePaths/ExecStart/After=network-online.target）是**决策不是建议**，
// 不许在后续改动里被悄悄漂掉；README 缺了 R31/R34/R30 这些运行语义的裁定标签，
// 就等于把「看起来像 bug 其实是决策」的行为重新变成工单。
//
// —— 读真文件，不复制 fixture ——
// 测试里再抄一份 unit 文本就钉不住**出厂的东西**：这里全部从磁盘读 packages/bot-daemon/
// deploy/ 的真身。文件不在 → 大声失败（readRequired 抛带完整路径的错误，不静默跳过）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVICE_PATH = path.join(PKG_DIR, 'deploy', 'saigai-bot.service')
const README_PATH = path.join(PKG_DIR, 'deploy', 'README.md')
const PKG_JSON_PATH = path.join(PKG_DIR, 'package.json')

function readRequired(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error('缺少部署产物：' + filePath + ' ——Task 12 要求该文件在场，unit 键与 README 运行语义由本测试钉死')
  }
  return fs.readFileSync(filePath, 'utf8')
}

function lines(text) {
  return text.split(/\r?\n/).map((s) => s.trim())
}

// §8.5 钉死的整行键（决策清单，逐行原文比对，不靠 includes 的子串侥幸）。
const PINNED_LINES = [
  'Restart=always',
  'RestartSec=5',
  'After=network-online.target',
  'MemoryMax=192M',
  'DynamicUser=yes',
  'ProtectSystem=strict',
  'ExecStart=/usr/bin/env saigai-bot run',
]

describe('deploy/saigai-bot.service（§8.5 钉死键的文本锁）', () => {
  it('文件在场（缺失即大声失败）', () => {
    expect(fs.existsSync(SERVICE_PATH), 'unit 文件必须存在：' + SERVICE_PATH).toBe(true)
  })

  it('七个钉死键逐行原文在场', () => {
    const ls = lines(readRequired(SERVICE_PATH))
    for (const pinned of PINNED_LINES) {
      expect(ls, 'unit 必须含整行 ' + pinned).toContain(pinned)
    }
  })

  it('ReadWritePaths= 指向数据目录（ProtectSystem=strict 下唯一合法写面）', () => {
    const rw = lines(readRequired(SERVICE_PATH)).filter((l) => l.indexOf('ReadWritePaths=') === 0)
    expect(rw.length, '必须至少有一条 ReadWritePaths= 行').toBeGreaterThan(0)
    expect(rw.join(' '), 'ReadWritePaths 必须覆盖 StateDirectory=/var/lib/saigai-bot（README 的数据目录约定）').toContain('/var/lib/saigai-bot')
  })

  it('含 provider key 的 Environment 示例（操作者不必把 secret 写进配置文件）', () => {
    const text = readRequired(SERVICE_PATH)
    expect(text).toMatch(/Environment=KUO_LLM_KEY=/)
    expect(text).toMatch(/EnvironmentFile=/)
  })

  it('三个标准段落齐备', () => {
    const ls = lines(readRequired(SERVICE_PATH))
    expect(ls).toContain('[Unit]')
    expect(ls).toContain('[Service]')
    expect(ls).toContain('[Install]')
  })
})

describe('deploy/README.md（运行语义文档——这些行为看起来像 bug，其实是决策）', () => {
  it('文件在场', () => {
    expect(fs.existsSync(README_PATH), 'README 必须存在：' + README_PATH).toBe(true)
  })

  it('给出 VM 上跑 systemd-analyze verify 的命令（本机没有 systemd，不许假装校验过）', () => {
    expect(readRequired(README_PATH)).toContain('systemd-analyze verify')
  })

  it('十二条运行语义与裁定标签逐一在场', () => {
    const text = readRequired(README_PATH)
    const anchors = [
      // 1/2：§8.4 两类「重启即丢」——会话缓冲纯内存、小时计数不持久。
      '§8.4',
      // 3：R31 失败重载不自动重试。
      'R31',
      // 4：R34 退出码 4 与 0/1/2/3 约定。
      'R34',
      '退出码',
      // 5：R26/R28 粘滞 restartRequired（只由进程重启清除）。
      'R26',
      'R28',
      '粘滞',
      'restartRequired',
      // 6：Task 2 parked——出窗追发 + 墙钟/DST。
      '夏令时',
      // 7：孤儿保留与唯一正确清除路径。
      '孤儿',
      // 8：R30 deviceId P1 恒 null。
      'R30',
      'deviceId',
      // 9：rpc.json 权限尽力而为、防线是回环+secret。
      '尽力而为',
      // 10：doctor 回答 §5 未实测前提，FAIL 是真答案。
      '未实测',
      // 审查轮 1 Important 1（key 轮换语义）：EnvironmentFile 只在服务启动时被读——
      // 这句话被改回「热重载换 key」的假路径时，本锚当场报警。
      'R40',
      'systemd 只在服务启动时读 EnvironmentFile',
      // 审查轮 1 Important 2（R40 实测口径）：无 type 祖先 = 能加载但刷警告，
      // 真失败限 commonjs 祖先/老 Node——锚住这个关键词，防「默认必炸」回潮。
      'MODULE_TYPELESS_PACKAGE_JSON',
      // 审查轮 1 Minor 4（装包路线）：core 是 workspace 本地包，README 给的必须是
      // 不过 registry 的路线，且诚实标注 VM 未实测。
      'npm pack',
      '尚未实测',
      // 修文波 6 号（两条新增）：6.11 热重载死模块累积（§8.1 接受面 + §8.6 浸泡观测
      // 不得误判成泄漏）；6.12 锁的数据目录作用域（两个 --data-dir 双跑）。
      '死模块',
      '作用域是**数据目录**',
    ]
    for (const anchor of anchors) {
      expect(text, 'README 必须覆盖运行语义锚点「' + anchor + '」').toContain(anchor)
    }
  })

  it('unit 决策的键名在 README 里也被解释（§8.5）', () => {
    const text = readRequired(README_PATH)
    expect(text).toContain('§8.5')
    expect(text).toContain('MemoryMax')
    expect(text).toContain('DynamicUser')
  })
})

describe('package.json files 字段（deploy/ 随包发布，运行时模块不漏）', () => {
  it('files 含 deploy 与 bin，且根目录每个运行时模块都在列', () => {
    const pkg = JSON.parse(readRequired(PKG_JSON_PATH))
    expect(Array.isArray(pkg.files), 'files 必须是数组').toBe(true)
    expect(pkg.files).toContain('deploy')
    expect(pkg.files).toContain('bin')
    // 完整性：根目录 .js（除 vitest.config.js 这个纯测试基建）全部在 files 里——
    // bin 的 import 链（cli→config/lock/state/host/watch/doctor/log + 延迟 rpc）少一件
    // 就是装完包跑不起来的事故，新增模块忘了加同样被这条钉住。
    const rootModules = fs
      .readdirSync(PKG_DIR)
      .filter((f) => f.endsWith('.js') && f !== 'vitest.config.js')
      .map((f) => f)
    for (const mod of rootModules) {
      expect(pkg.files, '运行时模块 ' + mod + ' 必须进 files').toContain(mod)
    }
    expect(pkg.files, 'tests 不该发布').not.toContain('tests')
  })
})
