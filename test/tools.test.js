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

test('注册表形态：7 免费 + 5 VIP，名称唯一且带 hhxg_ 前缀', () => {
  assert.equal(FREE_TOOLS.length, 7)
  assert.equal(VIP_TOOLS.length, 5)
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

// 服务端 0.3.0 把 8 个旧工具改成了只保留到 2026-11-30 的别名：插件不得再调用它们
const LEGACY_MCP_TOOLS = [
  'get_dataset', 'get_history', 'get_anomalies', 'get_sentiment', 'get_themes_ranking',
  'get_stock_alerts_history', 'get_strategy_signals', 'search_news',
]
const SERVER_TOOLS = [
  'discover_data', 'query_dataset', 'search_documents', 'get_document',
  'screen_stocks', 'diagnose_stock', 'predict_lianban_promotion',
]
const USABLE_PRESETS = [
  'limit_up', 'volume_breakout', 'low_volume_consolidation', 'nineturn_buy',
  'nineturn_sell', 'kdj_overbought', 'kdj_oversold', 'crash_warning',
]
const UNSUPPORTED_PRESETS = ['oversold_rebound', 'macd_golden_cross', 'macd_death_cross', 'distribution']

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

  // 描述：不再承诺 CSV 直链；写清 8 个可用预设，另 4 个会返回 PRESET_NOT_SUPPORTED
  assert.ok(!signals.description.includes('直链'), '结果直接返回，不再是 CSV 直链')
  // 不能作为预设的 4 个策略要给出路：全表仍可经 hhxg_query_dataset 拿到下载地址
  assert.match(signals.description, /hhxg_query_dataset\(dataset_id="quant_signal_pool"\)/)
  for (const id of [...USABLE_PRESETS, ...UNSUPPORTED_PRESETS]) assert.ok(signals.description.includes(id), id)
  assert.match(signals.description, /8 个/)
  assert.match(signals.description, /PRESET_NOT_SUPPORTED/)
  const [usablePart, unsupportedPart] = signals.description.split('PRESET_NOT_SUPPORTED')[0].split('另 4 个')
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
    // 空 preset 发给 screen_stocks 等于「没传」，会拿到未经筛选的全市场前 N 行——必须在本地拦住
    for (const args of [{}, { strategy_id: '' }, { strategy_id: '   ' }, { strategy_id: null }, undefined]) {
      const out = await runVipTool(signals, TOKEN, args)
      assert.match(out, /strategy_id/)
      for (const id of USABLE_PRESETS) assert.ok(out.includes(id), id)
    }
    for (const args of [{}, { stock_code: '' }, { stock_code: '  ', days: 7 }, undefined]) {
      const out = await runVipTool(alerts, TOKEN, args)
      assert.match(out, /stock_code/)
      assert.match(out, /600519/)
    }
    assert.equal(sent.length, 0, '本地就能判定的缺参不得消耗一次请求')
  })
})

test('业务性错误码渲染成可读文本返回（按类别加前缀）；鉴权 / 限流 / 故障类仍按异常抛出', async () => {
  const business = {
    无结果: ['NO_DATA', 'NOT_FOUND', 'UNSUPPORTED_ASSET', 'UNSUPPORTED_FORMAT'],
    参数有误: ['INVALID_ARGUMENT', 'INVALID_ARG', 'INVALID_ARGS', 'UNKNOWN_FIELD', 'UNSUPPORTED_FILTER'],
    暂不支持: ['PRESET_NOT_SUPPORTED', 'DATASET_TOO_LARGE', 'USE_SCREEN_STOCKS'],
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
    'PRESET_UNAVAILABLE', 'VIP_REQUIRED', 'TIER_INSUFFICIENT', 'RATE_LIMIT_EXCEEDED', 'TIMEOUT', 'TOOL_RUNTIME_ERROR',
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
    dataset_count: 6,
    datasets: [
      { id: 'small_json', category: '情绪', title: '小 JSON', format: 'json', size_bytes: 2000, urls: at('a.json') },
      { id: 'small_csv', category: '游资', title: '小 CSV', format: 'csv', size_bytes: 300 * 1024, urls: at('a.csv') },
      { id: 'big_csv', category: '选股', title: '大 CSV', format: 'csv', size_bytes: 300 * 1024 + 1, urls: at('b.csv') },
      { id: 'big_json', category: '公告', title: '大 JSON', format: 'json', size_bytes: 1268200, urls: at('b.json') },
      { id: 'monthly_csv', category: '两融', title: '按月 CSV', format: 'csv', urls: { history_pattern: 'https://hhxg.top/m/YYYYMM.csv' } },
      { id: 'xml_feed', category: '其他', title: 'XML', format: 'xml', size_bytes: 100, urls: at('f.xml') },
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
  assert.ok(!out.includes('仅 JSON'), '「仅 JSON 可 query」已过期')
  assert.match(out, /6\/6 个/)
})

test('未配置 token 的占位文案含开通与配置指引', () => {
  const msg = vipLockedMessage('hhxg_diagnose_stock')
  assert.match(msg, /vip\.html/)
  assert.match(msg, /account\/mcp\.html/)
  assert.match(msg, /mcpToken/)
  assert.match(msg, /hhxg_datasets/)
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
