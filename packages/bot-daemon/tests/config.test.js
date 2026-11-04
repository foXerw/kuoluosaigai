// Task 4：daemon 配置层测试。覆盖 brief Step 3 钉死的 7 条 + 裁定 R6（共享 fixture）、
// R9（limits 校验）、R15（room 只校形状）、Task 8 依赖的 loadConfig 类型化失败分流。
// 注意 lint 约束：packages/ 在 eslint 覆盖内，禁顶层 await——所有异步都在 it 的 async 回调里。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig, validateConfig, ConfigLoadError, MAX_BOTS } from '../config.js'
import { MAX_BOTS as CORE_MAX_BOTS, DEFAULT_CHATTINESS, DEFAULT_TEMPERATURE } from 'kuoluosaigai-bot-core'

let tmpDir
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saigai-cfg-test-'))
})
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeConfig(name, text) {
  const file = path.join(tmpDir, name)
  fs.writeFileSync(file, text)
  return file
}

// cache-buster 的唯一性靠注入 now 保证（同一毫秒内真实 Date.now 会撞缓存）。
let tick = 0
function nextNow() {
  return () => ++tick
}

function minimalRaw() {
  return {
    name: 'lab-vm',
    provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test', model: 'deepseek-chat' },
    bots: [{ id: 'lixiao', name: '小李', persona: '大三学生，说话短', room: 'nebula' }],
  }
}

