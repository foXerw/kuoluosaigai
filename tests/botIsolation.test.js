// B18 静态依赖检查（spec「人机隔离」红线）——P0 搬家后的双作用域权威版：
// 1) packages/bot-core/** 用 CORE_RULES（= 适配层规则 + 禁 vue + 禁 kuoluosaigai-bot-core
//    自引用 + 禁 Node 内建模块 spec §7.4），再叠加纯度规则 findCorePurityViolations：localStorage / sessionStorage /
//    document. / window. / 宿主昵称键一律违规——core 是叶子包，普通 Node 必须可直接 import。
//    globalThis.WebSocket / globalThis.fetch 作为参数默认值是合法注入点，不是违规。
// 2) src/bots/**（浏览器适配层）用 ADAPTER_RULES：允许 vue 与 kuoluosaigai-bot-core，
//    只守原五条跨界 import 红线（useChat / roomCache / roomList / *.vue / ../composables）。
// 纯度判定只作用于 stripComments 之后的源码：头注释刻意写着「不 import useChat」「剥掉了
// sessionStorage」这类边界说明（connection.js:7 即真实样本），裸词不得误报；隔离判定同理
// 只看 import/require/re-export 提取出的模块路径。配套自检用例见下（含防「假剥离」的地基用例）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// vitest 以项目根为 cwd 跑；import.meta.url 在转换后可能非 file:，故用 resolve 定位
const CORE_DIR = path.resolve(process.cwd(), 'packages/bot-core')
const SRC_BOTS_DIR = path.resolve(process.cwd(), 'src/bots')

// 适配层规则（原 FORBIDDEN 一字未动）：src/bots 的 .js 不得 import/require
// useChat / roomCache / roomList / *.vue 组件 / ../composables/**。
const ADAPTER_RULES = [
  { label: 'useChat', re: /useChat/ },
  { label: 'roomCache', re: /roomCache/ },
  { label: 'roomList', re: /roomList/ },
  { label: '.vue', re: /\.vue/ },
  { label: '../composables', re: /\.\.\/composables/ },
]

// core 规则：适配层全部规则 + 禁 vue（叶子包不得拖入编译期依赖）
// + 禁 kuoluosaigai-bot-core 自引用（core 内部只有相对路径；包名 import 是适配层的特权）
// + 禁 Node 内建（spec §7.4 红线）：node:fs 进 core，Node 环境的测试全绿也看不见——
//   node:fs 在 Node 里真的能跑；只有 webpack 打前端 bundle 时才炸在构建上，而 P1 daemon
//   作者（写 state.json sidecar 的第一冲动就是它）可能从不跑 build。
//   `^node:` 前缀一条就覆盖全部现代内建形态（node:fs / node:fs/promises / node:crypto…）；
//   另以精确匹配封死 4 个裸名 fs/path/os/child_process——裸形在 Node 照样解析、build 照样
//   炸，且正是 daemon 起步最常用的四个；其余裸名（如裸 crypto）刻意不列：core 包零 npm
//   依赖（package.json 无 dependencies），相对路径之外的裸 spec 本就无正当用途，但精确
//   名单只钉「会被顺手写出来的那几个」，避免名单无限膨胀。
const CORE_RULES = [
  ...ADAPTER_RULES,
  { label: 'vue', re: /\bvue\b/ },
  { label: 'kuoluosaigai-bot-core 自引用', re: /kuoluosaigai-bot-core/ },
  { label: 'node builtin', re: /^(?:node:.+|(?:fs|path|os|child_process)(?:\/[\w.-]+)?)$/ },
]

// 提取所有 import/require/re-export 的模块路径（语句级，不看注释里的裸词）：
// 1) 静态 import ... from '...'（[\s\S]*? 允许大括号换行的多行写法，惰性止于最近 from）
// 2) 副作用 import '...'
// 3) 动态 import('...') / require('...')
// 4) export ... from '...'——re-export 在本仓库是真实通道（index.js 聚合、store.js/
//    lease.js 再导出包名），漏了它 core 就能用 `export { reactive } from 'vue'` 静默重耦合。
function extractImportSpecifiers(source) {
  const patterns = [
    /(?:^|\n)[ \t]*import\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)[ \t]*import\s+['"]([^'"]+)['"]/g,
    /(?:^|[^\w$])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)[ \t]*export\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
  ]
  const specs = []
  for (const re of patterns) {
    let m
    while ((m = re.exec(source)) !== null) specs.push(m[1])
  }
  return specs
}

