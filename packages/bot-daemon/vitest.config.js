import { defineConfig } from 'vitest/config'

// daemon 工程独立跑在 node 环境（config.js 含 node: 内建，jsdom 会炸——裁定 R6）。
// include 钉死 tests/**：与根工程的收集面互不重叠（根 exclude 同步追加了本目录）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
})