describe('validateConfig：纯数据红线与字段校验', () => {
  it('validateConfig：合法配置 ok=true，缺省字段回填（chattiness 50 / temperature 0.9）', () => {
    const r = validateConfig(minimalRaw())
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    // 缺省回填断言对 core 导出的权威常量取齐（裁定 R16）——测试名里的 50/0.9
    // 由构造为真；daemon 侧不再持有第二份字面量（终审 M1/M4 漂移教训在此收口）。
    expect(r.cfg.bots[0].chattiness).toBe(DEFAULT_CHATTINESS)
    expect(r.cfg.bots[0].temperature).toBe(DEFAULT_TEMPERATURE)
  })

  it('validateConfig：bots[].id 重复 → errors 含 "bots[1].id" 且指明 dup', () => {
    const raw = minimalRaw()
    raw.bots.push({ id: 'lixiao', name: '阿强', persona: 'p', room: 'alpha1' })
    const r = validateConfig(raw)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('bots[1].id') && e.includes('dup'))).toBe(true)
  })

  it('validateConfig：id 不合 [a-z0-9-]{1,32}（"李"、""、33 字符）→ 拒绝', () => {
    for (const badId of ['李', '', 'a'.repeat(33)]) {
      const raw = minimalRaw()
      raw.bots[0].id = badId
      const r = validateConfig(raw)
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.startsWith('bots[0].id'))).toBe(true)
    }
  })

  it('validateConfig：provider.apiKey 缺失但 process.env 未设 → 拒绝，错误文案不含 key 值', () => {
    delete process.env.SAIGAI_TEST_UNSET_KEY
    const file = writeConfig(
      'apikey-unset.js',
      'export default {\n' +
        "  name: 'lab-vm',\n" +
        '  provider: { baseUrl: \'https://api.deepseek.com/v1\', apiKey: process.env.SAIGAI_TEST_UNSET_KEY, model: \'deepseek-chat\' },\n' +
        '  bots: [{ id: \'lixiao\', name: \'小李\', persona: \'p\', room: \'nebula\' }],\n' +
        '}\n',
    )
    return loadConfig(file).then((raw) => {
      const r = validateConfig(raw)
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.startsWith('provider.apiKey'))).toBe(true)
      // 数值 key 同理拒绝，且错误文案绝不回显值（A1/A3：key 不进日志）
      const raw2 = minimalRaw()
      raw2.provider.apiKey = 424242
      const r2 = validateConfig(raw2)
      expect(r2.ok).toBe(false)
      expect(r2.errors.join('|')).toContain('provider.apiKey')
      expect(r2.errors.join('|')).not.toContain('424242')
    })
  })

  it('validateConfig：room "SETSUBUN"（大写）→ 拒绝（服务器只认小写 6 位）', () => {
    const raw = minimalRaw()
    raw.bots[0].room = 'SETSUBUN'
    const r = validateConfig(raw)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('bots[0].room'))).toBe(true)
  })

  it('R15：room 只校形状不判存在——6 位小写编造房放行（存在性归 join-error/doctor）', () => {
    const raw = minimalRaw()
    raw.bots[0].room = 'zzy9x7'
    expect(validateConfig(raw).ok).toBe(true)
  })

  it('serverUrl 缺省回填 wss://kuoluosaigai.com（§5）；显式 ws://localhost:8080 合法（本地联调）', () => {
    const dflt = validateConfig(minimalRaw())
    expect(dflt.ok).toBe(true)
    expect(dflt.cfg.serverUrl).toBe('wss://kuoluosaigai.com')
    const local = minimalRaw()
    local.serverUrl = 'ws://localhost:8080'
    const rLocal = validateConfig(local)
    expect(rLocal.ok).toBe(true)
    expect(rLocal.cfg.serverUrl).toBe('ws://localhost:8080')
    const wrongScheme = minimalRaw()
    wrongScheme.serverUrl = 'http://kuoluosaigai.com'
    expect(validateConfig(wrongScheme).errors.some((e) => e.startsWith('serverUrl'))).toBe(true)
  })

  it('未知键一律拒：顶层、provider 内、limits 内、bots[] 内', () => {
    const raw = minimalRaw()
    raw.talkative = 0.7
    raw.provider.providerId = 'x'
    raw.bots[0].nick = 'ANON-1'
    const r = validateConfig(raw)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('root.talkative') && e.includes('未知键'))).toBe(true)
    expect(r.errors.some((e) => e.startsWith('provider.providerId') && e.includes('未知键'))).toBe(true)
    expect(r.errors.some((e) => e.startsWith('bots[0].nick') && e.includes('未知键'))).toBe(true)
  })

  it('R9：limits 未知键拒绝——"quietHour" 少个 s 会静默成"永不静默"（通宵烧钱路径）', () => {
    const raw = minimalRaw()
    raw.limits = { quietHour: { from: '01:00', to: '02:00' } }
    const r = validateConfig(raw)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('limits.quietHour') && e.includes('未知键'))).toBe(true)
  })

  it('R9：quietHours 端点必须过 core parseClock——拒 "25:00"，收 "1:30"（1 位小时合法），缺端点也拒', () => {
    const bad = minimalRaw()
    bad.limits = { quietHours: { from: '25:00', to: '08:00' } }
    expect(validateConfig(bad).errors.some((e) => e.startsWith('limits.quietHours.from'))).toBe(true)
    const shortHour = minimalRaw()
    shortHour.limits = { quietHours: { from: '1:30', to: '08:00' } }
    expect(validateConfig(shortHour).ok).toBe(true) // 复用 parseClock，不自写更严的正则
    const missingTo = minimalRaw()
    missingTo.limits = { quietHours: { from: '01:30' } }
    expect(validateConfig(missingTo).errors.some((e) => e.startsWith('limits.quietHours.to'))).toBe(true)
  })

  it('R9：startupQuietMs / globalHourlyMessages 必须是正数（0、负数、字符串拒）', () => {
    const zero = minimalRaw()
    zero.limits = { globalHourlyMessages: 0 }
    expect(validateConfig(zero).errors.some((e) => e.startsWith('limits.globalHourlyMessages'))).toBe(true)
    const str = minimalRaw()
    str.limits = { startupQuietMs: '5000' }
    expect(validateConfig(str).errors.some((e) => e.startsWith('limits.startupQuietMs'))).toBe(true)
    const good = minimalRaw()
    good.limits = { startupQuietMs: 1, globalHourlyMessages: 120 }
    expect(validateConfig(good).ok).toBe(true)
  })

  it('bots 超出 MAX_BOTS → 拒绝；MAX_BOTS 与 core 导出同源（非抄录）', () => {
    expect(MAX_BOTS).toBe(CORE_MAX_BOTS)
    const raw = minimalRaw()
    raw.bots = Array.from({ length: MAX_BOTS + 1 }, (_, i) => ({
      id: 'b' + i,
      name: 'n' + i,
      persona: 'p',
      room: 'nebula',
    }))
    const r = validateConfig(raw)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.startsWith('bots') && e.includes('MAX_BOTS'))).toBe(true)
  })

  it('共享子对象不是循环引用：同一对象字面量被两处合法引用 → 纯度扫描放行、不压制字段错误', () => {
    // 终审 1 号：seen 只进不出时，一处 const qh 被两处引用会被误报「循环引用」，
    // 短路还会吞掉其余一切字段错误——合法纯数据配置死于误诊。兄弟算法 log.js 的 scrub
    // 按路径判环（递归后弹出 seen），此处同构修复。
    const qh = { from: '01:30', to: '08:00' }
    const raw = minimalRaw()
    raw.limits = { quietHours: qh }
    raw.bots = [{ id: 'lixiao', name: '小李', persona: 'p', room: 'nebula', rawPrompt: qh }] // 第二处引用同一对象
    const r = validateConfig(raw)
    expect(r.errors.filter((e) => e.includes('循环引用'))).toEqual([]) // 纯度扫描不得误报
    expect(r.errors.some((e) => e.startsWith('bots[0].rawPrompt') && e.includes('必须为字符串'))).toBe(true) // 短路不得压制字段错误
  })

  it('真循环引用仍被拒：bots[0].self 自环 → errors 含「循环引用」', () => {
    const raw = minimalRaw()
    raw.bots[0].self = raw.bots[0]
    const r = validateConfig(raw)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('循环引用'))).toBe(true)
  })

  it('真循环引用仍被拒：limits.backRef 指回 root 互环 → errors 含「循环引用」', () => {
    const raw = minimalRaw()
    raw.limits = { backRef: raw }
    const r = validateConfig(raw)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('循环引用'))).toBe(true)
  })

  it('errors[] 每条以字段路径开头（doctor 可直接打印）', () => {
    const raw = { name: 5, provider: 'nope', bots: [], limits: { globalHourlyMessages: -1 } }
    const r = validateConfig(raw)
    expect(r.ok).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
    for (const e of r.errors) {
      expect(/^(root|name|serverUrl|ownerNick|provider|limits|bots)\b/.test(e)).toBe(true)
    }
  })
})