/**
 * 返回源码中违反给定分层规则的 import 列表（空数组 = 干净）。
 * 只匹配提取出的 import 路径，绝不匹配原始源码——注释里的「不 import useChat」不是违规。
 * @param {string} source
 * @param {{label: string, re: RegExp}[]} rules CORE_RULES（core）或 ADAPTER_RULES（适配层）
 * @returns {{specifier: string, label: string}[]}
 */
export function findIsolationViolations(source, rules) {
  const violations = []
  for (const specifier of extractImportSpecifiers(source)) {
    for (const f of rules) {
      if (f.re.test(specifier)) violations.push({ specifier, label: f.label })
    }
  }
  return violations
}

// '...' 与 "..." 字符串：返回终止引号之后的下标；处理反斜杠转义；
// 未闭合时止于行尾（普通字符串不能跨行），防一处坏引号把整文件吞成字符串。
function readQuoted(src, start, q) {
  const n = src.length
  let i = start + 1
  while (i < n) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === q) return i + 1
    if (c === '\n') return i
    i++
  }
  return n
}

/**
 * 剥注释保字符串的扫描器——纯度检查的地基。不用正则一刀切：`/\/\/.*$/` 会把
 * deck.js:36 的 'https://api.deepseek.com' 里的 // 当行注释吃掉整行（若禁词跟在其后
 * 即静默漏报）。规则：行注释→一个空格；块注释→空格+保留内部换行（行号仍可诊断）；
 * ' 与 " 字符串（含转义）原样保留；` 模板字面量正文是数据原样保留、${...} 内是代码递归剥离。
 * 已知局限：不识别含引号的正则字面量——扫描目录内经「实际扫描」describe 的实文件全量
 * 验证无此形状；注释以空格替代也保证幂等（对已剥离文本再剥不变，纯度检查可放心套两层）。
 */
function stripComments(src) {
  let out = ''
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      i += 2
      while (i < n && src[i] !== '\n') i++
      out += ' '
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      let nl = 0
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') nl++
        i++
      }
      i += 2 // 吃掉 */（未闭合则到 EOF，越界无害）
      out += ' ' + '\n'.repeat(nl)
      continue
    }
    if (c === "'" || c === '"') {
      const end = readQuoted(src, i, c)
      out += src.slice(i, end)
      i = end
      continue
    }
    if (c === '`') {
      out += '`'
      i++
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        if (src[i] === '`') { out += '`'; i++; break }
        if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 0
          let j = i + 1
          for (; j < n; j++) {
            if (src[j] === '{') depth++
            else if (src[j] === '}') { depth--; if (depth === 0) break }
          }
          out += '${' + stripComments(src.slice(i + 2, j)) + '}'
          i = j + 1
          continue
        }
        out += src[i]
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * core 纯度检查：浏览器专属全局一律违规（宿主注入才合法）。stripComments 后仍出现
 * localStorage / sessionStorage / document. / window. / kuoluosaigai:nick 即违规——
 * 最后一项是 store.js 宿主 sessionStorage 的昵称键，core 按设计不该知道它（brief 样例
 * ss.getItem('kuoluosaigai:nick') 正是靠它兜住：四词模式对该行整体失明）。
 * Promise/setTimeout/setInterval/JSON/crypto/globalThis.WebSocket/globalThis.fetch
 * 在 Node 同样存在或本就是注入点，全部合法。
 * @param {string} source 原始源码或已 stripComments 的源码（幂等）皆可
 * @returns {{token: string, line: number}[]}
 */
export function findCorePurityViolations(source) {
  const stripped = stripComments(source)
  const re = /localStorage|sessionStorage|\bdocument\.|\bwindow\.|kuoluosaigai:nick/g
  const hits = []
  let m
  while ((m = re.exec(stripped)) !== null) {
    hits.push({ token: m[0], line: stripped.slice(0, m.index).split('\n').length })
  }
  return hits
}

// 递归收集目录下全部 .js（两个扫描 describe 共用；提到模块作用域供反空跑用例引用）
function jsFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...jsFiles(p))
    else if (entry.name.endsWith('.js')) out.push(p)
  }
  return out
}

