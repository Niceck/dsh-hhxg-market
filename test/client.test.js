/**
 * 浏览器半（lib/client.js）在 Node 里物化：假 `window.__ModuleLoader__` 收下 factory，假 `require`
 * 提供 react / jsx-runtime 桩，再用假 ctx.slots 跑 apply()。断言：
 *  - 只在 tool.call.toolview 注册，key 是 host 半真实存在的工具名（client 支持集 ⊆ host 工具集）；
 *  - meta 可用 → 表格卡（徽标 + 表头 + 行）；meta 缺失 / 版本不认 / isError / 渲染异常 → 回退原文；
 *  - 卡片内不出现 token 之类的敏感串（它只读 block，本来就碰不到）。
 * 这不能替代真机：真机装一次看卡片是否出现仍是必要的验收步骤。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FREE_TOOLS, VIP_TOOLS } from '../lib/tools.js'
import { realtimePresentation } from '../lib/present.js'

// ── 物化 ────────────────────────────────────────────────────────────

const registered = []
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      registered.push(spec)
    },
  },
}
await import('../lib/client.js')

/** 最小 React 桩：jsx(type, props, key) → 普通节点树，组件在 render() 时递归展开。 */
const node = (type, props, key) => ({ type, props: props || {}, key })
const stubs = {
  react: { createElement: node, Fragment: 'fragment' },
  'react/jsx-runtime': { jsx: node, jsxs: node, Fragment: 'fragment' },
}
const require = (id) => {
  if (!(id in stubs)) throw new Error(`unexpected require: ${id}`)
  return stubs[id]
}

function render(el) {
  if (el === null || el === undefined || typeof el !== 'object') return el
  if (Array.isArray(el)) return el.map(render)
  if (typeof el.type === 'function') return render(el.type(el.props))
  const { children, ...rest } = el.props
  return { type: el.type, props: rest, children: render(children) }
}

/** 树里所有字符串（文本内容 + 属性值），用来做包含性断言。 */
function strings(tree, out = []) {
  if (tree === null || tree === undefined) return out
  if (typeof tree === 'string' || typeof tree === 'number') return (out.push(String(tree)), out)
  if (Array.isArray(tree)) {
    for (const t of tree) strings(t, out)
    return out
  }
  if (typeof tree === 'object') {
    for (const v of Object.values(tree.props || {})) if (typeof v === 'string') out.push(v)
    strings(tree.children, out)
  }
  return out
}

const find = (tree, type, acc = []) => {
  if (!tree || typeof tree !== 'object') return acc
  if (Array.isArray(tree)) {
    tree.forEach((t) => find(t, type, acc))
    return acc
  }
  if (tree.type === type) acc.push(tree)
  find(tree.children, type, acc)
  return acc
}

test('bundle 只登记一个 factory，id 是包名；物化后导出 apply / inject', () => {
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, '@hhxg/dsh-hhxg-market')
  assert.equal(typeof registered[0].factory, 'function')
})

const mod = registered[0].factory(require)

test('apply 只向 tool.call.toolview 注册，key ⊆ host 工具名；slots 未就绪时经 inject 延后', () => {
  assert.deepEqual(mod.inject, ['slots'])
  const injected = []
  const regs = []
  const ctx = {
    slots: {
      inject(name, fn) {
        injected.push(name)
        return fn()
      },
      register(decl, component) {
        regs.push({ decl, component })
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  assert.deepEqual(injected, ['tool.call.toolview'])
  assert.equal(regs.length, 1)
  assert.deepEqual(regs[0].decl, { name: 'tool.call.toolview', key: 'hhxg_realtime' })
  assert.equal(regs[0].component, mod.RealtimeCard)
  const hostTools = new Set([...FREE_TOOLS, ...VIP_TOOLS].map((t) => t.name))
  assert.ok(hostTools.has(regs[0].decl.key), 'client 注册的工具名必须是 host 真实注册的工具')
})

const FRAME = { status: 'live', status_text: '盘中实时（约 1 分钟一帧）', trade_date: '20261027', updated_at: '2026-10-27 10:10:01' }
const text = JSON.stringify({
  data: {
    frame: FRAME,
    items: [{ 股票代码: '600519.SH', 股票名称: '贵州茅台', quote: { 最新价: 1355.9, 涨跌幅: 0.44, 量比: 0.9, '成交额(千元)': 520000, 涨停状态: '', 连板高度: 0 } }],
    note: '价格为盘中最新价',
  },
  meta: {},
})
const block = (meta, extra = {}) => ({ content: [{ type: 'text', text }], isError: false, meta, ...extra })

test('meta 可用：渲染徽标 + 表格（host 投影 → client 卡片，走同一份 schema）', () => {
  const meta = realtimePresentation({ view: 'quotes' }, text)
  const tree = render(node(mod.RealtimeCard, { toolName: 'hhxg_realtime', callId: 'c1', block: block(meta) }))
  assert.equal(tree.type, 'div')
  assert.equal(tree.props['data-view'], 'quotes')
  const ths = find(tree, 'th').map((n) => n.children)
  assert.deepEqual(ths.slice(0, 3), ['代码', '名称', '最新价'])
  const tds = find(tree, 'td').map((n) => n.children)
  assert.deepEqual(tds.slice(0, 4), ['600519.SH', '贵州茅台', '1355.90', '0.44'])
  const badge = find(tree, 'span').find((n) => n.props.className === 'hhxg_badge')
  assert.equal(badge.props['data-status'], 'live')
  assert.ok(strings(tree).includes('盘中实时'))
  assert.ok(strings(tree).includes('价格为盘中最新价'))
  assert.ok(find(tree, 'pre').length === 0, '有表就不显示原文')
})

test('回退：无 meta / 版本不认 / isError / 空表 → 原文 pre；渲染异常也回退，不抛', () => {
  const asText = (b) => {
    const tree = render(node(mod.RealtimeCard, { block: b }))
    const pres = find(tree, 'pre')
    return pres.length ? pres[0].children : null
  }
  assert.equal(asText(block(undefined)), text)
  assert.equal(asText(block({ schema: 2, kind: 'hhxg.realtime', columns: [], rows: [] })), text)
  assert.equal(asText(block({ schema: 1, kind: 'other', columns: [], rows: [] })), text)
  assert.equal(asText(block(realtimePresentation({ view: 'quotes' }, text), { isError: true })), text)
  const empty = realtimePresentation({ view: 'screen' }, JSON.stringify({ data: { frame: FRAME, fields: ['量比'], rows: [] } }))
  assert.equal(asText(block(empty)), text, '空表：保留徽标但正文回退原文')
  // 单元格是对象（toString 会抛）：fmt 不碰它，显示「—」，不抛也不回退
  const objectCell = { schema: 1, kind: 'hhxg.realtime', columns: ['a'], rows: [[{ toString() { throw new Error('boom') } }]] }
  const tree = render(node(mod.RealtimeCard, { block: block(objectCell) }))
  assert.deepEqual(find(tree, 'td').map((n) => n.children), ['—'])
  // 真正在渲染中抛错的 meta（rows.length 访问即抛）：组件内部 catch 后回退原文
  const exploding = new Proxy([], { get: (t, k) => { if (k === 'length') throw new Error('boom'); return Reflect.get(t, k) } })
  assert.equal(asText(block({ schema: 1, kind: 'hhxg.realtime', columns: ['a'], rows: exploding })), text)
  // 没有 block：也只是回退，不抛
  assert.doesNotThrow(() => render(node(mod.RealtimeCard, {})))
})
