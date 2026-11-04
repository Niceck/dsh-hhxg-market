/**
 * presentationMeta 投影（lib/present.js）：从 execute 返回的同一份文本解析出桌面卡片结构；
 * 解析不出 / 非成功信封一律 undefined（走默认文本卡），且永不抛错。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PRESENTATION_SCHEMA, REALTIME_KIND, realtimePresentation, renderRealtimeText } from '../lib/present.js'

const FRAME = { status: 'live', status_text: '盘中实时（约 1 分钟一帧）', trade_date: '20261027', updated_at: '2026-10-27 10:10:01', frame_id: 'x' }
const envelope = (data) => JSON.stringify({ data, meta: { source: 'query_service' } })

test('quotes：代码 / 名称 + 行情列成表，带状态徽标与 note', () => {
  const meta = realtimePresentation(
    { view: 'quotes', codes: ['600519'] },
    envelope({
      frame: FRAME,
      items: [{ 股票代码: '600519.SH', 股票名称: '贵州茅台', quote: { 最新价: 1355.9, 涨跌幅: 0.44, 量比: 0.9, '成交额(千元)': 520000, 涨停状态: '', 连板高度: 0 } }],
      note: '价格为盘中最新价',
    }),
  )
  assert.equal(meta.schema, PRESENTATION_SCHEMA)
  assert.equal(meta.kind, REALTIME_KIND)
  assert.equal(meta.view, 'quotes')
  assert.deepEqual(meta.frame, {
    status: 'live',
    status_text: FRAME.status_text,
    trade_date: '20261027',
    updated_at: FRAME.updated_at,
    is_live: null, // 服务端没给 is_live 时为 null，不猜
    effective_status: 'live',
    label: '盘中实时｜帧交易日 2026-10-27｜采集 2026-10-27 10:10',
  })
  assert.deepEqual(meta.columns, ['代码', '名称', '最新价', '涨跌幅', '量比', '成交额(千元)', '涨停状态', '连板高度'])
  assert.deepEqual(meta.rows, [['600519.SH', '贵州茅台', 1355.9, 0.44, 0.9, 520000, '', 0]])
  assert.equal(meta.truncated, false)
  assert.equal(meta.note, '价格为盘中最新价')
})

test('screen：按返回的 fields 列出；market：宽度键值 + 各池只数；fields：分组统计', () => {
  const screen = realtimePresentation(
    { view: 'screen' },
    envelope({ frame: FRAME, total: 37, fields: ['涨跌幅', '量比'], rows: [{ 股票代码: '000001.SZ', 股票名称: '平安银行', 涨跌幅: 6.2, 量比: 2.4 }] }),
  )
  assert.equal(screen.title, '全市场筛选（命中 37）')
  assert.deepEqual(screen.rows, [['000001.SZ', '平安银行', 6.2, 2.4]])

  const market = realtimePresentation(
    { view: 'market' },
    envelope({ frame: FRAME, breadth: { 上涨家数: 3000, 炸板率: 50.5, 嵌套: { a: 1 } }, limit_pool: { 涨停池: { total: 61, items: [] }, 跌停池: { total: 2, items: [] } } }),
  )
  assert.deepEqual(market.columns, ['指标', '值'])
  assert.deepEqual(market.rows, [['上涨家数', 3000], ['炸板率', 50.5], ['涨停池（只）', 61], ['跌停池（只）', 2]])

  const fields = realtimePresentation({ view: 'fields' }, envelope({ frame: FRAME, groups: { quote: ['最新价', '涨跌幅'], daily: ['MA5'] } }))
  assert.deepEqual(fields.rows, [['quote', 2, '最新价、涨跌幅'], ['daily', 1, 'MA5']])
})

test('kline：只放第一只的尾部 + 今日未收盘行；多只与更长序列标 truncated', () => {
  const rows = Array.from({ length: 120 }, (_v, i) => [`202610${String(i).padStart(2, '0')}`, 1, 2, 0.5, 1.5, 100, 1000])
  const meta = realtimePresentation(
    { view: 'kline', codes: ['600519', '000001'] },
    envelope({
      frame: FRAME,
      columns: ['date', 'open', 'high', 'low', 'close', 'volume', 'amount'],
      items: [
        { 股票代码: '600519.SH', 股票名称: '贵州茅台', rows, live: { bar: ['20261027', 1, 2, 0.5, 1.6, 50, 500], partial: true, comparable: true } },
        { 股票代码: '000001.SZ', rows: rows.slice(0, 3), live: null },
      ],
    }),
  )
  assert.equal(meta.title, '日 K 600519.SH 贵州茅台（另 1 只见文本）')
  assert.equal(meta.rows.length, 50)
  assert.deepEqual(meta.rows.at(-1), ['20261027 帧K·未收盘', 1, 2, 0.5, 1.6, 50, 500])
  assert.equal(meta.rows[0][0], rows.at(-49)[0])
  assert.equal(meta.truncated, true)
})

test('非成功信封 / 业务性答复 / 未知 view / 坏 JSON → undefined，且不抛', () => {
  assert.equal(realtimePresentation({ view: 'quotes' }, '需要 Max：说明（REALTIME_MAX_REQUIRED）'), undefined)
  assert.equal(realtimePresentation({ view: 'quotes' }, '{"error":"x"}'), undefined, '没有 data')
  assert.equal(realtimePresentation({ view: 'ticks' }, envelope({ frame: FRAME })), undefined)
  assert.equal(realtimePresentation({ view: 'quotes' }, '{not json'), undefined)
  assert.equal(realtimePresentation(undefined, envelope({})), undefined)
  assert.equal(realtimePresentation({ view: 'quotes' }, 42), undefined)
  // 字段形态异常也不抛：items 不是数组、quote 不是对象
  const weird = realtimePresentation({ view: 'quotes' }, envelope({ frame: 'nope', items: { a: 1 } }))
  assert.deepEqual(weird.rows, [])
  assert.equal(weird.frame, null)
})

test('体积上限：screen 行 ≤100（随服务端 limit 上限）、其余视图行 ≤50、列 ≤12、单元格截断，布尔 / 非有限数归一', () => {
  const fields = Array.from({ length: 20 }, (_v, i) => `f${i}`)
  const row = Object.fromEntries(fields.map((f, i) => [f, i === 0 ? 'x'.repeat(100) : i === 1 ? true : i === 2 ? Infinity : i]))
  const rows = Array.from({ length: 120 }, (_v, i) => ({ 股票代码: `00000${i}`, 股票名称: 'n', ...row }))
  const meta = realtimePresentation({ view: 'screen' }, envelope({ frame: FRAME, fields, rows }))
  assert.equal(meta.columns.length, 12)
  assert.equal(meta.rows.length, 100)
  assert.equal(meta.truncated, true)
  const exact = realtimePresentation({ view: 'screen' }, envelope({ frame: FRAME, fields: fields.slice(0, 3), rows: rows.slice(0, 100) }))
  assert.equal(exact.rows.length, 100)
  assert.equal(exact.truncated, false, '恰好 100 行不算截断')
  const quotes = realtimePresentation({ view: 'quotes' }, envelope({ frame: FRAME, items: Array.from({ length: 60 }, (_v, i) => ({ 股票代码: `${i}`, 股票名称: 'n', quote: { 最新价: 1 } })) }))
  assert.equal(quotes.rows.length, 50, '其余视图仍是 50')
  assert.equal(quotes.truncated, true)
  assert.equal(meta.rows[0][2].length, 40)
  assert.ok(meta.rows[0][2].endsWith('…'))
  assert.equal(meta.rows[0][3], '是')
  assert.equal(meta.rows[0][4], null)
  // meta 必须是无损 JSON（宿主 snapshotProjection 要求）
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta)
})