describe('B18 隔离检查器（findIsolationViolations 自检）', () => {
  it('真违规源码必须被抓：useChat/roomCache/.vue/../composables', () => {
    const cases = [
      [`import { useChat } from '../composables/useChat'`, ['useChat', '../composables']],
      [`import roomCache from '../chat/roomCache'`, ['roomCache']],
      [`const x = require('../chat/roomList')`, ['roomList']],
      [`import BotCard from './BotCard.vue'`, ['.vue']],
      ["import { openSocket } from \"../composables/useChat\";", ['useChat', '../composables']],
      [`const m = await import('../chat/roomCache')`, ['roomCache']],
      [`import {\n  mergeHistory,\n} from '../composables/useChat'`, ['useChat', '../composables']],
      // re-export 形态是真实通道（index.js/store.js 都在用），同样必须受检
      [`export { useChat } from '../composables/useChat'`, ['useChat', '../composables']],
    ]
    for (const [source, labels] of cases) {
      const found = findIsolationViolations(source, ADAPTER_RULES).map((v) => v.label)
      for (const label of labels) {
        expect(found, `应抓到 ${label}：${source}`).toContain(label)
      }
    }
  })

  it('合法源码不得误报：边界注释 / historyMerge 白名单 / bots 内部与 vue 依赖', () => {
    const clean = [
      `// B18：不 import useChat/roomCache/roomList，也不碰 *.vue 组件\nimport { reactive } from 'vue'`,
      `import { mergeHistory } from '../chat/historyMerge'`,
      `import { createBotRunner } from './runner'`,
      `import { RHYTHM_DEFAULTS, createIdleScheduler } from './rhythm'\nimport { createTabLease } from './lease'`,
      // 字符串里出现禁词但不是 import 语句 → 不算违规
      `const KEY = 'kuoluosaigai:roomCache:v2'\nconst label = "useChat mirror"`,
    ]
    for (const source of clean) {
      expect(findIsolationViolations(source, ADAPTER_RULES), source).toEqual([])
    }
  })
})

describe('B18 src/bots/** 实际隔离状态', () => {
  it('src/bots 下确实有 .js 文件被检查（防空跑）', () => {
    expect(jsFiles(SRC_BOTS_DIR).length).toBeGreaterThanOrEqual(2)
  })

  it('每个 .js 文件都不 import useChat/roomCache/roomList/.vue/../composables', () => {
    for (const file of jsFiles(SRC_BOTS_DIR)) {
      const source = fs.readFileSync(file, 'utf8')
      const violations = findIsolationViolations(source, ADAPTER_RULES)
      expect(violations, `${path.relative(process.cwd(), file)} 违反 B18: ${JSON.stringify(violations)}`).toEqual([])
    }
  })
})

describe('P0 分层规则', () => {
  it('core 规则额外禁止 vue；适配层规则允许 vue', () => {
    const vueSrc = `import { reactive } from 'vue'`
    // toContainEqual：vitest 4 的 toContain 对数组元素是恒等比较，不吃非对称匹配器
    expect(findIsolationViolations(vueSrc, CORE_RULES)).toContainEqual(
      expect.objectContaining({ label: 'vue' }))
    expect(findIsolationViolations(vueSrc, ADAPTER_RULES)).toEqual([])
    // re-export 通道同样封死（适配层再导出 vue 则合法——它本就是浏览器层）
    expect(findIsolationViolations(`export { reactive } from 'vue'`, CORE_RULES)).toContainEqual(
      expect.objectContaining({ label: 'vue' }))
    expect(findIsolationViolations(`export { reactive } from 'vue'`, ADAPTER_RULES)).toEqual([])
  })

  it('core 规则额外禁止 kuoluosaigai-bot-core 自引用；适配层正当引用包名', () => {
    const src = `import { createDeck } from 'kuoluosaigai-bot-core'`
    expect(findIsolationViolations(src, CORE_RULES)).toContainEqual(
      expect.objectContaining({ label: 'kuoluosaigai-bot-core 自引用' }))
    expect(findIsolationViolations(src, ADAPTER_RULES)).toEqual([])
  })

  it('core 规则禁止 Node 内建（spec §7.4：node:fs 进 core 会让浏览器 build 炸、Node 测试全绿看不见）', () => {
    for (const src of [
      `import fs from 'node:fs'`,
      `import { readFile } from 'node:fs/promises'`,
      `import os from 'node:os'`,
      `import { spawn } from 'child_process'`,
      `const fs = require('fs')`,
      `export { readFile } from 'node:fs'`, // re-export 通道同样封死
    ]) {
      expect(findIsolationViolations(src, CORE_RULES), src).toContainEqual(
        expect.objectContaining({ label: 'node builtin' }))
    }
    // 不误伤：core 内部的相对路径与适配层的包名 import 都与本规则无关
    expect(findIsolationViolations(`import { HEARTBEAT_MS } from './timing.js'`, CORE_RULES)).toEqual([])
    expect(findIsolationViolations(`import fs from 'node:fs'`, ADAPTER_RULES)).toEqual([])
  })

  it('core 纯度：localStorage/sessionStorage/document./window. 一律违规', () => {
    const cases = [
      `const s = globalThis.localStorage`,
      `const s = globalThis.sessionStorage`,
      `ss.getItem('kuoluosaigai:nick')`,
      `document.title = 'x'`,
      `window.addEventListener('storage', h)`,
    ]
    for (const src of cases) expect(findCorePurityViolations(src), src).not.toEqual([])
  })

  it('globalThis.WebSocket / globalThis.fetch 作为默认值合法（宿主注入覆盖，勿误报）', () => {
    const src = `export function createBotConnection({ WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch } = {}) {}`
    expect(findCorePurityViolations(src)).toEqual([])
  })

  it('注释里出现禁词不误报（沿用现规则精神）', () => {
    expect(findCorePurityViolations(`// 不碰 localStorage，也不 import vue\nimport './deck.js'`)).toEqual([])
  })
})

