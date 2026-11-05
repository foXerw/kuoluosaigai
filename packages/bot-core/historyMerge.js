// 客户端历史合并（spec §5.2/§8 多数派信任模型）：
// 把多个同房响应者的 history-res 记录并入本地缓存。纯函数，无副作用，不依赖 Vue。
// 输入已是同房间消息，本模块不处理 roomId。

// 内容比较字段：同 id 消息在这些字段上不一致即视为冲突（跨响应者篡改/伪造信号）
function contentKey(m) {
  return JSON.stringify([m.id, m.ts, m.nick, m.badge, m.text])
}

function compareOrder(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts
  if (a.id < b.id) return -1
  if (a.id > b.id) return 1
  return 0
}

/**
 * 合并历史消息。
 * @param {Array} existing  本地缓存的同房消息（全保留、同 id 优先），可为空/undefined
 * @param {Array<{messages: Array}>} responses  各响应者的一份记录（已含同房保证）
 * @param {{maxPerRoom?: number}} [options]  上限，超出丢最旧
 * @returns {Array} 新数组：按 ts 升序（同 ts 按 id 字典序），长度 ≤ maxPerRoom
 */
export function mergeHistory(existing, responses, { maxPerRoom = 500 } = {}) {
  // 防御：响应来自任意同房客户端，null/数组/无字符串 id 的条目一律丢，不参与计票。
  const valid = (m) => m !== null && typeof m === 'object' && !Array.isArray(m) &&
    typeof m.id === 'string' && m.id.length > 0

  // 1. 每个响应者内部按 id 去重（首见为准），内部重复只计 1 票
  const deduped = (responses || []).map((r) => {
    const seen = new Map()
    for (const m of (r && r.messages) || []) {
      if (!valid(m)) continue
      if (!seen.has(m.id)) seen.set(m.id, m)
    }
    return seen
  })

  // 2. 计票并标记跨响应者内容冲突（同 id 内容不一致 → conflicts）
  const votes = new Map()
  const conflicts = new Set()
  const canonical = new Map()
  for (const seen of deduped) {
    for (const [id, m] of seen) {
      votes.set(id, (votes.get(id) || 0) + 1)
      if (!canonical.has(id)) canonical.set(id, m)
      else if (contentKey(canonical.get(id)) !== contentKey(m)) conflicts.add(id)
    }
  }

  // 3. existing 全保留（同 id 首见为准，且永不被候选规则否决）
  const byId = new Map()
  for (const m of existing || []) {
    if (!valid(m)) continue
    if (!byId.has(m.id)) byId.set(m.id, m)
  }

  // 4. 候选并入：≥2 票且无冲突；仅 1 个响应者时全量采纳；existing 优先
  const soleResponder = deduped.length === 1
  for (const [id, m] of canonical) {
    if (conflicts.has(id)) continue
    if ((soleResponder || votes.get(id) >= 2) && !byId.has(id)) byId.set(id, m)
  }

  // 5. 排序 + 超限丢最旧，始终返回新数组
  const merged = [...byId.values()].sort(compareOrder)
  if (merged.length > maxPerRoom) return merged.slice(merged.length - maxPerRoom)
  return merged
}
