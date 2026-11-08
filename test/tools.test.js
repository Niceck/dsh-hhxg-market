/**
 * 工具注册表与执行器的纯逻辑单测（零网络：fetch 全部打桩）。
 *
 * 0.7.0 起 13 个工具都要 Max 会员的 MCP Token：没 token 一个都不发请求；
 * 原 7 个免费工具改经 MCP（resources/read 读 KB / 日历 / 数据集索引，search_documents 取新闻），
 * 这里校验发出的 JSON-RPC 形状（method / uri 或工具名 / arguments）与渲染结果。
 *
 * 运行：node --test test/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpCall, MCP_RPC_URL, TOKEN_URL, UPGRADE_URL } from '../lib/api.js'
import { TOOLS, runTool, tokenRequiredMessage, currentMonthBeijing } from '../lib/tools.js'

const byName = (name) => TOOLS.find((t) => t.name === name)
const TOKEN = 'dummy_token_1234567890'

/** 打桩 fetch：记录发往 MCP 的 JSON-RPC 请求（url / headers / body），返回给定的 result（可按请求体定制）。 */
async function withMcpStub(result, run) {
  const origFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    sent.push({ url: String(url), headers: init.headers || {}, body })
    const res = typeof result === 'function' ? result(body) : result
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: res }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    return await run(sent)
  } finally {
    globalThis.fetch = origFetch
  }
}
const textResult = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], ...(isError ? { isError: true } : {}) })
const resourceResult = (uri, obj, isError = false) => ({
  contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(obj) }],
  ...(isError ? { isError: true } : {}),
})

// ── 注册表形态 ─────────────────────────────────────────────────────────

/** 13 个工具的取数通道（README / CHANGELOG 的映射表以此为准）。 */
const CHANNEL_MAP = {
  hhxg_snapshot: { channel: 'resource', uri: 'hhxg://kb/snapshot' },
  hhxg_margin: { channel: 'resource', uri: 'hhxg://kb/margin' },
  hhxg_sentiment: { channel: 'resource', uri: 'hhxg://kb/sentiment' },
  hhxg_themes: { channel: 'resource', uri: 'hhxg://kb/theme' },
  hhxg_datasets: { channel: 'resource', uri: 'hhxg://datasets/index' },
  hhxg_calendar: { channel: 'resource', uri: /^hhxg:\/\/calendar\/\d{6}$/ },
  hhxg_news: { channel: 'tool', mcpName: 'search_documents' },
  hhxg_diagnose_stock: { channel: 'tool', mcpName: 'diagnose_stock' },
  hhxg_strategy_signals: { channel: 'tool', mcpName: 'screen_stocks' },
  hhxg_predict_lianban: { channel: 'tool', mcpName: 'predict_lianban_promotion' },
  hhxg_stock_alerts: { channel: 'tool', mcpName: 'query_dataset' },
  hhxg_query_dataset: { channel: 'tool', mcpName: 'query_dataset' },
  hhxg_realtime: { channel: 'tool', mcpName: 'get_realtime' },
}

/** 每个工具一组能通过 precheck / schema 的参数（没 token 的用例要证明是 token 先拦住，而不是参数）。 */
export const VALID_ARGS = {
  hhxg_news: { limit: 5 },
  hhxg_calendar: { month: '202611' },
  hhxg_diagnose_stock: { stock_code: '600519' },
  hhxg_strategy_signals: { strategy_id: 'limit_up' },
  hhxg_predict_lianban: { stock_code: '600519' },
  hhxg_stock_alerts: { stock_code: '600519' },
  hhxg_query_dataset: { dataset_id: 'etf_latest' },
  hhxg_realtime: { view: 'market' },
}

test('注册表：13 个工具，名称唯一且带 hhxg_ 前缀，全部有 channel；资源类有 uri + render，工具类有 mcpName + buildArgs', () => {
  assert.equal(TOOLS.length, 13)
  const names = TOOLS.map((t) => t.name)
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual(new Set(names), new Set(Object.keys(CHANNEL_MAP)))
  for (const spec of TOOLS) {
    assert.match(spec.name, /^hhxg_/)
    const want = CHANNEL_MAP[spec.name]
    assert.equal(spec.channel, want.channel, spec.name)
    if (want.channel === 'resource') {
      const uri = typeof spec.uri === 'function' ? spec.uri(VALID_ARGS[spec.name] ?? {}) : spec.uri
      if (want.uri instanceof RegExp) assert.match(uri, want.uri, spec.name)
      else assert.equal(uri, want.uri, spec.name)
      assert.equal(typeof spec.render, 'function', spec.name)
      assert.equal(spec.mcpName, undefined)
    } else {
      assert.equal(spec.mcpName, want.mcpName, spec.name)
      assert.equal(typeof spec.buildArgs, 'function', spec.name)
      assert.equal(spec.uri, undefined)
    }
    assert.equal(typeof spec.description, 'string')
    assert.doesNotMatch(spec.description, /【VIP】|【Max】|免费|Pro 会员/, `${spec.name} 的说明不再分免费 / VIP`)
    assert.equal(typeof spec.parameters, 'object')
  }
})

// 服务端的 8 个旧工具名 0.3.0 起降为别名、2026-10-27 起已下线：插件不得再调用它们
const LEGACY_MCP_TOOLS = [
  'get_dataset', 'get_history', 'get_anomalies', 'get_sentiment', 'get_themes_ranking',
  'get_stock_alerts_history', 'get_strategy_signals', 'search_news',
]
const SERVER_TOOLS = [
  'discover_data', 'query_dataset', 'search_documents', 'get_document',
  'screen_stocks', 'diagnose_stock', 'predict_lianban_promotion', 'get_realtime',
]
const USABLE_PRESETS = [
  'limit_up', 'volume_breakout', 'low_volume_consolidation', 'nineturn_buy',
  'nineturn_sell', 'kdj_overbought', 'kdj_oversold', 'crash_warning', 'macd_golden_cross',
]
const UNSUPPORTED_PRESETS = ['oversold_rebound', 'macd_death_cross', 'distribution']

test('tools/call 通道只调用服务端正式工具，不再调用已弃用的旧名', () => {
  for (const spec of TOOLS.filter((t) => t.channel === 'tool')) {
    assert.ok(SERVER_TOOLS.includes(spec.mcpName), `${spec.name} → ${spec.mcpName}`)
    assert.ok(!LEGACY_MCP_TOOLS.includes(spec.mcpName), `${spec.name} 仍在调用旧工具 ${spec.mcpName}`)
  }
})

// ── 没 token：一个都不能用，也不发请求 ─────────────────────────────────

test('没 token：13 个工具都返回开通指引且不发请求（参数合法与否都一样）', async () => {
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw new Error('must not fetch')
  }
  try {
    for (const spec of TOOLS) {
      for (const token of ['', undefined, null]) {
        const out = await runTool(spec, token, VALID_ARGS[spec.name] ?? {})
        assert.equal(out, tokenRequiredMessage(spec.name), `${spec.name} token=${JSON.stringify(token)}`)
      }
      // 参数本身非法（precheck 本会拦）时也先给 token 指引：没 token 什么都做不了
      assert.equal(await runTool(spec, '', {}), tokenRequiredMessage(spec.name))
    }
  } finally {
    globalThis.fetch = origFetch
  }
  assert.equal(calls, 0, '没 token 不得发任何请求')
})

