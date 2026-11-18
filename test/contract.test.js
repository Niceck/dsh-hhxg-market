/**
 * 契约测试：所有工具 spec 必须能通过真实 defineTool 编译；插件 apply() 统一注册 14 个工具。
 *
 * 背景（2026-08-28 审查 CRITICAL）：defineTool 对 schema 是硬校验，
 * 任一 spec 非法会在 apply() 内同步 throw，cordis 随即回滚整个插件的
 * 全部注册——一个字段笔误 = 用户装上后 0 个工具。此测试是唯一防线。
 *
 * 依赖 dsh SDK（npm ci 装的 peer，或本机 ~/.dsh/profiles/node_modules）；未安装时跳过
 * （CI 无 SDK 环境下由 npm 安装的 devDependencies 补位，或显式跳过）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { TOOLS, tokenRequiredMessage } from '../lib/tools.js'
import { VALID_ARGS } from './tools.test.js'

async function loadSdk() {
  try {
    // 优先常规解析（npm 安装了 peer/dev 依赖时）
    return await import('@deepseek-ai/dsh-tools')
  } catch {
    // 回落到本机 dsh profile 的 SDK
    try {
      const req = createRequire(import.meta.url)
      const resolved = req.resolve('@deepseek-ai/dsh-tools', {
        paths: [path.join(os.homedir(), '.dsh/profiles/node_modules')],
      })
      return await import(pathToFileURL(resolved).href)
    } catch {
      return null
    }
  }
}

/** 插件入口按裸包名 import peer（schemastery / dsh-tools）：只有 npm 装了依赖才能加载。 */
async function loadPlugin() {
  try {
    return await import('../lib/index.js')
  } catch {
    return null
  }
}

const sdk = await loadSdk()
const defineTool = sdk?.defineTool ?? null
const plugin = await loadPlugin()
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

// CI 里 npm ci 会按 lockfile 装上 peer 的真实 SDK：那里缺 SDK 不是「可跳过」而是环境坏了（Codex 评审）
const SKIP = !defineTool && (process.env.CI ? false : '本机无 dsh SDK')
const SKIP_PLUGIN = !plugin && (process.env.CI ? false : '本机未 npm ci（lib/index.js 的 peer 依赖不可解析）')

test('CI 必须装到真实 dsh SDK（契约测试不得在 CI 静默跳过）', { skip: !process.env.CI && '仅 CI' }, () => {
  assert.ok(defineTool, 'CI 环境没有 @deepseek-ai/dsh-tools：检查 npm ci / lockfile 的 peer 依赖')
  assert.ok(plugin, 'CI 环境加载不了 lib/index.js：检查 npm ci / lockfile 的 peer 依赖')
})

test('全部 14 个工具 spec 通过真实 defineTool 编译', { skip: SKIP }, () => {
  assert.equal(TOOLS.length, 14)
  for (const spec of TOOLS) {
    assert.doesNotThrow(
      () => defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: TEXT_OUTPUT,
        async execute() { return '' },
      }),
      `defineTool(${spec.name}) 必须不抛错——否则整个插件在装载时被回滚`,
    )
  }
})

test('hhxg_query_dataset 的新参数按真实 SDK 校验：历史库常用组合（date_range 一端 null、fields 数组、cursor 含竖线）放行，类型不对拒绝', { skip: SKIP || (typeof sdk?.validateArgs !== 'function' && '本机 SDK 不导出 validateArgs') }, () => {
  const { parameters } = TOOLS.find((t) => t.name === 'hhxg_query_dataset')
  const ok = [
    { dataset_id: 'hist_fin_indicator', key: '600519.SH,贵州茅台', fields: ['roe', '净利润同比'], date_range: ['2023-01-01', null] },
    { dataset_id: 'hist_fin_indicator', date: '2024-12-31', cursor: '20241231|600519.SH', sort: 'desc', limit: 500 },
    { dataset_id: 'hist_ths_daily', key: '半导体', date_range: [null, '2025-12-31'] },
    { dataset_id: 'kb_news', path: 'data.items', fields: ['title'] },
    { dataset_id: 'stock_alerts_history', key: '600519', days: 7 },
  ]
  for (const args of ok) assert.deepEqual(sdk.validateArgs(parameters, args), [], JSON.stringify(args))
  const bad = [
    { dataset_id: 'hist_x', date_range: [1, 2] },
    { dataset_id: 'hist_x', fields: 'roe' },
    { dataset_id: 'hist_x', key: ['600519'] },
    { dataset_id: 'hist_x', days: 1.5 },
    { dataset_id: 'hist_x', cursor: 20 },
  ]
  for (const args of bad) assert.ok(sdk.validateArgs(parameters, args).length > 0, JSON.stringify(args))
})