describe('loadConfig：ESM 加载与类型化失败（Task 8 watcher 的分流前提）', () => {
  it('loadConfig 拒绝函数值：配置文件导出 { bots: () => [] } → errors 含 "必须是纯数据"', () => {
    const file = writeConfig(
      'fn-value.js',
      'export default {\n' +
        "  name: 'lab-vm',\n" +
        '  provider: { baseUrl: \'https://api.deepseek.com/v1\', apiKey: \'sk-test\', model: \'deepseek-chat\' },\n' +
        '  bots: () => [],\n' +
        '}\n',
    )
    return loadConfig(file).then((raw) => {
      const r = validateConfig(raw)
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.includes('必须是纯数据'))).toBe(true)
    })
  })

  it('类实例 / bigint / 自属 __proto__ 键同样算不纯（递归扫描）', () => {
    const files = [
      ['date', 'new Date()'],
      ['bigint', '10n'],
      ['proto', "{ ['__proto__']: { pwn: 1 } }"],
    ].map((pair) =>
      writeConfig(
        'impure-' + pair[0] + '.js',
        'export default {\n' +
          "  name: 'lab-vm',\n" +
          '  provider: { baseUrl: \'https://api.deepseek.com/v1\', apiKey: \'sk-test\', model: \'deepseek-chat\' },\n' +
          '  limits: ' + pair[1] + ',\n' +
          '  bots: [{ id: \'lixiao\', name: \'小李\', persona: \'p\', room: \'nebula\' }],\n' +
          '}\n',
      ),
    )
    return Promise.all(files.map((f) => loadConfig(f))).then((raws) => {
      expect(raws.length).toBe(3)
      for (const raw of raws) {
        const r = validateConfig(raw)
        expect(r.ok).toBe(false)
        expect(r.errors.some((e) => e.includes('必须是纯数据'))).toBe(true)
      }
    })
  })

  it('R6：与 Task 13 权威共享 fixture 逐字节同形的文本 → validateConfig 接受', () => {
    const fixture = [
      'export default {',
      "  name: 'lab-vm',",
      "  serverUrl: 'wss://kuoluosaigai.com',",
      "  provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: process.env.KUO_LLM_KEY, model: 'deepseek-chat' },",
      "  limits: { globalHourlyMessages: 120, quietHours: { from: '01:30', to: '08:00' } },",
      '  bots: [',
      "    { id: 'lixiao', name: '小李', persona: '大三学生，说话短', room: 'nebula', chattiness: 70, temperature: 1.1, hourlyBudget: 20 },",
      '  ],',
      '}',
      '',
    ].join('\n')
    const file = writeConfig('fixture-r6.js', fixture)
    const prev = process.env.KUO_LLM_KEY
    process.env.KUO_LLM_KEY = 'fixture-secret-key'
    return loadConfig(file).then((raw) => {
      if (prev === undefined) {
        delete process.env.KUO_LLM_KEY
      } else {
        process.env.KUO_LLM_KEY = prev
      }
      const r = validateConfig(raw)
      expect(r.errors.join('|')).not.toContain('fixture-secret-key')
      expect(r.ok).toBe(true)
      expect(r.cfg.bots[0].id).toBe('lixiao')
    })
  })

  it('缺文件 → ConfigLoadError(kind=unreadable)；半写语法坏 → kind=unparsable；解析成功空对象 ≠ 失败', () => {
    const missing = path.join(tmpDir, 'nope-does-not-exist.js')
    const broken = writeConfig('broken.js', 'export default { name: ')
    const emptyOk = writeConfig('empty.js', 'export default {}\n')
    return loadConfig(missing)
      .then(
        () => {
          throw new Error('missing file must reject')
        },
        (err) => {
          expect(err).toBeInstanceOf(ConfigLoadError)
          expect(err.kind).toBe('unreadable')
        },
      )
      .then(() =>
        loadConfig(broken).then(
          () => {
            throw new Error('broken file must reject')
          },
          (err) => {
            expect(err).toBeInstanceOf(ConfigLoadError)
            expect(err.kind).toBe('unparsable')
          },
        ),
      )
      .then(() => loadConfig(emptyOk))
      .then((raw) => {
        // 读到了、解析了，只是内容为空对象：走校验错误，绝不落进 load 失败分流
        expect(raw).toEqual({})
        const r = validateConfig(raw)
        expect(r.ok).toBe(false)
        expect(r.errors.some((e) => e.startsWith('name'))).toBe(true)
      })
  })

  it('cache-buster：同一路径二次 load 看到编辑（注入 now 保证查询串唯一）', () => {
    const file = writeConfig('buster.js', "export default { name: 'v1' }\n")
    return loadConfig(file, { now: nextNow() })
      .then((raw1) => {
        expect(raw1.name).toBe('v1')
        fs.writeFileSync(file, "export default { name: 'v2' }\n")
        return loadConfig(file, { now: nextNow() })
      })
      .then((raw2) => {
        expect(raw2.name).toBe('v2')
      })
  })
})

