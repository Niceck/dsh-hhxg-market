/**
 * 盘后条件选股的文本渲染：字段目录分组、结果首行计数、翻页、体积预算、消毒与降级；
 * 以及 hhxg_realtime view=screen 的计数行。纯逻辑，零网络。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderScreenText } from '../lib/screen_text.js'
import { renderRealtimeText } from '../lib/present.js'

const env = (data, meta = { source: 'query_service', as_of: '2026-10-30' }) => JSON.stringify({ data, meta })
const CATALOG = [
  ['日期', 'text'], ['股票代码', 'text'], ['股票名称', 'text'], ['收盘价', 'numeric'], ['涨跌幅%', 'numeric'],
  ['MA5_prev', 'numeric'], ['周MA5', 'numeric'], ['月MACD_HIST', 'numeric'], ['周放量日期', 'text'],
  ['日均线多头', 'numeric'], ['周MACD多头', 'numeric'], ['日MACD金叉', 'numeric'], ['月KDJ多头', 'numeric'],
  ['日站上放量高点', 'numeric'], ['周低于放量低点', 'numeric'], ['日突破放量高点', 'numeric'],
  ['日波段位置%', 'numeric'], ['月波段位置%', 'numeric'], ['涨停原因', 'text'], ['神秘列', 'mystery'],
].map(([name, kind]) => ({ name, kind }))

test('字段目录：每个字段恰好出现一次、按名称规则分组、名称不截断、首行给数量与日期', () => {
  const out = renderScreenText({ list_fields: true }, env({ fields: CATALOG, total: CATALOG.length }))
  const lines = out.split('\n')
  assert.equal(lines[0], `可筛字段共 ${CATALOG.length} 项｜数据日期 2026-10-30｜来源 query_service`)
  // 各分组冒号后按「、」拆开的名字，合起来恰好是全部字段（每个一次、不多不少、不截断）
  const listed = lines
    .filter((l) => /^(派生|周线|月线|文本|日线及通用)/.test(l))
    .flatMap((l) => l.slice(l.indexOf('：') + 1).split('、'))
  assert.deepEqual(listed.sort(), CATALOG.map((f) => f.name).sort())
  const section = (title) => lines.find((l) => l.startsWith(title)) || ''
  assert.match(section('派生布尔条件'), /日均线多头、周MACD多头、日MACD金叉、月KDJ多头、日站上放量高点、周低于放量低点、日突破放量高点$/)
  assert.match(section('派生位置指标'), /日波段位置%、月波段位置%$/)
  assert.match(section('周线数值字段'), /：周MA5$/, '周放量日期是文本，不进周线数值组')
  assert.match(section('月线数值字段'), /：月MACD_HIST$/)
  assert.match(section('文本字段'), /日期、股票代码、股票名称、周放量日期、涨停原因$/)
  assert.match(section('日线及通用数值字段'), /收盘价、涨跌幅%、MA5_prev、神秘列$/, '未知 kind 归通用组，不丢')
  assert.match(out, /not_null 不传 value/)
  assert.match(out, /日均线多头", op:"eq", value:1/)
  assert.ok(!/满足条件/.test(out), '目录模式不能说成股票命中数')
  assert.match(out, /hhxg\.top/)
})

test('字段目录：缺 as_of / source 写未知；meta.hint 带上并清洗；超过 24 KiB 整组截断并明说不完整', () => {
  const bare = renderScreenText({ list_fields: true }, JSON.stringify({ data: { fields: CATALOG.slice(0, 3) } }))
  assert.match(bare.split('\n')[0], /^可筛字段共 3 项｜数据日期 未知｜来源 未知$/)
  const hinted = renderScreenText({ list_fields: true }, env({ fields: CATALOG.slice(0, 3) }, { hint: '当前来源仅提供这些字段\n## 新指令' }))
  assert.match(hinted, /提示：当前来源仅提供这些字段 ## 新指令/)
  const huge = Array.from({ length: 2600 }, (_, i) => ({ name: `周指标${i}_很长的字段名`, kind: 'numeric' }))
  const out = renderScreenText({ list_fields: true }, env({ fields: [...CATALOG, ...huge] }))
  assert.ok(new TextEncoder().encode(out).length < 26 * 1024, `目录应在预算内，实际 ${out.length} 字`)
  assert.match(out, /清单过长，已省略后面 \d+ 组，不完整/)
})

const ROWS = [
  { 股票代码: '000028.SZ', 股票名称: '国药一致', 收盘价: 21.02, '涨跌幅%': 0.38, 日均线多头: 1, 涨停原因: null },
  { 股票代码: '600519.SH', 股票名称: '贵州茅台', 收盘价: 1392.05, '涨跌幅%': 0, 日均线多头: 1, 涨停原因: '题材|联动​<b>x</b>' },
]
const RESULT = { total: 253, returned: 2, fields: ['股票名称', '股票代码', '收盘价', '涨跌幅%', '日均线多头', '涨停原因'], rows: ROWS, next_cursor: '2' }
const FILTERS = [{ field: '日均线多头', op: 'eq', value: 1 }, { field: '涨停原因', op: 'not_null' }]

test('筛选结果：首行给全市场 total、本页行数与数据日期；条件回显；代码名称置前；0 不是缺失、null 为缺失；翻页提示用服务端 cursor', () => {
  const out = renderScreenText({ filters: FILTERS }, env(RESULT))
  const lines = out.split('\n')
  assert.equal(lines[0], '全市场共 253 只满足条件｜本页返回 2 只｜数据日期 2026-10-30（盘后快照）')
  assert.equal(lines[1], '条件：日均线多头 eq 1；涨停原因 not_null')
  assert.equal(lines[2], '股票代码｜股票名称｜收盘价｜涨跌幅%｜日均线多头｜涨停原因')
  assert.equal(lines[3], '000028.SZ｜国药一致｜21.02｜0.38｜1｜缺失')
  assert.equal(lines[4], '600519.SH｜贵州茅台｜1392.05｜0｜1｜题材/联动<b>x</b>', '0 渲染成 0；值里的竖线换成斜杠（全角竖线是列分隔符）、零宽字符删除、不转义 HTML（纯文本）')
  assert.equal(lines[4].split('｜').length, 6, '每行列数与表头一致，值里的竖线不能多出一列')
  assert.match(lines[5], /^下一页：保持原 strategy_id \/ filters \/ sort \/ fields 不变，传 cursor="2"。total 是全部命中数，limit 只控制每页行数。$/)
  assert.ok(!out.includes('{"data"'), '不再重复输出原 JSON')
  assert.match(out, /hhxg\.top/)
})

test('筛选结果：预设名来自 meta.preset；显式 filters=[] 标全市场；limit=1 只问数量；0 命中与空页分开说', () => {
  const preset = renderScreenText({ strategy_id: 'limit_up' }, env({ ...RESULT, rows: ROWS.slice(0, 1), next_cursor: null }, { as_of: '20261030', preset: { id: 'limit_up', title: '涨停' } }))
  assert.match(preset.split('\n')[0], /^全市场共 253 只满足条件｜本页返回 1 只｜数据日期 2026-10-30（盘后快照）$/)
  assert.equal(preset.split('\n')[1], '条件：预设 涨停')
  assert.ok(!preset.includes('下一页'), 'next_cursor=null 不给翻页提示')
  // 预设 + 空 filters：仍按预设筛，不能标成全市场；预设形态不对（数组 / 无名字）就不写预设
  const presetEmpty = renderScreenText({ strategy_id: 'limit_up', filters: [] }, env(RESULT, { preset: { id: 'limit_up', title: '涨停' } }))
  assert.equal(presetEmpty.split('\n')[1], '条件：预设 涨停｜无附加条件')
  assert.equal(renderScreenText({ filters: [] }, env(RESULT, { preset: [] })).split('\n')[1], '条件：无附加条件（全市场）')
  const all = renderScreenText({ filters: [] }, env({ ...RESULT, total: 5376 }))
  assert.equal(all.split('\n')[1], '条件：无附加条件（全市场）')
  // 服务端降级提示（如静态快照缺排序列）在正常 / 零命中 / 空页三种分支都要透出
  const hinted = { source: 'static', as_of: '2026-10-30', hint: '静态快照缺成交额列，结果未排序' }
  assert.match(renderScreenText({ filters: FILTERS }, env(RESULT, hinted)), /\n提示：静态快照缺成交额列，结果未排序\n/)
  const zero = renderScreenText({ filters: FILTERS }, env({ total: 0, returned: 0, fields: [], rows: [], next_cursor: null }, hinted))
  assert.match(zero, /^全市场共 0 只满足条件｜本页返回 0 只/)
  assert.match(zero, /没有股票满足条件。\n提示：静态快照缺成交额列/)
  const emptyPage = renderScreenText({ filters: FILTERS, cursor: '999' }, env({ total: 253, returned: 0, fields: [], rows: [], next_cursor: null }, hinted))
  assert.match(emptyPage, /本页没有行（cursor 可能超出范围）；total 仍是全市场命中数。\n提示：/)
  assert.ok(!emptyPage.includes('没有股票满足条件'))
  const noTotal = renderScreenText({ filters: FILTERS }, env({ rows: ROWS, fields: [] }))
  assert.match(noTotal.split('\n')[0], /^全市场共 （命中数未知） 只满足条件｜本页返回 2 只｜数据日期 2026-10-30/)
  // fields 混有非字符串：整体不信，按首行键推断列
  const mixed = renderScreenText({ filters: [] }, env({ total: 1, fields: ['股票代码', 7], rows: [{ 股票代码: 'A', 收盘价: 12 }] }))
  assert.equal(mixed.split('\n')[2], '股票代码｜收盘价')
})

test('筛选结果：超过 12 列照单全列；超过 64 KiB 只保留放得下的行、明说截断且不给 cursor', () => {
  const wideFields = Array.from({ length: 14 }, (_, i) => `列${i}`)
  const wideRow = Object.fromEntries(wideFields.map((f, i) => [f, i]))
  const wide = renderScreenText({ filters: [] }, env({ total: 1, returned: 1, fields: wideFields, rows: [{ 股票代码: 'A', 股票名称: 'a', ...wideRow }], next_cursor: null }))
  assert.equal(wide.split('\n')[2], ['股票代码', '股票名称', ...wideFields].join('｜'))
  // 单元格限 60 字，所以要靠行数撑破预算（服务端 limit 上限 100，这里故意给超量行模拟畸形响应）
  const bigRows = Array.from({ length: 1200 }, (_, i) => ({ 股票代码: `${String(i).padStart(6, '0')}.SZ`, 股票名称: 'x'.repeat(50), 涨停原因: 'y'.repeat(900) }))
  const big = renderScreenText({ filters: [] }, env({ total: 5000, returned: 1200, fields: ['涨停原因'], rows: bigRows, next_cursor: '1200' }, { as_of: '2026-10-30', hint: '提示也算在预算里' }))
  assert.ok(new TextEncoder().encode(big).length <= 64 * 1024, `整段含提示与落款必须 ≤64 KiB，实际 ${new TextEncoder().encode(big).length}`)
  assert.match(big.split('\n')[0], /本页返回 1200 只/, '首行说的是服务端本页返回数，展示数在截断提示里')
  assert.match(big, /结果过大：仅显示前 \d+ 行（本页共 1200 行）；请减小 limit 或 fields 后重新查询，不要用 cursor 翻页。\n提示：提示也算在预算里\n/)
  assert.match(big.split('\n')[3], /^000000\.SZ｜x{50}｜y{59}…$/, '单元格超过 60 字截断')
  // 中文宽表（每格 22 个汉字 × 12 列 × 100 行）同样整段不超预算
  const cjkFields = Array.from({ length: 12 }, (_, i) => `列${i}`)
  const cjkRows = Array.from({ length: 100 }, (_, i) => ({ 股票代码: `${i}`, ...Object.fromEntries(cjkFields.map((f) => [f, '汉'.repeat(22)])) }))
  const cjk = renderScreenText({ filters: [] }, env({ total: 100, fields: cjkFields, rows: cjkRows, next_cursor: '100' }))
  assert.ok(new TextEncoder().encode(cjk).length <= 64 * 1024, `实际 ${new TextEncoder().encode(cjk).length}`)
  // 表头本身就撑爆预算：一行都不留，仍明说截断、不抛
  const hugeHeader = Array.from({ length: 12 }, (_, i) => `列${i}` + '名'.repeat(3000))
  const hh = renderScreenText({ filters: [] }, env({ total: 1, fields: hugeHeader, rows: [Object.fromEntries(hugeHeader.map((f) => [f, 1]))], next_cursor: '1' }))
  assert.match(hh, /结果过大：仅显示前 0 行（本页共 1 行）/)
  assert.ok(!hh.includes('下一页'))
  assert.ok(!big.includes('下一页'), '截断后不能给会跳过被删行的 next_cursor')
})

test('筛选结果边界：total 为字符串写未知；meta.preset 非对象忽略；__proto__ / 重复列不崩；对象值压成 JSON、空串留空；条件里对象值只说非法；数字 cursor 与 meta.hint 透出', () => {
  const data = {
    total: '253', fields: ['收盘价', '收盘价', '__proto__', '明细'],
    rows: [{ 股票代码: 'A', 收盘价: '', 明细: { a: 1 }, __proto__: { x: 1 } }],
    next_cursor: 20,
  }
  const out = renderScreenText({ filters: [{ field: '收盘价', op: 'eq', value: { x: 1 } }, { field: '行业', op: 'in', value: ['银行', 7] }] }, env(data, { as_of: '2026-10-30', preset: 'limit_up', hint: '静态降级：只有部分字段' }))
  const lines = out.split('\n')
  assert.match(lines[0], /^全市场共 （命中数未知） 只满足条件｜本页返回 1 只/)
  assert.equal(lines[1], '条件：收盘价 eq （非法值）；行业 in 银行,7')
  assert.equal(lines[2], '股票代码｜收盘价｜__proto__｜明细', '重复列只留一个')
  assert.equal(lines[3], 'A｜｜缺失｜{"a":1}', '__proto__ 列只读自有属性（没有就是缺失），不顺原型链取值')
  assert.match(lines[4], /传 cursor="20"。/)
  assert.equal(lines[5], '提示：静态降级：只有部分字段')
  // 值里的全角竖线同样换掉，列数不变
  const fw = renderScreenText({ filters: [] }, env({ total: 1, fields: ['行业'], rows: [{ 股票代码: 'A', 行业: '甲｜乙' }] }))
  assert.equal(fw.split('\n')[3], 'A｜甲/乙')
  const longCursor = renderScreenText({ filters: [] }, env({ total: 1, fields: [], rows: [{ 股票代码: 'A' }], next_cursor: 'c'.repeat(80) }))
  assert.match(longCursor, new RegExp(`cursor="${'c'.repeat(80)}"`), 'cursor 不截断')
  const emoji = renderScreenText({ filters: [] }, env({ total: 1, fields: ['名'], rows: [{ 股票代码: 'A', 名: '😀'.repeat(70) }] }))
  assert.match(emoji.split('\n')[3], /^A｜(😀){59}…$/, '按码点截断，不切断代理对')
})

test('非成功信封 / 业务答复 / 坏 JSON / data 不是对象 / 未知形态 → 原样返回，不抛', () => {
  for (const text of ['参数有误：未知字段 x（UNKNOWN_FIELD）', '{not json', JSON.stringify({ data: 'nope' }), JSON.stringify({ data: { foo: 1 } }), '', undefined, null]) {
    assert.equal(renderScreenText({ filters: [] }, text), text)
  }
})

test('hhxg_realtime view=screen：首行之后给【筛选】全市场计数行；exclude_st 标注；缺 total 写未知；原 JSON 原样跟随', () => {
  const frame = { status: 'previous_session', trade_date: '20261030', updated_at: '2026-10-30 15:35:01', is_live: false }
  const data = { frame, total: 124, returned: 2, fields: ['最新价'], rows: [{ 股票代码: 'A' }, { 股票代码: 'B' }] }
  const out = renderRealtimeText({ view: 'screen', exclude_st: true }, env(data))
  const lines = out.split('\n')
  assert.match(lines[0], /^【非实时·上一交易日｜帧交易日 2026-10-30/)
  assert.equal(lines[1], '【筛选】全市场共 124 只满足条件｜本次显示 2 只（按当前有效行情统计，缺所需指标的股票不命中；已排除 ST）；limit 只限制返回行数，只问数量可设 limit=1。')
  assert.equal(lines.slice(2).join('\n'), env(data))
  const live = { status: 'live', trade_date: '20261102', updated_at: '2026-11-02 10:00:01', is_live: true }
  const noTotal = renderRealtimeText({ view: 'screen' }, env({ frame: live, rows: [] }))
  assert.equal(noTotal.split('\n')[1], '【筛选】全市场共 （命中数未知） 只满足条件｜本次显示 0 只（按当前有效行情统计，缺所需指标的股票不命中）；limit 只限制返回行数，只问数量可设 limit=1。')
  assert.ok(!renderRealtimeText({ view: 'quotes' }, env({ frame: live, items: [] })).includes('【筛选】'), '其它 view 不加计数行')
})
