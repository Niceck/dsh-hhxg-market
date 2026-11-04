/**
 * 免费工具真实端点冒烟测试 + VIP 工具纯逻辑单测。
 *
 * 运行：node --test test/
 * 免费工具部分需要网络（打真实 hhxg.top 公开端点）；
 * 设 HHXG_SKIP_NETWORK=1 可只跑纯逻辑部分。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mcpCall } from '../lib/api.js'
import { FREE_TOOLS, VIP_TOOLS, runVipTool, vipLockedMessage } from '../lib/tools.js'

const SKIP_NET = process.env.HHXG_SKIP_NETWORK === '1'

test('注册表形态：7 免费 + 6 VIP，名称唯一且带 hhxg_ 前缀', () => {
  assert.equal(FREE_TOOLS.length, 7)
  assert.equal(VIP_TOOLS.length, 6)
  const names = [...FREE_TOOLS, ...VIP_TOOLS].map((t) => t.name)
  assert.equal(new Set(names).size, names.length)
  for (const n of names) assert.match(n, /^hhxg_/)
})

test('VIP 工具 buildArgs：股票代码与边界收敛', () => {
  const diag = VIP_TOOLS.find((t) => t.name === 'hhxg_diagnose_stock')
  assert.deepEqual(diag.buildArgs({ stock_code: '000001.SZ' }), { stock_code: '000001.SZ' })

  // 个股异动历史改走通用取数的按键读取：dataset_id 固定，股票代码进 key
  const alerts = VIP_TOOLS.find((t) => t.name === 'hhxg_stock_alerts')
  assert.equal(alerts.mcpName, 'query_dataset')
  assert.deepEqual(
    alerts.buildArgs({ stock_code: '600246', days: 7 }),
    { dataset_id: 'stock_alerts_history', key: '600246', days: 7 },
  )
  assert.deepEqual(alerts.buildArgs({ stock_code: ' 600246.SH ' }), { dataset_id: 'stock_alerts_history', key: '600246.SH' })
  // 越界 days 丢弃（走服务端默认），不透传垃圾值
  assert.deepEqual(alerts.buildArgs({ stock_code: '600246', days: 99 }), { dataset_id: 'stock_alerts_history', key: '600246' })
  assert.deepEqual(alerts.buildArgs({ stock_code: '600246', days: 'x' }), { dataset_id: 'stock_alerts_history', key: '600246' })

  const query = VIP_TOOLS.find((t) => t.name === 'hhxg_query_dataset')
  assert.deepEqual(
    query.buildArgs({ dataset_id: 'xuangu', filters: { pool: 'a' }, sort: '-pct', limit: 10 }),
    { dataset_id: 'xuangu', filters: { pool: 'a' }, sort: '-pct', limit: 10 },
  )
  assert.deepEqual(query.buildArgs({ dataset_id: 'xuangu', limit: 9999 }), { dataset_id: 'xuangu' })
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

test('VIP 工具只调用服务端正式工具，不再调用已弃用的旧名', () => {
  for (const spec of VIP_TOOLS) {
    assert.ok(SERVER_TOOLS.includes(spec.mcpName), `${spec.name} → ${spec.mcpName}`)
    assert.ok(!LEGACY_MCP_TOOLS.includes(spec.mcpName), `${spec.name} 仍在调用旧工具 ${spec.mcpName}`)
  }
})

test('策略信号改走 screen_stocks 的策略预设：strategy_id → preset，limit 透传并收敛', () => {
  const signals = VIP_TOOLS.find((t) => t.name === 'hhxg_strategy_signals')
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

/** 打桩 fetch：记录发往 MCP 的 JSON-RPC 请求体，返回给定的工具结果。 */
async function withMcpStub(result, run) {
  const origFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
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
const TOKEN = 'dummy_token_1234567890'
const textResult = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], ...(isError ? { isError: true } : {}) })