// R24（Task 3b）：hourlyBudget 不是「存在但不生效的旋钮」——配置层的透传语义在
// 这里钉死（下游消费链：Task 7 addBot → deck.normalizeCfg 保留 → runner 按
// Number.isFinite 决定是否把 params.hourlyCap 交给 createRhythm）。
describe('R24 bots[].hourlyBudget：透传与校验（已接线，非摆设）', () => {
  function rawWithBudget(budget) {
    const raw = minimalRaw()
    raw.bots[0].hourlyBudget = budget
    return raw
  }

  it('合法值（含 0）原样进 cfg.bots；缺失 → 不设该键——「未配=缺省 30」与「0=点名外一律不发」可区分', () => {
    const raw = minimalRaw()
    raw.bots[0].hourlyBudget = 20
    raw.bots.push({ id: 'aqiang', name: '阿强', persona: 'p', room: 'alpha1', hourlyBudget: 0 })
    raw.bots.push({ id: 'akuan', name: '阿宽', persona: 'p', room: 'beta22' })
    const r = validateConfig(raw)
    expect(r.ok).toBe(true)
    expect(r.cfg.bots[0].hourlyBudget).toBe(20)
    expect(r.cfg.bots[1].hourlyBudget).toBe(0)
    expect('hourlyBudget' in r.cfg.bots[2]).toBe(false) // 缺失 ≠ 0：键都不出现
  })

  it('负数 / 字符串 / NaN / Infinity → 拒绝且错误以 bots[0].hourlyBudget 开头', () => {
    for (const bad of [-1, '20', NaN, Infinity]) {
      const r = validateConfig(rawWithBudget(bad))
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.startsWith('bots[0].hourlyBudget'))).toBe(true)
    }
  })

  it('hourlyBudget=0 是合法配置不是错误（≥0 边界放行——0 有独立语义）', () => {
    const r = validateConfig(rawWithBudget(0))
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.cfg.bots[0].hourlyBudget).toBe(0)
  })
})