test('开通指引：写明 13 个工具都要 Max 的 MCP Token、cordis.patch.yml 写法与深链；不再提免费工具与 Pro 保护期', () => {
  const text = tokenRequiredMessage('hhxg_realtime')
  assert.match(text, /^工具 hhxg_realtime 需要 Max 会员的 MCP Token/)
  assert.match(text, /13 个工具/)
  assert.match(text, /cordis\.patch\.yml/)
  assert.match(text, /id: hhxg-market/)
  assert.match(text, /mcpToken/)
  assert.match(text, /HHXG_MCP_TOKEN/)
  assert.ok(text.includes(UPGRADE_URL), '升级页深链')
  assert.ok(text.includes(TOKEN_URL), 'Token 签发页深链（开发者接入页）')
  assert.doesNotMatch(text, /account\/mcp\.html/, '旧地址只剩跳转壳，不再出现在文案里')
  assert.doesNotMatch(text, /设置 → 插件/)
  assert.doesNotMatch(text, /免费|原到期日|保护期|永久|SLA/)
  assert.match(text, /Max 会员（月付 ¥99/)
  assert.ok(!text.includes('¥20 /'), '旧的 VIP ¥20 档已不再签发 MCP Token')
})

// ── 有 token：原 7 个免费工具经 MCP 取数 ─────────────────────────────────

