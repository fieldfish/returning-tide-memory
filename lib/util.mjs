import { createHash, randomUUID } from 'node:crypto'

export const uuid = () => randomUUID()
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
export function fail(code, message) { const e = new Error(message); e.code = code; throw e }
export function text(v, name, max = 4000) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail('INVALID_INPUT', `${name} 必须为非空文字，最多 ${max} 字符`)
  return v.trim()
}
export function integer(v, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail('INVALID_INPUT', `${name} 数值无效`)
  return v
}
export function clip(v, n) { return Array.from(String(v)).slice(0, n).join('') }
export function safeError(e) { return { code: typeof e?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(e.code)?e.code:e?.name==='AbortError'?'CANCELLED':'OPERATION_FAILED', message: '操作失败，已暂停；请检查配置或本地诊断。不会自动重试。' } }
export const estimateTokens = s => Math.ceil(Array.from(String(s)).length) // rough character-based UI estimate; may over/under-count, never a billing figure
export function page(s, offset = 0, limit = 2000) {
  integer(offset, 'offset'); integer(limit, 'limit', 1, 6000)
  const chars = Array.from(s), end = Math.min(chars.length, offset + limit)
  return { text: chars.slice(offset, end).join(''), offset, total_characters: chars.length, next_offset: end < chars.length ? end : null }
}