describe('stripComments 地基（防「假剥离」）', () => {
  it('字符串里的 // 是数据：naive「从 // 删到行尾」会连同行后面的真禁词一起吞掉', () => {
    const src = `const url = 'https://api.deepseek.com'; const leak = globalThis.localStorage`
    expect(stripComments(src)).toContain('https://api.deepseek.com')
    expect(stripComments(src)).toContain('globalThis.localStorage')
    expect(findCorePurityViolations(src)).not.toEqual([])
  })

  it('转义引号不提前终结字符串（错位后真禁词会被当字符串内容吞掉）', () => {
    const src = String.raw`const s = 'it\'s' + localStorage; // window.x`
    const stripped = stripComments(src)
    expect(stripped).toContain(String.raw`'it\'s'`)
    expect(stripped).toContain('localStorage')
    expect(stripped).not.toContain('window.x')
  })

  it('行注释/块注释一律剥离且保留行结构（真实样本 connection.js:7 的 sessionStorage 注释不误报）', () => {
    const src = ['const a = b // window.x', '/* document.y', '   window.z */', 'const ok = a'].join('\n')
    const stripped = stripComments(src)
    expect(stripped).not.toContain('window.x')
    expect(stripped).not.toContain('document.y')
    expect(stripped).not.toContain('window.z')
    expect(stripped.split('\n').length).toBe(4)
    expect(findCorePurityViolations(src)).toEqual([])
  })

  it('模板字面量：正文是数据原样保留（含 //），${...} 内是代码仍受检', () => {
    expect(findCorePurityViolations('const msg = `say // hi ${globalThis.localStorage}`')).not.toEqual([])
    expect(findCorePurityViolations('const msg = `say // hi 无禁词 ${bot.name}`')).toEqual([])
  })

  it('键名类字符串保留且不误报（沿用现规则精神）', () => {
    expect(stripComments(`const KEY = 'kuoluosaigai:roomCache:v2'`)).toContain('kuoluosaigai:roomCache:v2')
    expect(findCorePurityViolations(`const KEY = 'kuoluosaigai:roomCache:v2'`)).toEqual([])
  })
})

describe('实际扫描（反空跑，Review Focus 4）', () => {
  it('packages/bot-core 与 src/bots 都确实扫到文件，且数量下限达标', () => {
    expect(jsFiles(CORE_DIR).length).toBeGreaterThanOrEqual(10)  // 6 bot 模块 + historyMerge + index + deck + timing（R5 修正）
    expect(jsFiles(SRC_BOTS_DIR).length).toBeGreaterThanOrEqual(2)  // store.js + lease.js
  })

  it('core 下每个文件既过隔离规则又过纯度规则', () => {
    for (const f of jsFiles(CORE_DIR)) {
      const src = fs.readFileSync(f, 'utf8')
      expect(findIsolationViolations(src, CORE_RULES), f).toEqual([])
      expect(findCorePurityViolations(stripComments(src)), f).toEqual([])
    }
  })

  it('src/bots 适配层过隔离规则但豁免 vue', () => {
    for (const f of jsFiles(SRC_BOTS_DIR)) {
      expect(findIsolationViolations(fs.readFileSync(f, 'utf8'), ADAPTER_RULES), f).toEqual([])
    }
  })
})
