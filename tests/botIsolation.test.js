// B18 静态依赖检查（spec「人机隔离」红线）：src/bots/** 的 .js 文件不得
// import/require useChat / roomCache / roomList / *.vue 组件 / ../composables/**。
// 唯一明示允许的跨界依赖是 ../chat/historyMerge（spec B2）。
// 注意：src/bots 各文件的头注释刻意写着「不 import useChat/roomCache」这类
// 边界说明——纯字符串包含会误报，故本检查只看 import/require 语句的模块路径
// （提取为 findIsolationViolations，配套自检用例见下）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// vitest 以项目根为 cwd 跑；import.meta.url 在转换后可能非 file:，故用 resolve 定位
const BOTS_DIR = path.resolve(process.cwd(), 'src/bots')

const FORBIDDEN = [
  { label: 'useChat', re: /useChat/ },
  { label: 'roomCache', re: /roomCache/ },
  { label: 'roomList', re: /roomList/ },
  { label: '.vue', re: /\.vue/ },
  { label: '../composables', re: /\.\.\/composables/ },
]

// 提取所有 import/require 的模块路径（语句级，不看注释里的裸词）：
// 1) 静态 import ... from '...'（[\s\S]*? 允许大括号换行的多行写法，惰性止于最近 from）
// 2) 副作用 import '...'
// 3) 动态 import('...') / require('...')
function extractImportSpecifiers(source) {
  const patterns = [
    /(?:^|\n)[ \t]*import\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[^\w$.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)[ \t]*import\s+['"]([^'"]+)['"]/g,
    /(?:^|[^\w$])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  const specs = []
  for (const re of patterns) {
    let m
    while ((m = re.exec(source)) !== null) specs.push(m[1])
  }
  return specs
}

/**
 * 返回源码中违反 B18 的 import 列表（空数组 = 干净）。
 * @param {string} source
 * @returns {{specifier: string, label: string}[]}
 */
export function findIsolationViolations(source) {
  const violations = []
  for (const specifier of extractImportSpecifiers(source)) {
    for (const f of FORBIDDEN) {
      if (f.re.test(specifier)) violations.push({ specifier, label: f.label })
    }
  }
  return violations
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
    ]
    for (const [source, labels] of cases) {
      const found = findIsolationViolations(source).map((v) => v.label)
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
      expect(findIsolationViolations(source), source).toEqual([])
    }
  })
})

describe('B18 src/bots/** 实际隔离状态', () => {
  function jsFiles(dir) {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...jsFiles(p))
      else if (entry.name.endsWith('.js')) out.push(p)
    }
    return out
  }

  it('src/bots 下确实有 .js 文件被检查（防空跑）', () => {
    expect(jsFiles(BOTS_DIR).length).toBeGreaterThanOrEqual(8)
  })

  it('每个 .js 文件都不 import useChat/roomCache/roomList/.vue/../composables', () => {
    for (const file of jsFiles(BOTS_DIR)) {
      const source = fs.readFileSync(file, 'utf8')
      const violations = findIsolationViolations(source)
      expect(violations, `${path.relative(process.cwd(), file)} 违反 B18: ${JSON.stringify(violations)}`).toEqual([])
    }
  })
})