test('runVipTool：两个改道的工具发到线上的工具名与参数', async () => {
  const signals = VIP_TOOLS.find((t) => t.name === 'hhxg_strategy_signals')
  const alerts = VIP_TOOLS.find((t) => t.name === 'hhxg_stock_alerts')
  await withMcpStub(textResult({ data: { total: 1, rows: [{ 股票代码: '600519.SH' }] }, meta: {} }), async (sent) => {
    const out = await runVipTool(signals, TOKEN, { strategy_id: 'limit_up', limit: 5 })
    assert.match(out, /600519\.SH/)
    await runVipTool(alerts, TOKEN, { stock_code: '600519', days: 7 })
    assert.equal(sent.length, 2)
    assert.ok(sent.every((req) => req.url === 'https://hhxg.top/mcp/rpc' && req.body.method === 'tools/call'))
    assert.deepEqual(sent[0].body.params, { name: 'screen_stocks', arguments: { preset: 'limit_up', limit: 5 } })
    assert.deepEqual(sent[1].body.params, {
      name: 'query_dataset',
      arguments: { dataset_id: 'stock_alerts_history', key: '600519', days: 7 },
    })
  })
})

test('runVipTool：缺必填参数时在本地给出可读说明，不发请求', async () => {
  const signals = VIP_TOOLS.find((t) => t.name === 'hhxg_strategy_signals')
  const alerts = VIP_TOOLS.find((t) => t.name === 'hhxg_stock_alerts')
  await withMcpStub(textResult({ data: {}, meta: {} }), async (sent) => {
    // 什么筛选方式都没给就发给 screen_stocks 等于「没传」，会拿到未经筛选的全市场前 N 行——必须在本地拦住，
    // 提示里把三种入口（list_fields / filters / strategy_id 预设清单）都列出来
    for (const args of [{}, { strategy_id: '' }, { strategy_id: '   ' }, { strategy_id: null }, { list_fields: false }, undefined]) {
      const out = await runVipTool(signals, TOKEN, args)
      assert.match(out, /^请提供筛选方式之一：list_fields=true/)
      assert.match(out, /filters=\[\{field, op, value\}\]/)
      assert.match(out, /strategy_id/)
      for (const id of USABLE_PRESETS) assert.ok(out.includes(id), id)
    }
    // 只给了翻页 / 排序 / 列 / 行数而没有筛选条件：同样拦住，并点名多余参数
    const stray = await runVipTool(signals, TOKEN, { cursor: '20', limit: 5 })
    assert.match(stray, /^只传了 cursor \/ limit，缺少筛选条件。请提供筛选方式之一/)
    for (const args of [{}, { stock_code: '' }, { stock_code: '  ', days: 7 }, undefined]) {
      const out = await runVipTool(alerts, TOKEN, args)
      assert.match(out, /stock_code/)
      assert.match(out, /600519/)
    }
    assert.equal(sent.length, 0, '本地就能判定的缺参不得消耗一次请求')
  })
})

test('hhxg_strategy_signals：filters / sort / fields / limit / cursor / list_fields 白名单透传，值不改写', async () => {
  const signals = VIP_TOOLS.find((t) => t.name === 'hhxg_strategy_signals')
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
      const out = await runVipTool(signals, TOKEN, a)
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
  const signals = VIP_TOOLS.find((t) => t.name === 'hhxg_strategy_signals')
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
    for (const [args, re] of cases) assert.match(await runVipTool(signals, TOKEN, args), re, JSON.stringify(args))
    assert.equal(sent.length, 0)
  })
})

