/**
 * dsh-hhxg-market — 插件入口（host 半；浏览器半见 lib/client.js，只接管 hhxg_realtime 的结果卡）。
 *
 * 恢恢量化 (hhxg.top) A股量化数据 for DeepSeek Harness：13 个工具——
 * 日报快照 / 财经快讯 / 融资融券 / 投资者事件日历 / 市场情绪 / 题材热度 / 数据集目录 /
 * 个股诊断 / 条件选股与策略预设 / 连板晋级预测 / 异动历史 / 数据集查询 / 盘中实时，
 * 全部经 JSON-RPC 桥接 hhxg MCP server（resources/read 或 tools/call），
 * 都需要 Max 会员的 MCP Token；config.mcpToken 与环境变量 HHXG_MCP_TOKEN 都没有时，
 * 工具仍注册，调用返回开通指引。
 *
 * 全部工具只读（research-only）：本插件不下单、不划转资金、不模拟后转发。
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveMcpToken } from './api.js'
import { realtimePresentation, renderRealtimeText } from './present.js'
import { renderScreenText } from './screen_text.js'
import { TOOLS, runTool } from './tools.js'

export const name = 'hhxg-market'
export const inject = ['tools']

export const Config = z.object({
  mcpToken: z
    .string()
    .role('secret')
    .default('')
    .description('Max 会员的 AI 接入 Token（即 MCP Token，在 https://hhxg.top/developer.html#mcp 生成）。留空时读环境变量 HHXG_MCP_TOKEN；都没有则所有工具不可用（调用返回开通指引）。'),
})

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

/**
 * 按工具名挑文本渲染（render）与桌面端卡片投影（present，可选；客户端半 lib/client.js 只认 hhxg.realtime）。
 * 两者都从 execute 返回的同一份原文解析（execute 本身不改写原文）：
 * hhxg_realtime 的文本在首行标出帧日期与时效、presentationMeta 从原 JSON 投影；
 * hhxg_strategy_signals 只有文本渲染（字段目录分组、结果首行给全市场命中数），没有卡片。
 */
const PRESENTATIONS = {
  hhxg_realtime: { present: realtimePresentation, render: renderRealtimeText },
  hhxg_strategy_signals: { render: renderScreenText },
}

function outputFor(name) {
  const entry = PRESENTATIONS[name]
  if (!entry) return TEXT_OUTPUT
  return {
    ...TEXT_OUTPUT,
    render: (args, value) => [{ type: 'text', text: entry.render(args, String(value ?? '')) }],
    ...(entry.present ? { presentationMeta: (args, value) => entry.present(args, String(value ?? '')) } : {}),
  }
}

export function apply(ctx, config) {
  const { token, source } = resolveMcpToken(config)

  for (const spec of TOOLS) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: outputFor(spec.name),
      async execute(args, exec) {
        return runTool(spec, token, args, exec?.signal)
      },
    }))
  }

  // 只记来源，绝不记值
  const sourceText = { config: '配置', env: '环境变量 HHXG_MCP_TOKEN', none: '未配置，调用返回开通指引' }[source]
  ctx.logger?.info?.(`[hhxg-market] 已注册 ${TOOLS.length} 个工具（token 来源：${sourceText}）`)
}