test('hhxg_history_download 的参数按真实 SDK 校验：不带参数、只带 table、table + period 放行，类型不对拒绝', { skip: SKIP || (typeof sdk?.validateArgs !== 'function' && '本机 SDK 不导出 validateArgs') }, () => {
  const { parameters } = TOOLS.find((t) => t.name === 'hhxg_history_download')
  for (const args of [{}, { table: 'hist_fin_indicator' }, { table: 'hist_fin_indicator', period: '2024' }, { table: 'hist_margin_detail', period: 'fields' }]) {
    assert.deepEqual(sdk.validateArgs(parameters, args), [], JSON.stringify(args))
  }
  for (const args of [{ table: 1 }, { table: ['hist_x'] }, { table: 'hist_x', period: { y: 2024 } }]) {
    assert.ok(sdk.validateArgs(parameters, args).length > 0, JSON.stringify(args))
  }
})

test('带 presentationMeta 的 output（hhxg_realtime 桌面卡投影）也通过 defineTool 编译', { skip: SKIP }, () => {
  const rt = TOOLS.find((t) => t.name === 'hhxg_realtime')
  assert.doesNotThrow(() => defineTool({
    name: rt.name,
    description: rt.description,
    parameters: rt.parameters,
    output: { ...TEXT_OUTPUT, presentationMeta: () => undefined },
    async execute() { return '' },
  }))
})

test('apply()：14 个工具统一注册；没 token 时每个工具的 execute 返回开通指引且不发请求；Config 只剩 mcpToken', { skip: SKIP_PLUGIN }, async () => {
  const registered = []
  const logs = []
  const ctx = {
    tools: { register(tool) { registered.push(tool) } },
    logger: { info(msg) { logs.push(msg) } },
  }
  const savedEnv = process.env.HHXG_MCP_TOKEN
  delete process.env.HHXG_MCP_TOKEN
  const origFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw new Error('must not fetch')
  }
  try {
    plugin.apply(ctx, { mcpToken: '' })
    assert.equal(registered.length, 14)
    assert.deepEqual(registered.map((t) => t.name).sort(), TOOLS.map((t) => t.name).sort())
    assert.match(logs.at(-1), /^\[hhxg-market\] 已注册 14 个工具（token 来源：未配置/)
    for (const tool of registered) {
      // defineTool 的 execute 先按 schema 校验参数：传各工具的合法参数，证明是 token 先拦住
      const out = await tool.execute(VALID_ARGS[tool.name] ?? {}, {})
      assert.equal(out, tokenRequiredMessage(tool.name), tool.name)
      assert.equal(typeof tool.output?.render, 'function', `${tool.name} 要有文本渲染`)
    }
    assert.equal(calls, 0, '没 token 不得发任何请求')
    // hhxg_realtime 带桌面卡投影，其余没有
    assert.equal(typeof registered.find((t) => t.name === 'hhxg_realtime').output.presentationMeta, 'function')
    assert.equal(registered.find((t) => t.name === 'hhxg_snapshot').output.presentationMeta, undefined)
    // hhxg_query_dataset：历史库结果经注册后的 output.render 变成纯文本表格，普通数据集结果原样
    const query = registered.find((t) => t.name === 'hhxg_query_dataset')
    const hist = JSON.stringify({ data: { table: 'hist_fin_indicator', fields: ['end_date'], columns: [], rows: [['20241231']], next_cursor: null }, meta: {} })
    assert.match(query.output.render({ dataset_id: 'hist_fin_indicator' }, hist)[0].text, /^历史库 hist_fin_indicator｜本页 1 行｜没有下一页\n/)
    const plain = JSON.stringify({ data: { rows: [{ a: 1 }] }, meta: {} })
    assert.deepEqual(query.output.render({ dataset_id: 'etf_latest' }, plain), [{ type: 'text', text: plain }])
    // 配置项只剩 mcpToken（enableVipTools 已删）
    const cfg = new plugin.Config({})
    assert.deepEqual(Object.keys(cfg), ['mcpToken'])
    assert.equal(cfg.mcpToken, '')
    // schema 只声明 mcpToken（enableVipTools 已删；schemastery 对未声明键只是透传，旧 profile 残留不影响装载）
    assert.deepEqual(Object.keys(plugin.Config.dict), ['mcpToken'])
    assert.doesNotThrow(() => new plugin.Config({ enableVipTools: false }))
    // 有 token 时日志只记来源，不记值
    plugin.apply({ tools: { register() {} }, logger: { info(msg) { logs.push(msg) } } }, { mcpToken: 'secret_token_value_123' })
    assert.match(logs.at(-1), /token 来源：配置）$/)
    assert.ok(!logs.join('\n').includes('secret_token_value_123'))
  } finally {
    globalThis.fetch = origFetch
    if (savedEnv !== undefined) process.env.HHXG_MCP_TOKEN = savedEnv
  }
})