test('业务性错误码渲染成可读文本返回（按类别加前缀）；鉴权 / 限流 / 故障类仍按异常抛出', async () => {
  const business = {
    无结果: ['NO_DATA', 'NOT_FOUND', 'UNSUPPORTED_ASSET', 'UNSUPPORTED_FORMAT'],
    参数有误: ['INVALID_ARGUMENT', 'INVALID_ARG', 'INVALID_ARGS', 'UNKNOWN_FIELD', 'UNSUPPORTED_FILTER', 'RESULT_TOO_LARGE'],
    暂不支持: ['PRESET_NOT_SUPPORTED', 'DATASET_TOO_LARGE', 'USE_SCREEN_STOCKS'],
    暂未就绪: ['RT_SYNCING', 'RT_INDICATORS_STALE', 'RT_INDICATORS_UNAVAILABLE', 'RT_NAMES_UNAVAILABLE'],
    '需要 Max': ['REALTIME_MAX_REQUIRED'],
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

test('数据集目录：JSON 与 300KB 以内的 CSV 标可查，超限与只有历史分片的另行标注', async () => {
  const datasets = FREE_TOOLS.find((t) => t.name === 'hhxg_datasets')
  assert.ok(!/46/.test(datasets.description), '数据集数量会变，描述里不写死')
  const at = (path) => ({ latest: `https://hhxg.top/${path}` })
  const payload = {
    dataset_count: 8,
    datasets: [
      { id: 'small_json', category: '情绪', title: '小 JSON', format: 'json', size_bytes: 2000, urls: at('a.json') },
      { id: 'small_csv', category: '游资', title: '小 CSV', format: 'csv', size_bytes: 300 * 1024, urls: at('a.csv') },
      { id: 'big_csv', category: '选股', title: '大 CSV', format: 'csv', size_bytes: 300 * 1024 + 1, urls: at('b.csv') },
      { id: 'big_json', category: '公告', title: '大 JSON', format: 'json', size_bytes: 1268200, urls: at('b.json') },
      { id: 'monthly_csv', category: '两融', title: '按月 CSV', format: 'csv', urls: { history_pattern: 'https://hhxg.top/m/YYYYMM.csv' } },
      { id: 'xml_feed', category: '其他', title: 'XML', format: 'xml', size_bytes: 100, urls: at('f.xml') },
      // 会员专属宽表：清单不给 urls，只能经策略筛选
      { id: 'quant_signal_pool', category: '策略', title: '全市场宽表', format: 'csv', size_bytes: 4_000_000, tier: 'trial', access: 'member', delivery: 'screen_stocks', urls: {} },
      // 会员 KB：清单保留 latest，经 query_dataset 取（插件的 query 本就要 VIP Token）
      { id: 'kb_stock_indicators', category: '策略', title: '指标榜', format: 'json', size_bytes: 3000, tier: 'trial', access: 'member', delivery: 'query_dataset', urls: at('k.json') },
    ],
  }
  const origFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  let out
  try {
    out = await datasets.run({}, undefined)
  } finally {
    globalThis.fetch = origFetch
  }
  const mark = (id) => out.split('\n').find((line) => line.startsWith(`| ${id} |`)).split('|').at(-2).trim()
  assert.equal(mark('small_json'), '✓')
  assert.equal(mark('small_csv'), '✓', '300KB 以内的 CSV 现在可查')
  assert.equal(mark('big_csv'), '过大')
  assert.equal(mark('big_json'), '过大')
  assert.equal(mark('monthly_csv'), '—')
  assert.equal(mark('xml_feed'), '—')
  assert.equal(mark('quant_signal_pool'), '筛选')
  assert.equal(mark('kb_stock_indicators'), '✓')
  assert.match(out, /「筛选」是会员专属的全市场宽表，不提供下载/)
  assert.ok(!out.includes('需直接下载'), '「—」不再一律指引直接下载')
  assert.ok(!out.includes('仅 JSON'), '「仅 JSON 可 query」已过期')
  assert.match(out, /8\/8 个/)
})

test('hhxg_realtime：按 view 只转发该 view 的参数，值不改写；codes 字符串拆成数组', async () => {
  const rt = VIP_TOOLS.find((t) => t.name === 'hhxg_realtime')
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
    await runVipTool(rt, TOKEN, { view: 'quotes', codes: ['600519'] })
    assert.deepEqual(sent[0].body.params, { name: 'get_realtime', arguments: { view: 'quotes', codes: ['600519'] } })
  })
})

test('hhxg_realtime：view 缺失 / 非法、quotes 缺 codes 时本地给说明，不发请求', async () => {
  const rt = VIP_TOOLS.find((t) => t.name === 'hhxg_realtime')
  await withMcpStub(textResult({ data: {}, meta: {} }), async (sent) => {
    for (const args of [
      undefined, {}, { view: '' }, { view: 'ticks' }, { view: '__proto__' }, { view: 'toString' },
      { view: ['market'] }, { view: { toString: () => 'market' } }, { view: 1 }, { view: null },
    ]) {
      assert.match(await runVipTool(rt, TOKEN, args), /请提供 view：market/, JSON.stringify(args))
    }
    for (const args of [{ view: 'quotes' }, { view: 'quotes', codes: [] }, { view: 'quotes', codes: ' , ' }]) {
      assert.match(await runVipTool(rt, TOKEN, args), /view=quotes 需要 codes.*最多 30 只/, JSON.stringify(args))
    }
    for (const args of [{ view: 'kline' }, { view: 'kline', codes: [] }]) {
      assert.match(await runVipTool(rt, TOKEN, args), /view=kline 需要 codes.*最多 5 只/, JSON.stringify(args))
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

test('未配置 token 的占位文案写的是 cordis.patch.yml 写法，不再指向不存在的设置界面', () => {
  const text = vipLockedMessage('hhxg_realtime')
  assert.match(text, /cordis\.patch\.yml/)
  assert.match(text, /id: hhxg-market/)
  assert.doesNotMatch(text, /设置 → 插件/)
})

test('未配置 token 的占位文案含开通与配置指引', () => {
  const msg = vipLockedMessage('hhxg_diagnose_stock')
  assert.match(msg, /vip\.html/)
  assert.match(msg, /https:\/\/hhxg\.top\/developer\.html#mcp/, '0.5.1 起 Token 签发页是开发者接入页')
  assert.doesNotMatch(msg, /account\/mcp\.html/, '旧地址只剩跳转壳，不再出现在文案里')
  assert.match(msg, /mcpToken/)
  assert.match(msg, /hhxg_datasets/)
  assert.match(msg, /Max 会员（月付 ¥99/, '2026-10-27 起 MCP Token 只签给 Max')
  assert.ok(!msg.includes('¥20 /'), '旧的 VIP ¥20 档已不再签发 MCP Token')
})

for (const spec of FREE_TOOLS) {
  test(`免费工具 ${spec.name} 真实调用返回非空文本`, { skip: SKIP_NET }, async () => {
    const out = await spec.run(spec.name === 'hhxg_news' ? { limit: 5 } : {}, undefined)
    assert.equal(typeof out, 'string')
    assert.ok(out.length > 50, `${spec.name} 输出过短: ${out.slice(0, 80)}`)
    assert.ok(!out.includes('undefined |'), `${spec.name} 输出含未清洗的 undefined`)
    assert.match(out, /hhxg\.top/, '输出应带数据来源落款')
  })
}

test('hhxg_strategy_signals：两列比较 {field, op, ref, scale} 原样透传；schema 允许 ref / scale', async () => {
  const signals = VIP_TOOLS.find((t) => t.name === 'hhxg_strategy_signals')
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
    await runVipTool(signals, TOKEN, { filters })
    assert.deepEqual(sent[0].body.params.arguments, { filters }, '条件原样发给服务端，口径由服务端判')
  })
})

test('hhxg_strategy_signals：两列比较形状不对在本地拒绝，不发请求', async () => {
  const signals = VIP_TOOLS.find((t) => t.name === 'hhxg_strategy_signals')
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
      const out = await runVipTool(signals, TOKEN, args)
      assert.match(out, /^参数有误：/, JSON.stringify(args))
      assert.match(out, re, JSON.stringify(args))
    }
    assert.equal(sent.length, 0)
  })
})

test('hhxg_strategy_signals：说明教两列比较，并要求把条件交给服务端，不翻页自己比', () => {
  const { description } = VIP_TOOLS.find((t) => t.name === 'hhxg_strategy_signals')
  assert.match(description, /ref/)
  assert.match(description, /scale/)
  assert.match(description, /不要翻页/)
  assert.match(description, /题材概念/)
  assert.match(description, /股票池/)
  assert.doesNotMatch(description, /约 200 个字段/, '服务端现在是约 270 列')
})

test('hhxg_realtime：view=screen 也支持 ref / scale 与 contains，形状不对本地拒绝', async () => {
  const rt = VIP_TOOLS.find((t) => t.name === 'hhxg_realtime')
  const items = rt.parameters.filters.items
  assert.equal(items.additionalProperties, false)
  assert.equal(items.properties.ref.type, 'string')
  assert.equal(items.properties.scale.type, 'number')
  assert.ok(items.properties.op.enum.includes('contains'), '盘后属性列（题材概念等）要用 contains')
  assert.match(rt.description, /ref/)
  assert.match(rt.description, /同为实时字段/)
  const filters = [{ field: '最新价', op: 'gt', ref: 'MA20', scale: 1.02 }, { field: '题材概念', op: 'contains', value: '算力' }]
  await withMcpStub(textResult({ data: { frame: { status: 'closed' }, total: 0, rows: [] }, meta: {} }), async (sent) => {
    await runVipTool(rt, TOKEN, { view: 'screen', filters })
    assert.deepEqual(sent[0].body.params.arguments, { view: 'screen', filters })
    const bad = await runVipTool(rt, TOKEN, { view: 'screen', filters: [{ field: '最新价', op: 'eq', ref: 'MA20' }] })
    assert.match(bad, /^参数有误：.*op 只能用 gt\/gte\/lt\/lte/)
    assert.equal(sent.length, 1, '形状不对的不发请求')
  })
})

test('多值列（题材概念 / 股票池 / 持股标签 / 游资席位）只认 contains / not_null：取反会静默返回几乎全市场，本地拒绝', async () => {
  const signals = VIP_TOOLS.find((t) => t.name === 'hhxg_strategy_signals')
  const rt = VIP_TOOLS.find((t) => t.name === 'hhxg_realtime')
  await withMcpStub(textResult({ data: { total: 1, rows: [] }, meta: {} }), async (sent) => {
    for (const op of ['ne', 'eq', 'in', 'gt']) {
      for (const field of ['题材概念', '股票池', '持股标签', '游资席位']) {
        const value = op === 'in' ? ['算力'] : '算力'
        const out = await runVipTool(signals, TOKEN, { filters: [{ field, op, value }] })
        assert.match(out, /^参数有误：filters 第 1 条的 .+ 是多值列，只能用 contains（按名称）或 not_null，不支持取反/, `${field} ${op}`)
      }
    }
    const live = await runVipTool(rt, TOKEN, { view: 'screen', filters: [{ field: '题材概念', op: 'ne', value: '算力' }] })
    assert.match(live, /是多值列/)
    assert.equal(sent.length, 0)
    await runVipTool(signals, TOKEN, { filters: [{ field: '题材概念', op: 'contains', value: '算力' }, { field: '游资席位', op: 'not_null' }] })
    assert.equal(sent.length, 1, 'contains / not_null 照常放行')
  })
})

test('说明里写清企业类型是实控人性质（民营多记为 自然人）', () => {
  const { description } = VIP_TOOLS.find((t) => t.name === 'hhxg_strategy_signals')
  assert.match(description, /企业类型.*自然人/)
})

test('hhxg_realtime：view=screen 的布尔 value 本地拒绝（服务端同样只认有限数字 / 字符串）', async () => {
  const rt = VIP_TOOLS.find((t) => t.name === 'hhxg_realtime')
  await withMcpStub(textResult({ data: {}, meta: {} }), async (sent) => {
    const out = await runVipTool(rt, TOKEN, { view: 'screen', filters: [{ field: '涨停状态', op: 'eq', value: true }] })
    assert.match(out, /^参数有误：filters 第 1 条的 value 须为数字、字符串或它们的数组/)
    assert.equal(sent.length, 0)
  })
})

test('工具说明分流盘中 / 盘后：hhxg_strategy_signals 写明不含今天盘中、交易时段改用 hhxg_realtime view=screen；hhxg_realtime 要求交易时段选股优先 view=screen，并写明指标口径与无翻页', () => {
  const signals = VIP_TOOLS.find((t) => t.name === 'hhxg_strategy_signals')
  assert.match(signals.description, /不含今天盘中行情/)
  assert.match(signals.description, /hhxg_realtime view=screen/)
  assert.match(signals.description, /收盘价换成 最新价|价格字段叫 最新价/)
  const rt = VIP_TOOLS.find((t) => t.name === 'hhxg_realtime')
  assert.match(rt.description, /优先用 view=screen/)
  assert.match(rt.description, /hhxg_strategy_signals/)
  assert.match(rt.description, /不是上一交易日收盘的指标/)
  assert.match(rt.description, /base_date/)
  assert.match(rt.description, /没有翻页/)
  assert.match(rt.parameters.limit.description, /无翻页|没有翻页/)
})