const RESOURCE_FIXTURES = {
  'hhxg://kb/snapshot': {
    meta: { schema_version: 3 },
    date: '2026-11-06',
    market: { sentiment_index: 13.9, sentiment_label: '弱', limit_up: 32, fried: 14, limit_down: 15, promotion_rate: '13%' },
    ladder: { total_limit_up: 32, max_streak: 5, top_streak: { name: '闽发铝业', boards: 5, industry: '工业金属' } },
    hot_themes: [{ name: '乡村振兴', limitup_count: 9, net_yi: 0.03, top_stocks: [{ name: '红太阳', net_yi: 0.85 }] }],
    sectors: [{ label: '行业', strong: [{ name: '银行', net_yi: 24.67, leader: '沪农商行' }], weak: [] }],
    hotmoney: { total_net_yi: 5.31, top_net_buy: [{ name: '百洋股份', net_yi: 1.59, ratio_pct: 73.2 }], seats: [] },
    focus_news: [{ t: '2026-11-08T15:05:34', cat: '市场', title: '卡塔尔指数早盘下跌1.3%。' }],
    macro_news: [],
    ai_summary: { market_state: '赚钱效应 13.9%（弱）', cta: '以上为精简摘要，查看完整技术指标请访问恢恢量化日报' },
  },
  'hhxg://kb/margin': {
    scope: 'margin',
    schema_version: 2,
    window: { trading_days: 7, start: '2026-10-28', end: '2026-11-05' },
    market: { daily_totals: [{ date: '2026-11-05', rzye_yi: 22602.06, rqye_yi: 288.04, rzrqye_yi: 22890.09 }] },
    top: {
      increase_rzye: [{ code: '159915.SZ', name: '创业板ETF易方达', latest_rzye_yi: 50.4921, delta_rzye_yi: 6.7428, delta_pct: 15.41 }],
      decrease_rzye: [{ code: '300476.SZ', name: '胜宏科技', latest_rzye_yi: 107.0097, delta_rzye_yi: -35.309, delta_pct: -24.81 }],
    },
  },
  'hhxg://kb/sentiment': {
    scope: 'sentiment',
    days: [{ date: '2026-11-06', limit_up_count: 32, max_lianban: 5, top_industries: [{ name: '电力', count: 3 }], top_concepts: [{ name: '乡村振兴', count: 9 }] }],
  },
  'hhxg://kb/theme': { scope: 'theme', latest_date: '2026-11-06', items: [{ name: '题材股', yz: 16, zt: 14, avg10: null, ratio: 0.2222 }] },
  'hhxg://datasets/index': {
    total: 1,
    generated_at: '2026-11-08T12:00:00',
    datasets: [{ id: 'etf_latest', category: 'ETF', title: 'ETF 量化指标最新快照', urls: { latest: 'https://hhxg.top/etf_tool/integrated/etf_latest.csv' }, update_sla: { frequency: 'daily' } }],
  },
  'hhxg://calendar/202611': {
    yyyymm: '202611',
    events: [
      { date: '2026-11-02', type: 'unlock', label: '限售解禁', description: '上海汽配、惠柏新材等7只限售股解禁，合计约32.09亿', items: [], metrics: {} },
      { date: '2026-11-20', type: 'index_futures', label: '股指期货交割', description: '沪深300(IF)、上证50(IH)等股指期货合约到期交割', items: [], metrics: {} },
      { date: '2026-11-13', type: 'unlock', label: '限售解禁', description: '某某科技解禁', items: [], metrics: {} },
    ],
  },
}
const RESOURCE_EXPECT = {
  hhxg_snapshot: [/^# A股日报快照（2026-11-06）/, /13\.9（弱）/, /连板晋级率 13\.0%/, /最高 5 连板（闽发铝业 5 板）/, /\| 乡村振兴 \| 9 \| 0\.0 \| 红太阳 \|/, /\| 银行 \| 24\.7 \| 沪农商行 \|/, /百洋股份: 净买 1\.59 亿/, /\[市场\] 卡塔尔指数/, /## AI 市场简评\n- 赚钱效应/],
  hhxg_margin: [/^# 融资融券（近 1 交易日，2026-10-28 ~ 2026-11-05，单位亿元）/, /\| 2026-11-05 \| 22602\.1 \| 288\.0 \| 22890\.1 \|/, /## 融资净增 TOP/, /创业板ETF易方达\(159915\.SZ\) \| 50\.5 \| 6\.74 \| 15\.41% \|/, /## 融资净减 TOP/],
  hhxg_sentiment: [/\| 2026-11-06 \| 32 \| 5 \| 电力 \| 乡村振兴 \|/],
  hhxg_themes: [/^# 题材热度榜（2026-11-06 · TOP 1）/, /\| 1 \| 题材股 \| 16 \| 14 \| 22\.2% \|/],
  hhxg_datasets: [/^# hhxg 数据集目录（1\/1 个）/, /\| etf_latest \| ETF \| ETF 量化指标最新快照 \| csv \| daily \| ✓ \|/],
  hhxg_calendar: [/^# A股投资者事件日历（202611）/, /事件共 3 条，按类型分组：/, /## 限售解禁（2 条）\n- 11-02 上海汽配、惠柏新材等7只限售股解禁，合计约32\.09亿\n- 11-13 某某科技解禁\n\n## 股指期货交割（1 条）\n- 11-20 沪深300/],
}

test('有 token：6 个资源类工具发 resources/read（uri + Bearer 头），按服务端 payload 形状渲染', async () => {
  await withMcpStub((body) => resourceResult(body.params.uri, RESOURCE_FIXTURES[body.params.uri]), async (sent) => {
    const cases = [['hhxg_snapshot', {}], ['hhxg_margin', {}], ['hhxg_sentiment', {}], ['hhxg_themes', {}], ['hhxg_datasets', {}], ['hhxg_calendar', { month: '202611' }]]
    for (const [name, args] of cases) {
      const out = await runTool(byName(name), TOKEN, args)
      for (const re of RESOURCE_EXPECT[name]) assert.match(out, re, name)
      assert.ok(!out.includes('undefined') && !out.includes('null'), `${name} 输出含未清洗的缺失值`)
      assert.match(out, /数据来自恢恢量化 hhxg\.top/, '输出应带数据来源落款')
    }
    assert.equal(sent.length, 6)
    for (const req of sent) {
      assert.equal(req.url, MCP_RPC_URL)
      assert.equal(req.body.jsonrpc, '2.0')
      assert.equal(req.body.method, 'resources/read')
      assert.deepEqual(Object.keys(req.body.params), ['uri'])
      assert.equal(req.headers.Authorization, `Bearer ${TOKEN}`)
    }
    assert.deepEqual(
      sent.map((r) => r.body.params.uri),
      ['hhxg://kb/snapshot', 'hhxg://kb/margin', 'hhxg://kb/sentiment', 'hhxg://kb/theme', 'hhxg://datasets/index', 'hhxg://calendar/202611'],
    )
  })
})

test('hhxg_snapshot：ai_summary 的 cta 导流句不进简评；top_streak 兼容数组 / 字符串；空数据不抛', async () => {
  const snapshot = byName('hhxg_snapshot')
  const base = RESOURCE_FIXTURES['hhxg://kb/snapshot']
  const render = (d) => withMcpStub(resourceResult('hhxg://kb/snapshot', d), () => runTool(snapshot, TOKEN, {}))
  const full = await render(base)
  assert.ok(!full.includes('恢恢量化日报'), 'cta 不是市场简评')
  assert.match(await render({ ...base, ladder: { total_limit_up: 3, max_streak: 2, top_streak: [{ name: 'A' }, { name: 'B' }] } }), /最高 2 连板（A、B）/)
  assert.match(await render({ ...base, ladder: { max_streak: 2, top_streak: 'C' } }), /涨停共 — 家，最高 2 连板（C）/)
  const empty = await render({})
  assert.match(empty, /^# A股日报快照（\?）/)
  assert.match(empty, /市场情绪指数: —（—）/)
})

test('hhxg_news：tools/call search_documents {kind:"news", limit}，limit 收敛 1-50；按摘要级字段渲染，业务答复原样透出', async () => {
  const news = byName('hhxg_news')
  assert.deepEqual(news.buildArgs({ limit: 5 }), { kind: 'news', limit: 5 })
  assert.deepEqual(news.buildArgs({}), { kind: 'news', limit: 20 })
  assert.deepEqual(news.buildArgs(undefined), { kind: 'news', limit: 20 })
  assert.deepEqual(news.buildArgs({ limit: 0 }), { kind: 'news', limit: 20 })
  assert.deepEqual(news.buildArgs({ limit: 99 }), { kind: 'news', limit: 50 })
  assert.deepEqual(news.buildArgs({ limit: -3 }), { kind: 'news', limit: 1 })
  assert.deepEqual(news.buildArgs({ limit: 'x' }), { kind: 'news', limit: 20 })
  assert.deepEqual(news.buildArgs({ limit: 7.9 }), { kind: 'news', limit: 7 })
  const envelope = {
    success: true,
    data: {
      kind: 'news',
      window: { from: '2026-11-06', to: '2026-11-08', clamped: false, max_days: 7 },
      total: 120,
      returned: 2,
      items: [
        { published_at: '2026-11-08T15:05:34', channel: '市场', title: '卡塔尔指数早盘下跌1.3%。', source: '财联社' },
        { published_at: '2026-11-08 14:50:00', channel: '宏观', title: '第二条', source: null },
      ],
      next_cursor: '2',
    },
    meta: { source: 'kb:news', untrusted_text: true },
  }
  await withMcpStub(textResult(envelope), async (sent) => {
    const out = await runTool(news, TOKEN, { limit: 2 })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].body.method, 'tools/call')
    assert.deepEqual(sent[0].body.params, { name: 'search_documents', arguments: { kind: 'news', limit: 2 } })
    assert.equal(sent[0].headers.Authorization, `Bearer ${TOKEN}`)
    assert.match(out, /^# 财经快讯（最新 2 条，窗口内共 120 条，2026-11-06 ~ 2026-11-08）\n/)
    assert.match(out, /\n- 11-08 15:05 \[市场\] 卡塔尔指数早盘下跌1\.3%。（财联社）\n/)
    assert.match(out, /\n- 11-08 14:50 \[宏观\] 第二条\n/)
    assert.ok(!out.includes('undefined') && !out.includes('null'))
  })
  // total 不大于已返回条数时不写「窗口内共」；没有 window 也能渲染
  await withMcpStub(textResult({ success: true, data: { kind: 'news', total: 1, items: [{ published_at: '2026-11-08T09:00:00', channel: 'A', title: 'T' }] }, meta: {} }), async () => {
    assert.match(await runTool(news, TOKEN, {}), /^# 财经快讯（最新 1 条）\n\n- 11-08 09:00 \[A\] T\n/)
  })
  // 业务答复（无数据）是 mcpCall 已渲染好的文本，不当 JSON 解析；空 items 给占位
  await withMcpStub(textResult({ error: 'news KB 不可用', errorCode: 'NO_DATA', meta: {} }, true), async () => {
    assert.equal(await runTool(news, TOKEN, {}), '无结果：news KB 不可用（NO_DATA）')
  })
  await withMcpStub(textResult({ success: true, data: { kind: 'news', items: [] }, meta: {} }), async () => {
    assert.match(await runTool(news, TOKEN, {}), /^暂无快讯数据。/)
  })
})

test('hhxg_calendar：month 默认北京时间当月，YYYY-MM 也认；形状不对本地拒绝不发请求；该月不存在按「无结果」；每类最多列 25 条', async () => {
  const cal = byName('hhxg_calendar')
  assert.deepEqual(Object.keys(cal.parameters), ['month'], '0.7.0 起只有 month，不再有 type')
  assert.equal(cal.uri({}), `hhxg://calendar/${currentMonthBeijing()}`)
  assert.equal(cal.uri(undefined), `hhxg://calendar/${currentMonthBeijing()}`)
  assert.equal(cal.uri({ month: '' }), `hhxg://calendar/${currentMonthBeijing()}`)
  assert.equal(cal.uri({ month: '2026-11' }), 'hhxg://calendar/202611')
  assert.equal(cal.uri({ month: ' 202612 ' }), 'hhxg://calendar/202612')
  assert.match(currentMonthBeijing(), /^\d{6}$/)
  assert.equal(currentMonthBeijing(Date.UTC(2026, 10, 30, 16, 30)), '202612', 'UTC 11-30 16:30 = 北京 12-01 00:30')
  assert.equal(currentMonthBeijing(Date.UTC(2026, 10, 30, 15, 59)), '202611')
  await withMcpStub((body) => resourceResult(body.params.uri, { error: `${body.params.uri.slice(-6)} 月份事件不存在` }, true), async (sent) => {
    for (const month of ['2026', '202613', '202600', 'abc', 202611, '2026/11', ['202611'], '2026-1']) {
      assert.equal(
        await runTool(cal, TOKEN, { month }),
        '参数有误：month 须为 YYYYMM（如 202611），默认当月（INVALID_ARG）',
        JSON.stringify(month),
      )
    }
    assert.equal(sent.length, 0, '形状不对的不发请求')
    assert.equal(await runTool(cal, TOKEN, { month: '203001' }), '无结果：203001 月份事件不存在')
    assert.equal(sent.length, 1)
  })
  const many = Array.from({ length: 30 }, (_v, i) => ({ date: `2026-12-${String(i + 1).padStart(2, '0')}`, type: 'unlock', label: '限售解禁', description: `第 ${i + 1} 批` }))
  await withMcpStub(resourceResult('hhxg://calendar/202612', { yyyymm: '202612', events: many }), async () => {
    const out = await runTool(cal, TOKEN, { month: '202612' })
    assert.match(out, /## 限售解禁（30 条）/)
    assert.match(out, /- 12-25 第 25 批\n…（共 30 条，仅列前 25）/)
    assert.ok(!out.includes('第 26 批'))
  })
  await withMcpStub(resourceResult('hhxg://calendar/202612', { yyyymm: '202612', events: [] }), async () => {
    assert.match(await runTool(cal, TOKEN, { month: '202612' }), /^# A股投资者事件日历（202612）\n\n该月暂无事件。/)
  })
  // 日期格式不对不回显；type 缺失按 label 分组
  await withMcpStub(resourceResult('hhxg://calendar/202612', { events: [{ date: '<b>x</b>', label: '政策', description: '说明' }] }), async () => {
    assert.match(await runTool(cal, TOKEN, { month: '202612' }), /## 政策（1 条）\n- — 说明/)
  })
})

test('数据集目录：按 hhxg://datasets/index 的条目形状标「可 query」——格式按 latest 扩展名判、清单带 size_bytes 才标过大、没有文件地址的是会员宽表', async () => {
  const datasets = byName('hhxg_datasets')
  assert.ok(!/46|51/.test(datasets.description), '数据集数量会变，描述里不写死')
  const at = (path) => ({ latest: `https://hhxg.top/${path}` })
  const payload = {
    total: 9,
    generated_at: '2026-11-08T12:00:00',
    datasets: [
      { id: 'small_json', category: '情绪', title: '小 JSON', urls: at('a.json'), update_sla: { frequency: 'daily' } },
      { id: 'small_csv', category: '游资', title: '小 CSV', urls: at('a.csv'), update_sla: { frequency: 'daily' } },
      // 清单给了 format / size_bytes 时照清单判
      { id: 'big_csv', category: '选股', title: '大 CSV', format: 'csv', size_bytes: 300 * 1024 + 1, urls: at('b.csv') },
      { id: 'big_json', category: '公告', title: '大 JSON', format: 'json', size_bytes: 1268200, urls: at('b.json') },
      { id: 'edge_csv', category: '游资', title: '恰好 300KB', format: 'csv', size_bytes: 300 * 1024, urls: at('e.csv') },
      { id: 'monthly_csv', category: '两融', title: '按月 CSV', urls: { history_pattern: 'https://hhxg.top/m/YYYYMM.csv' } },
      { id: 'xml_feed', category: '其他', title: 'XML', urls: at('f.xml') },
      // 会员专属宽表：不发布文件（索引里没有任何地址），只能经策略筛选
      { id: 'quant_signal_pool', category: '策略', title: '全市场宽表', urls: {} },
      // 会员 KB：索引保留 latest，经 query_dataset 取
      { id: 'kb_stock_indicators', category: '策略', title: '指标榜', urls: at('k.json') },
    ],
  }
  await withMcpStub(resourceResult('hhxg://datasets/index', payload), async () => {
    const out = await runTool(datasets, TOKEN, {})
    const row = (id) => out.split('\n').find((line) => line.startsWith(`| ${id} |`))
    const mark = (id) => row(id).split('|').at(-2).trim()
    assert.equal(mark('small_json'), '✓')
    assert.equal(mark('small_csv'), '✓')
    assert.equal(mark('big_csv'), '过大')
    assert.equal(mark('big_json'), '过大')
    assert.equal(mark('edge_csv'), '✓')
    assert.equal(mark('monthly_csv'), '—')
    assert.equal(mark('xml_feed'), '—')
    assert.equal(mark('quant_signal_pool'), '筛选')
    assert.equal(mark('kb_stock_indicators'), '✓')
    assert.match(row('small_csv'), /\| csv \| daily \|/, '格式按 latest 扩展名判')
    assert.match(row('quant_signal_pool'), /\| — \| — \| 筛选 \|/, '没有地址 / 频率时渲染成缺失')
    assert.match(out, /^# hhxg 数据集目录（9\/9 个）/)
    assert.match(out, /「筛选」是会员专属的全市场宽表，不提供下载/)
    assert.ok(!out.includes('（VIP）') && !out.includes('免费') && !out.includes('开放数据集'))
    const filtered = await runTool(datasets, TOKEN, { category: '策略' })
    assert.match(filtered, /^# hhxg 数据集目录（2\/9 个）/)
    assert.match(await runTool(datasets, TOKEN, { category: '不存在的分类' }), /^没有匹配「不存在的分类」的数据集/)
  })
  // 清单显式标了会员宽表交付方式（哪怕带着地址）也标「筛选」；total 缺失时退到 dataset_count / ?
  await withMcpStub(resourceResult('hhxg://datasets/index', { datasets: [{ id: 'wide', category: '策略', title: '宽表', urls: at('w.csv'), access: 'member', delivery: 'screen_stocks' }] }), async () => {
    const out = await runTool(datasets, TOKEN, {})
    assert.match(out, /^# hhxg 数据集目录（1\/\? 个）/)
    assert.match(out, /\| wide \| 策略 \| 宽表 \| csv \| — \| 筛选 \|/)
  })
  await withMcpStub(resourceResult('hhxg://datasets/index', { datasets: [] }), async () => {
    assert.match(await runTool(datasets, TOKEN, {}), /^暂无数据集目录。/)
  })
})

// ── tools/call 通道：参数组装与本地预检 ─────────────────────────────────

test('buildArgs：股票代码与边界收敛', () => {
  const diag = byName('hhxg_diagnose_stock')
  assert.deepEqual(diag.buildArgs({ stock_code: '000001.SZ' }), { stock_code: '000001.SZ' })

  // 个股异动历史改走通用取数的按键读取：dataset_id 固定，股票代码进 key
  const alerts = byName('hhxg_stock_alerts')
  assert.equal(alerts.mcpName, 'query_dataset')
  assert.deepEqual(
    alerts.buildArgs({ stock_code: '600246', days: 7 }),
    { dataset_id: 'stock_alerts_history', key: '600246', days: 7 },
  )
  assert.deepEqual(alerts.buildArgs({ stock_code: ' 600246.SH ' }), { dataset_id: 'stock_alerts_history', key: '600246.SH' })
  // 越界 days 丢弃（走服务端默认），不透传垃圾值
  assert.deepEqual(alerts.buildArgs({ stock_code: '600246', days: 99 }), { dataset_id: 'stock_alerts_history', key: '600246' })
  assert.deepEqual(alerts.buildArgs({ stock_code: '600246', days: 'x' }), { dataset_id: 'stock_alerts_history', key: '600246' })

  const query = byName('hhxg_query_dataset')
  assert.deepEqual(
    query.buildArgs({ dataset_id: 'xuangu', filters: { pool: 'a' }, sort: '-pct', limit: 10 }),
    { dataset_id: 'xuangu', filters: { pool: 'a' }, sort: '-pct', limit: 10 },
  )
  assert.deepEqual(query.buildArgs({ dataset_id: 'xuangu', limit: 9999 }), { dataset_id: 'xuangu' })
  assert.doesNotMatch(query.description, /免费/)
  assert.match(query.description, /先用 hhxg_datasets 查合法 dataset_id/)
})

test('策略信号改走 screen_stocks 的策略预设：strategy_id → preset，limit 透传并收敛', () => {
  const signals = byName('hhxg_strategy_signals')
  assert.equal(signals.mcpName, 'screen_stocks')
  assert.deepEqual(signals.buildArgs({ strategy_id: 'limit_up' }), { preset: 'limit_up' })
  assert.deepEqual(signals.buildArgs({ strategy_id: ' nineturn_buy ', limit: 50 }), { preset: 'nineturn_buy', limit: 50 })
  // 越界 / 非数字 limit 丢弃（走服务端默认 20）
  for (const limit of [0, 101, 'x', null, 2.5e9]) {
    assert.deepEqual(signals.buildArgs({ strategy_id: 'limit_up', limit }), { preset: 'limit_up' })
  }
  assert.deepEqual(signals.buildArgs({ strategy_id: 'limit_up', limit: 20.9 }), { preset: 'limit_up', limit: 20 })
  // 未知 id 原样交给服务端判（服务端返回可读的参数错误），不在插件里另维护一份合法值校验
  assert.deepEqual(signals.buildArgs({ strategy_id: 'not_a_preset' }), { preset: 'not_a_preset' })

  // 描述：不再承诺 CSV 直链；写清 9 个可用预设，另 3 个会返回 PRESET_NOT_SUPPORTED
  assert.ok(!signals.description.includes('直链'), '结果直接返回，不再是 CSV 直链')
  // 全市场指标全表 2026-10-23 起会员独享、不再发布：不得再指引去取下载地址；0.5.0 起自定义条件就在本工具 filters 做
  assert.ok(!/hhxg_query_dataset\(dataset_id="quant_signal_pool"\)/.test(signals.description), '全表不再经 query_dataset 下载')
  assert.match(signals.description, /quant_signal_pool）为会员数据，不提供下载地址/)
  assert.ok(!/MCP 客户端直接调/.test(signals.description), '不再把用户支开到别的 MCP 客户端')
  // 条件选股能力要在描述最前面让模型选得到：字段发现、filters 示例、total 语义、只问数量的用法
  assert.match(signals.description.slice(0, 60), /条件选股/)
  assert.match(signals.description, /list_fields=true/)
  assert.match(signals.description, /\{field:"日均线多头", op:"eq", value:1\}/)
  assert.match(signals.description, /MA5>MA10>MA20>MA60/)
  assert.match(signals.description, /total 是全市场满足条件的股票数/)
  assert.match(signals.description, /limit=1/)
  assert.match(signals.description, /next_cursor/)
  assert.match(signals.description, /filters=\[\] 表示不加条件看全市场/)
  for (const id of [...USABLE_PRESETS, ...UNSUPPORTED_PRESETS]) assert.ok(signals.description.includes(id), id)
  assert.match(signals.description, /9 个/)
  assert.match(signals.description, /PRESET_NOT_SUPPORTED/)
  const [usablePart, unsupportedPart] = signals.description.split('PRESET_NOT_SUPPORTED')[0].split('另 3 个')
  for (const id of USABLE_PRESETS) assert.ok(usablePart.includes(id), `${id} 应列在可用预设里`)
  for (const id of UNSUPPORTED_PRESETS) assert.ok(unsupportedPart.includes(id), `${id} 应列在不可用预设里`)
})

test('runTool：两个改道的工具发到线上的工具名与参数', async () => {
  const signals = byName('hhxg_strategy_signals')
  const alerts = byName('hhxg_stock_alerts')
  await withMcpStub(textResult({ data: { total: 1, rows: [{ 股票代码: '600519.SH' }] }, meta: {} }), async (sent) => {
    const out = await runTool(signals, TOKEN, { strategy_id: 'limit_up', limit: 5 })
    assert.match(out, /600519\.SH/)
    await runTool(alerts, TOKEN, { stock_code: '600519', days: 7 })
    assert.equal(sent.length, 2)
    assert.ok(sent.every((req) => req.url === 'https://hhxg.top/mcp/rpc' && req.body.method === 'tools/call'))
    assert.deepEqual(sent[0].body.params, { name: 'screen_stocks', arguments: { preset: 'limit_up', limit: 5 } })
    assert.deepEqual(sent[1].body.params, {
      name: 'query_dataset',
      arguments: { dataset_id: 'stock_alerts_history', key: '600519', days: 7 },
    })
  })
})

test('runTool：缺必填参数时在本地给出可读说明，不发请求', async () => {
  const signals = byName('hhxg_strategy_signals')
  const alerts = byName('hhxg_stock_alerts')
  await withMcpStub(textResult({ data: {}, meta: {} }), async (sent) => {
    // 什么筛选方式都没给就发给 screen_stocks 等于「没传」，会拿到未经筛选的全市场前 N 行——必须在本地拦住，
    // 提示里把三种入口（list_fields / filters / strategy_id 预设清单）都列出来
    for (const args of [{}, { strategy_id: '' }, { strategy_id: '   ' }, { strategy_id: null }, { list_fields: false }, undefined]) {
      const out = await runTool(signals, TOKEN, args)
      assert.match(out, /^请提供筛选方式之一：list_fields=true/)
      assert.match(out, /filters=\[\{field, op, value\}\]/)
      assert.match(out, /strategy_id/)
      for (const id of USABLE_PRESETS) assert.ok(out.includes(id), id)
    }
    // 只给了翻页 / 排序 / 列 / 行数而没有筛选条件：同样拦住，并点名多余参数
    const stray = await runTool(signals, TOKEN, { cursor: '20', limit: 5 })
    assert.match(stray, /^只传了 cursor \/ limit，缺少筛选条件。请提供筛选方式之一/)
    for (const args of [{}, { stock_code: '' }, { stock_code: '  ', days: 7 }, undefined]) {
      const out = await runTool(alerts, TOKEN, args)
      assert.match(out, /stock_code/)
      assert.match(out, /600519/)
    }
    assert.equal(sent.length, 0, '本地就能判定的缺参不得消耗一次请求')
  })
})

test('hhxg_strategy_signals：filters / sort / fields / limit / cursor / list_fields 白名单透传，值不改写', async () => {
  const signals = byName('hhxg_strategy_signals')
  const filters = [{ field: '日均线多头', op: 'eq', value: 1 }, { field: '行业', op: 'IN', value: ['银行', '保险'] }, { field: '涨停原因', op: 'not_null' }]
  const args = { strategy_id: ' limit_up ', filters, sort: ' -涨跌幅% ', fields: ['收盘价', '', 7, '日均线多头'], limit: 1, cursor: ' 20 ', list_fields: false, extra: 'x' }
  const frozen = JSON.stringify(args)
  assert.deepEqual(signals.buildArgs(args), {
    preset: 'limit_up', filters, sort: '-涨跌幅%', fields: ['收盘价', '日均线多头'], limit: 1, cursor: '20', list_fields: false,
  })
  assert.equal(JSON.stringify(args), frozen, '原参数不得被改写')
  assert.equal(signals.buildArgs(args).filters, filters, 'filters 原样透传（含 value:0 / in 数组），不在插件里改写条件值')
  assert.deepEqual(signals.buildArgs({ list_fields: true }), { list_fields: true })
  assert.deepEqual(signals.buildArgs({ filters: [] }), { filters: [] }, '显式空 filters 要发出去（有意看全市场）')
  assert.deepEqual(signals.buildArgs({ filters: [{ field: '涨跌幅%', op: 'gte', value: 0 }] }), { filters: [{ field: '涨跌幅%', op: 'gte', value: 0 }] })
  // 服务端 next_cursor 是数字串 "20"，模型常回传成数字 20：整数转成字符串透传，不能静默丢掉（否则永远拿第一页）
  assert.deepEqual(signals.buildArgs({ filters: [], cursor: 20 }), { filters: [], cursor: '20' })
  assert.deepEqual(signals.buildArgs({ filters: [], cursor: 0 }), { filters: [], cursor: '0' })
  // 参数名与形状跟服务端 screen_stocks 一致
  assert.deepEqual(Object.keys(signals.parameters).sort(), ['cursor', 'fields', 'filters', 'limit', 'list_fields', 'sort', 'strategy_id'])
  assert.equal(signals.parameters.strategy_id.required, undefined, 'strategy_id 不再必填')
  assert.equal(signals.parameters.filters.items.additionalProperties, false)
  assert.deepEqual(signals.parameters.filters.items.properties.op.enum, ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'in', 'contains', 'not_null'])
  await withMcpStub(textResult({ data: { total: 253, returned: 1, fields: ['日均线多头'], rows: [{ 股票代码: '000028.SZ', 日均线多头: 1 }], next_cursor: null }, meta: { as_of: '2026-10-30' } }), async (sent) => {
    for (const a of [
      { list_fields: true },
      { filters: [] },
      { filters: [{ field: '日均线多头', op: 'eq', value: 1 }], limit: 1 },
      { filters: [{ field: '涨停原因', op: 'not_null' }] },
      { strategy_id: 'limit_up', filters: [{ field: '量比', op: 'gt', value: 2 }], cursor: '20' },
    ]) {
      const out = await runTool(signals, TOKEN, a)
      assert.match(out, /000028\.SZ/, JSON.stringify(a))
    }
    assert.equal(sent.length, 5)
    assert.deepEqual(sent[0].body.params, { name: 'screen_stocks', arguments: { list_fields: true } })
    assert.deepEqual(sent[1].body.params.arguments, { filters: [] })
    assert.deepEqual(sent[2].body.params.arguments, { filters: [{ field: '日均线多头', op: 'eq', value: 1 }], limit: 1 })
    assert.deepEqual(sent[4].body.params.arguments, { preset: 'limit_up', filters: [{ field: '量比', op: 'gt', value: 2 }], cursor: '20' })
  })
})

test('hhxg_strategy_signals：filters 形状非法按「参数有误」本地拒绝，不当成没传、不删条件继续查', async () => {
  const signals = byName('hhxg_strategy_signals')
  await withMcpStub(textResult({ data: {}, meta: {} }), async (sent) => {
    const cases = [
      [{ filters: 'x' }, /^参数有误：filters 须为 \[\{field, op, value\}\] 数组（INVALID_ARG）$/],
      [{ filters: { field: 'a', op: 'eq', value: 1 } }, /filters 须为/],
      [{ filters: [{ field: 'a' }] }, /filters 第 1 条须为 \{field, op, value\}，op 取 gt\/gte\/lt\/lte\/eq\/ne\/in\/contains\/not_null（INVALID_ARG）/],
      [{ filters: [{ field: 'a', op: 'eq', value: 1 }, { field: '', op: 'eq', value: 1 }] }, /第 2 条/],
      [{ filters: [{ field: 'a', op: 'between', value: 1 }] }, /第 1 条/],
      [{ filters: [['a', 'eq', 1]] }, /第 1 条/],
      [{ strategy_id: 'limit_up', filters: 'x' }, /filters 须为/],
      [{ filters: Array.from({ length: 9 }, () => ({ field: 'a', op: 'eq', value: 1 })) }, /^参数有误：filters 最多 8 条（收到 9 条）（INVALID_ARG）$/],
      // op 带空白：服务端只 toLowerCase 不 trim，本地同口径拒绝，省一次必败的往返
      [{ filters: [{ field: 'a', op: ' eq', value: 1 }] }, /第 1 条/],
      // value 只能是数字 / 字符串 / 它们的数组
      [{ filters: [{ field: 'a', op: 'eq', value: { x: 1 } }] }, /第 1 条的 value 须为数字、字符串或它们的数组/],
      [{ filters: [{ field: 'a', op: 'eq', value: true }] }, /第 1 条的 value/],
      [{ filters: [{ field: 'a', op: 'in', value: [1, { x: 1 }] }] }, /第 1 条的 value/],
      // cursor 只认字符串 / 非负整数
      [{ filters: [], cursor: { page: 2 } }, /^参数有误：cursor 须为上一页返回的 next_cursor（字符串）（INVALID_ARG）$/],
      [{ filters: [], cursor: 1.5 }, /cursor 须为/],
      [{ filters: [], cursor: true }, /cursor 须为/],
    ]
    for (const [args, re] of cases) assert.match(await runTool(signals, TOKEN, args), re, JSON.stringify(args))
    assert.equal(sent.length, 0)
  })
})

test('业务性错误码渲染成可读文本返回（按类别加前缀）；鉴权 / 限流 / 故障类仍按异常抛出', async () => {
  const business = {
    无结果: ['NO_DATA', 'NOT_FOUND', 'UNSUPPORTED_ASSET', 'UNSUPPORTED_FORMAT'],
    参数有误: ['INVALID_ARGUMENT', 'INVALID_ARG', 'INVALID_ARGS', 'UNKNOWN_FIELD', 'UNSUPPORTED_FILTER', 'RESULT_TOO_LARGE'],
    暂不支持: ['PRESET_NOT_SUPPORTED', 'DATASET_TOO_LARGE', 'USE_SCREEN_STOCKS'],
    暂未就绪: ['RT_SYNCING', 'RT_INDICATORS_STALE', 'RT_INDICATORS_UNAVAILABLE', 'RT_NAMES_UNAVAILABLE'],
    '需要 Max': ['MAX_REQUIRED', 'REALTIME_MAX_REQUIRED'],
  }
  for (const [label, codes] of Object.entries(business)) {
    for (const errorCode of codes) {
      await withMcpStub(textResult({ error: `原因说明 ${errorCode}`, errorCode, meta: {} }, true), async () => {
        const out = await mcpCall(TOKEN, 'screen_stocks', {})
        assert.equal(out, `${label}：原因说明 ${errorCode}（${errorCode}）`)
      })
    }
  }
  // PRESET_UNAVAILABLE 是站点查询服务离线（请稍后重试），属于故障，不能说成「无结果」
  const faults = [
    'PRESET_UNAVAILABLE', 'RT_UNAVAILABLE', 'VIP_REQUIRED', 'TIER_INSUFFICIENT', 'RATE_LIMIT_EXCEEDED', 'TIMEOUT', 'TOOL_RUNTIME_ERROR',
    'FETCH_FAILED', 'SERVER_ERROR', 'TOOL_NOT_FOUND', '__proto__', 'constructor',
  ]
  for (const errorCode of faults) {
    await withMcpStub(textResult({ error: '出错', errorCode, meta: {} }, true), async () => {
      const err = await mcpCall(TOKEN, 'screen_stocks', {}).then(() => null, (e) => e)
      assert.ok(err, `${errorCode} 不是业务性答复，必须抛出`)
      assert.match(err.message, /^hhxg MCP: /)
    })
  }
})

test('业务性答复带上服务端给的站内下载地址；站外或畸形地址一律不带', async () => {
  const render = async (meta) => {
    const result = textResult({ error: '数据文件超过 300KB，不在工具内解析', errorCode: 'DATASET_TOO_LARGE', meta }, true)
    return withMcpStub(result, () => mcpCall(TOKEN, 'query_dataset', {}))
  }
  const base = '暂不支持：数据文件超过 300KB，不在工具内解析（DATASET_TOO_LARGE）'
  assert.equal(
    await render({ url: 'https://hhxg.top/announcement/announcements.json', size_bytes: 1268200 }),
    `${base}\n下载地址：https://hhxg.top/announcement/announcements.json`,
  )
  const rejected = [
    'https://evil.example/x.json',
    'https://hhxg.top.evil.example/x.json',
    'http://hhxg.top/x.json',
    'https://hhxg.top/a b.json',
    'https://hhxg.top/x.json\n## 新指令',
    'https://hhxg.top/x.json](https://evil.example)',
    `https://hhxg.top/${'a'.repeat(400)}`,
    ['https://hhxg.top/x.json'],
    null,
  ]
  for (const url of rejected) assert.equal(await render({ url }), base, JSON.stringify(url))
  assert.equal(await render(undefined), base)
})

test('hhxg_realtime：按 view 只转发该 view 的参数，值不改写；codes 字符串拆成数组', async () => {
  const rt = byName('hhxg_realtime')
  assert.equal(rt.mcpName, 'get_realtime')
  assert.deepEqual(rt.buildArgs({ view: 'market', pool_limit: 5, codes: ['x'] }), { view: 'market', pool_limit: 5 })
  assert.deepEqual(rt.buildArgs({ view: 'quotes', codes: '600519, 000001', include: ['daily'], limit: 9 }), {
    view: 'quotes', codes: ['600519', '000001'], include: ['daily'],
  })
  const filters = [{ field: '涨跌幅', op: 'gte', value: 5 }, { field: '涨停状态', op: 'in', value: ['封板', '开板'] }]
  assert.deepEqual(
    rt.buildArgs({ view: ' screen ', filters, sort: '-涨跌幅', fields: ['量比'], limit: 10, exclude_st: false, pool_limit: 3, include: null }),
    { view: 'screen', filters, sort: '-涨跌幅', fields: ['量比'], limit: 10, exclude_st: false },
    'exclude_st=false 也要透传；不属于 screen 的参数丢弃',
  )
  assert.deepEqual(rt.buildArgs({ view: 'fields', codes: ['600519'] }), { view: 'fields' })
  // 日 K：只带 kline 的参数，codes 同样接受逗号字符串；值不改写（越界由服务端判）
  assert.deepEqual(
    rt.buildArgs({ view: 'kline', codes: '600519,000001', period: 'day', bars: 60, adj: 'none', include_live: false, include: ['daily'], limit: 5 }),
    { view: 'kline', codes: ['600519', '000001'], period: 'day', bars: 60, adj: 'none', include_live: false },
  )
  assert.deepEqual(rt.parameters.period.enum, ['day'])
  assert.deepEqual(rt.parameters.adj.enum, ['none', 'qfq'])
  await withMcpStub(textResult({ data: { frame: { status: 'live' } }, meta: {} }), async (sent) => {
    await runTool(rt, TOKEN, { view: 'quotes', codes: ['600519'] })
    assert.deepEqual(sent[0].body.params, { name: 'get_realtime', arguments: { view: 'quotes', codes: ['600519'] } })
  })
})

test('hhxg_realtime：view 缺失 / 非法、quotes 缺 codes 时本地给说明，不发请求', async () => {
  const rt = byName('hhxg_realtime')
  await withMcpStub(textResult({ data: {}, meta: {} }), async (sent) => {
    for (const args of [
      undefined, {}, { view: '' }, { view: 'ticks' }, { view: '__proto__' }, { view: 'toString' },
      { view: ['market'] }, { view: { toString: () => 'market' } }, { view: 1 }, { view: null },
    ]) {
      assert.match(await runTool(rt, TOKEN, args), /请提供 view：market/, JSON.stringify(args))
    }
    for (const args of [{ view: 'quotes' }, { view: 'quotes', codes: [] }, { view: 'quotes', codes: ' , ' }]) {
      assert.match(await runTool(rt, TOKEN, args), /view=quotes 需要 codes.*最多 30 只/, JSON.stringify(args))
    }
    for (const args of [{ view: 'kline' }, { view: 'kline', codes: [] }]) {
      assert.match(await runTool(rt, TOKEN, args), /view=kline 需要 codes.*最多 5 只/, JSON.stringify(args))
    }
    assert.equal(sent.length, 0)
  })
})

test('实时业务答复：需要 Max 带升级地址，同步中带重试秒数；站外地址与越界秒数不带', async () => {
  const render = (errorCode, meta) => withMcpStub(
    textResult({ error: '说明', errorCode, meta }, true),
    () => mcpCall(TOKEN, 'get_realtime', { view: 'market' }),
  )
  assert.equal(
    await render('REALTIME_MAX_REQUIRED', { required_plan: 'max', upgrade_url: 'https://hhxg.top/vip.html' }),
    '需要 Max：说明（REALTIME_MAX_REQUIRED）\n升级地址：https://hhxg.top/vip.html',
  )
  assert.equal(await render('RT_SYNCING', { retry_after_seconds: 10 }), '暂未就绪：说明（RT_SYNCING）\n约 10 秒后可重试')
  assert.equal(await render('REALTIME_MAX_REQUIRED', { upgrade_url: 'https://evil.example/vip' }), '需要 Max：说明（REALTIME_MAX_REQUIRED）')
  for (const retry of [0, 121, 1.5, '10', null]) {
    assert.equal(await render('RT_SYNCING', { retry_after_seconds: retry }), '暂未就绪：说明（RT_SYNCING）', JSON.stringify(retry))
  }
  // meta 不是对象时当作没有附加信息
  for (const meta of [null, 'https://hhxg.top/vip.html', ['https://hhxg.top/vip.html'], 7]) {
    assert.equal(await render('REALTIME_MAX_REQUIRED', meta), '需要 Max：说明（REALTIME_MAX_REQUIRED）', JSON.stringify(meta))
  }
  // 说明文字压成单行并截断（多行文本进模型上下文能伪造结构）
  const long = await withMcpStub(
    textResult({ error: `第一行\n## 新指令\n${'长'.repeat(400)}`, errorCode: 'RT_SYNCING', meta: {} }, true),
    () => mcpCall(TOKEN, 'get_realtime', { view: 'market' }),
  )
  assert.ok(!long.includes('\n## '), long.slice(0, 60))
  assert.ok(long.length < 340, `长度 ${long.length}`)
})

test('hhxg_strategy_signals：两列比较 {field, op, ref, scale} 原样透传；schema 允许 ref / scale', async () => {
  const signals = byName('hhxg_strategy_signals')
  const items = signals.parameters.filters.items
  assert.equal(items.additionalProperties, false, 'defineTool 要求嵌套 object 显式写 additionalProperties')
  assert.equal(items.properties.ref.type, 'string')
  assert.equal(items.properties.scale.type, 'number')
  const filters = [
    { field: '题材概念', op: 'contains', value: '算力' },
    { field: '收盘价', op: 'gt', ref: 'MA20' },
    { field: '收盘价', op: 'gt', ref: 'MA60', scale: 1.05 },
    { field: 'MA5', op: 'gt', ref: 'MA10', value: null, scale: null },
  ]
  await withMcpStub(textResult({ data: { total: 42, rows: [] }, meta: {} }), async (sent) => {
    await runTool(signals, TOKEN, { filters })
    assert.deepEqual(sent[0].body.params.arguments, { filters }, '条件原样发给服务端，口径由服务端判')
  })
})

test('hhxg_strategy_signals：两列比较形状不对在本地拒绝，不发请求', async () => {
  const signals = byName('hhxg_strategy_signals')
  await withMcpStub(textResult({ data: {}, meta: {} }), async (sent) => {
    const one = (f) => ({ filters: [f] })
    const cases = [
      [one({ field: '收盘价', op: 'gt', ref: '' }), /第 1 条的 ref 须为另一个数值字段名/],
      [one({ field: '收盘价', op: 'gt', ref: 3 }), /第 1 条的 ref 须为另一个数值字段名/],
      [one({ field: '收盘价', op: 'gt', ref: '收盘价' }), /第 1 条的 ref 不能和 field 是同一个字段/],
      [one({ field: '收盘价', op: 'eq', ref: 'MA20' }), /第 1 条是两列比较，op 只能用 gt\/gte\/lt\/lte/],
      [one({ field: '收盘价', op: 'not_null', ref: 'MA20' }), /op 只能用 gt\/gte\/lt\/lte/],
      [one({ field: '收盘价', op: 'gt', ref: 'MA20', value: 1 }), /第 1 条写了 ref 就不要写 value/],
      [one({ field: '收盘价', op: 'gt', ref: 'MA20', scale: 0 }), /第 1 条的 scale 须为大于 0、不超过 100 的数字/],
      [one({ field: '收盘价', op: 'gt', ref: 'MA20', scale: 101 }), /scale 须为/],
      [one({ field: '收盘价', op: 'gt', ref: 'MA20', scale: '1.05' }), /scale 须为/],
      [one({ field: '收盘价', op: 'gt', value: 1, scale: 2 }), /第 1 条的 scale 只和 ref 一起用/],
    ]
    for (const [args, re] of cases) {
      const out = await runTool(signals, TOKEN, args)
      assert.match(out, /^参数有误：/, JSON.stringify(args))
      assert.match(out, re, JSON.stringify(args))
    }
    assert.equal(sent.length, 0)
  })
})

test('hhxg_strategy_signals：说明教两列比较，并要求把条件交给服务端，不翻页自己比', () => {
  const { description } = byName('hhxg_strategy_signals')
  assert.match(description, /ref/)
  assert.match(description, /scale/)
  assert.match(description, /不要翻页/)
  assert.match(description, /题材概念/)
  assert.match(description, /股票池/)
  assert.doesNotMatch(description, /约 200 个字段/, '服务端现在是约 270 列')
})

test('hhxg_realtime：view=screen 也支持 ref / scale 与 contains，形状不对本地拒绝', async () => {
  const rt = byName('hhxg_realtime')
  const items = rt.parameters.filters.items
  assert.equal(items.additionalProperties, false)
  assert.equal(items.properties.ref.type, 'string')
  assert.equal(items.properties.scale.type, 'number')
  assert.ok(items.properties.op.enum.includes('contains'), '盘后属性列（题材概念等）要用 contains')
  assert.match(rt.description, /ref/)
  assert.match(rt.description, /同为实时字段/)
  const filters = [{ field: '最新价', op: 'gt', ref: 'MA20', scale: 1.02 }, { field: '题材概念', op: 'contains', value: '算力' }]
  await withMcpStub(textResult({ data: { frame: { status: 'closed' }, total: 0, rows: [] }, meta: {} }), async (sent) => {
    await runTool(rt, TOKEN, { view: 'screen', filters })
    assert.deepEqual(sent[0].body.params.arguments, { view: 'screen', filters })
    const bad = await runTool(rt, TOKEN, { view: 'screen', filters: [{ field: '最新价', op: 'eq', ref: 'MA20' }] })
    assert.match(bad, /^参数有误：.*op 只能用 gt\/gte\/lt\/lte/)
    assert.equal(sent.length, 1, '形状不对的不发请求')
  })
})

test('多值列（题材概念 / 股票池 / 持股标签 / 游资席位）只认 contains / not_null：取反会静默返回几乎全市场，本地拒绝', async () => {
  const signals = byName('hhxg_strategy_signals')
  const rt = byName('hhxg_realtime')
  await withMcpStub(textResult({ data: { total: 1, rows: [] }, meta: {} }), async (sent) => {
    for (const op of ['ne', 'eq', 'in', 'gt']) {
      for (const field of ['题材概念', '股票池', '持股标签', '游资席位']) {
        const value = op === 'in' ? ['算力'] : '算力'
        const out = await runTool(signals, TOKEN, { filters: [{ field, op, value }] })
        assert.match(out, /^参数有误：filters 第 1 条的 .+ 是多值列，只能用 contains（按名称）或 not_null，不支持取反/, `${field} ${op}`)
      }
    }
    const live = await runTool(rt, TOKEN, { view: 'screen', filters: [{ field: '题材概念', op: 'ne', value: '算力' }] })
    assert.match(live, /是多值列/)
    assert.equal(sent.length, 0)
    await runTool(signals, TOKEN, { filters: [{ field: '题材概念', op: 'contains', value: '算力' }, { field: '游资席位', op: 'not_null' }] })
    assert.equal(sent.length, 1, 'contains / not_null 照常放行')
  })
})

test('说明里写清企业类型是实控人性质（民营多记为 自然人）', () => {
  const { description } = byName('hhxg_strategy_signals')
  assert.match(description, /企业类型.*自然人/)
})

test('hhxg_realtime：view=screen 的布尔 value 本地拒绝（服务端同样只认有限数字 / 字符串）', async () => {
  const rt = byName('hhxg_realtime')
  await withMcpStub(textResult({ data: {}, meta: {} }), async (sent) => {
    const out = await runTool(rt, TOKEN, { view: 'screen', filters: [{ field: '涨停状态', op: 'eq', value: true }] })
    assert.match(out, /^参数有误：filters 第 1 条的 value 须为数字、字符串或它们的数组/)
    assert.equal(sent.length, 0)
  })
})

test('工具说明分流盘中 / 盘后：hhxg_strategy_signals 写明不含今天盘中、交易时段改用 hhxg_realtime view=screen；hhxg_realtime 要求交易时段选股优先 view=screen，并写明指标口径与无翻页', () => {
  const signals = byName('hhxg_strategy_signals')
  assert.match(signals.description, /不含今天盘中行情/)
  assert.match(signals.description, /hhxg_realtime view=screen/)
  assert.match(signals.description, /收盘价换成 最新价|价格字段叫 最新价/)
  const rt = byName('hhxg_realtime')
  assert.match(rt.description, /^盘中实时数据（交易日 9:30–15:00/)
  assert.match(rt.description, /优先用 view=screen/)
  assert.match(rt.description, /hhxg_strategy_signals/)
  assert.match(rt.description, /不是上一交易日收盘的指标/)
  assert.match(rt.description, /base_date/)
  assert.match(rt.description, /没有翻页/)
  assert.match(rt.parameters.limit.description, /无翻页|没有翻页/)
})

test('hhxg_realtime：view=screen 的 limit 说明为 1-100 且无翻页（服务端 2026-11-04 起上限 100）', () => {
  const rt = byName('hhxg_realtime')
  assert.match(rt.description, /limit 1-100 且没有翻页/)
  assert.doesNotMatch(rt.description, /limit 1-50/)
  assert.match(rt.parameters.limit.description, /1-100/)
  assert.deepEqual(rt.buildArgs({ view: 'screen', filters: [], limit: 100 }), { view: 'screen', filters: [], limit: 100 }, 'limit 原样透传，权威校验在服务端')
})
