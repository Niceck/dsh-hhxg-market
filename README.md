# dsh-hhxg-market

[恢恢量化 hhxg.top](https://hhxg.top) A股量化数据插件 for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh)。

把 A股日报快照、财经快讯、融资融券、市场情绪、题材热度等量化数据变成 dsh Agent 的原生工具——问一句"今天市场情绪怎么样"，模型自己调工具拿真实数据回答。

- **7 个免费工具**：零配置、无需注册，安装即用
- **6 个 VIP 工具**：个股综合诊断、条件选股与量化策略预设（可筛字段约 200 个、返回全市场命中数）、连板晋级预测、盘中实时行情与指标（Max 专属）等，填入 [MCP Token](https://hhxg.top/account/mcp.html) 解锁

## 安装

从 npm 安装（推荐，2026-11-01 起发布为 [`@hhxg/dsh-hhxg-market`](https://www.npmjs.com/package/@hhxg/dsh-hhxg-market)）：

```bash
dsh plugin --profile web add @hhxg/dsh-hhxg-market
```

或直接从 GitHub 安装（备选，解析到仓库最新提交）：

```bash
dsh plugin --profile web add github:Niceck/dsh-hhxg-market
```

> **⚠️ 仍在用 0.2.x 的请升级**：0.2.x 的 `hhxg_strategy_signals` / `hhxg_stock_alerts` 调用的服务端旧工具名已于 2026-10-27 下线（原定 2026-11-30，提前），这两个工具现在会报「工具已下线」（其余工具不受影响）。重新执行上面的 GitHub 安装命令即可升级到最新版（`dsh plugin` 把参数转给 pnpm，`add` 会重新解析到仓库最新提交）。

## 工具一览

### 免费（无需配置）

| 工具 | 说明 |
|---|---|
| `hhxg_snapshot` | A股日报快照：情绪指数 / 涨停炸板 / 连板天梯 / 热门题材 / 行业资金 / 游资龙虎榜 / 焦点新闻 |
| `hhxg_news` | 最新财经快讯（每小时滚动，含多空情绪标签），`limit` 1-50 |
| `hhxg_margin` | 近 7 交易日融资融券余额走势 + 融资增减 TOP 个股 |
| `hhxg_calendar` | A股日历：交易日 / 交割日 / 财报披露 / 限售解禁 |
| `hhxg_sentiment` | 近 7 交易日市场情绪：涨停家数 / 最高连板 / 连板分布 / 热门行业与概念 |
| `hhxg_themes` | 当日题材概念热度榜 TOP 30（游资参与 / 涨停数 / 涨停占比） |
| `hhxg_datasets` | 全部数据集目录（id / 分类 / 格式 / 更新频率 / 能否用 `hhxg_query_dataset` 查询；会员专属的全市场宽表标「筛选」，不提供下载），`hhxg_query_dataset` 的 id 发现入口 |

数据每个交易日盘后约 20:00 更新（快讯每小时）；非交易日返回最近一个交易日。

### VIP（需 MCP Token）

| 工具 | 说明 |
|---|---|
| `hhxg_diagnose_stock` | 个股综合诊断：日/周/月技术指标、异动评级、两融趋势、龙虎榜、涨停、大宗、公告、概念 |
| `hhxg_strategy_signals` | A 股条件选股 / 指标筛选 / 全市场命中计数（最新盘后快照，约 200 个可筛字段）：`list_fields=true` 列出全部可筛字段与类型；`filters=[{field, op, value}]`（最多 8 条，op gt/gte/lt/lte/eq/ne/in/contains/not_null）自定义筛选，如日线均线多头排列 `{field:"日均线多头", op:"eq", value:1}`；结果首行给全市场命中数 `total`（`limit` 1-100 只控制每页行数，只问数量设 `limit=1`），`sort` / `fields` / `cursor` 翻页；`strategy_id` 可选用 9 个策略预设（涨停 / 放量突破 / 缩量整理 / 九转买入 / 九转卖出 / KDJ 超买 / KDJ 超卖 / 暴跌预警 / MACD 金叉），与 `filters` 取交集 |
| `hhxg_predict_lianban` | 连板股次日晋级率预测（题材热度 / 行业热度 / 板高强度 3 因子） |
| `hhxg_stock_alerts` | 个股近 30 日异动历史（普通 / 临近严重 / 严重异动逐日记录） |
| `hhxg_query_dataset` | 对数据集（JSON 与 300KB 以内的 CSV）做过滤 / 排序 / 截断查询（先用免费的 `hhxg_datasets` 查合法 id 与是否可查） |
| `hhxg_realtime` | **Max 专属**盘中实时（交易日约 1 分钟一帧，盘后为当日收盘帧）：`view=market` 涨跌家数 / 涨跌停与炸板 / 涨停池与连板晋级率；`view=quotes` 指定个股（最多 30 只）的最新价与日 / 周 / 月指标；`view=screen` 全市场条件筛选（最多 8 条、返回 50 行）；`view=fields` 可用字段与示例；`view=kline` 指定个股（最多 5 只）的日 K 序列（已完成交易日 ≤260 根，`codes × bars ≤ 1000`，`adj` 前复权 / 不复权）+ 实时帧那天未走完的 K（`live`；`comparable` 只有 `true` 才可与历史拼接，`false` 疑似除权 / 基准不一致，`null` 无法判断——缓存滞后、个股停牌或日历不可用，原因见 `live.reason`，缓存状态见 `history`）。结果文本首行标出帧的时效与交易日，并带 `frame.status`（盘中 / 午休 / 收盘 / 非今日 / 延迟）；不是 `live` 就不是此刻的数据。分钟 K 不提供（快照差分还原不了区间高低） |

**解锁步骤**：

1. 到 [hhxg.top/vip.html](https://hhxg.top/vip.html) 开通 Max 会员（月付 ¥99 / 年付 ¥999）。2026-10-27 起 MCP Token 只签给 Max；此前开通的 Pro 在原到期日前仍可用除 `hhxg_realtime` 以外的 VIP 工具（调用 `hhxg_realtime` 会返回「需要 Max」的说明）
2. 到 [hhxg.top/account/mcp.html](https://hhxg.top/account/mcp.html) 生成 MCP Token（有效期跟随会员到期）
3. 把 Token 写进你 profile 的 `cordis.patch.yml`（dsh 目前不渲染第三方插件的配置项，没有设置界面可填；保存后重启 dsh 生效）：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- update:
    - id: hhxg-market
      config:
        mcpToken: "<你的 MCP Token>"
```

从终端启动 dsh 的话也可以不改文件：配置留空，设环境变量 `HHXG_MCP_TOKEN=<你的 MCP Token>`（显式配置非空时以配置为准；GUI 启动的 dsh 不一定继承 shell 环境）。

未填 Token 时 VIP 工具仍会注册为引导占位（调用返回开通指引），不影响免费工具。设 `enableVipTools: false` 可整体关闭 VIP 工具注册（此时环境变量也不会解锁）。

`hhxg_strategy_signals` 的 12 个策略标识里有 3 个（`oversold_rebound` / `macd_death_cross` / `distribution`）需要列间比较或分位数，暂不能作为预设，调用会返回说明（`PRESET_NOT_SUPPORTED`）。全市场指标全表（`quant_signal_pool`）自 2026-10-23 起为会员数据、不再提供下载地址；自定义条件直接用本工具的 `filters`（0.5.0 起），列间比较已算好的派生列（日 / 周 / 月均线多头、MACD 多头、KDJ 多头、MACD 金叉、站上 / 低于放量高低点、波段位置%）按常量筛即可。盘中实时帧（`hhxg_realtime view=screen`）目前没有这些派生列，「此刻盘中有多少只多头排列」暂不支持，请按最近盘后快照回答并注明数据日期。

**版本对应**：0.3.0 起 VIP 工具只调用 hhxg MCP server 的正式工具（`diagnose_stock` / `screen_stocks` / `predict_lianban_promotion` / `query_dataset`，0.4.0 起加 `get_realtime`）。0.2.x 调用的 `get_strategy_signals` / `get_stock_alerts_history` 在服务端 0.3.0 起只是别名，已于 2026-10-27 下线（服务端 0.5.0），0.2.x 的这两个工具已失效，请升级。

### 零代码替代方案（VIP 用户）

dsh 原生支持 MCP。不装本插件、或想要全部 8 个 MCP 工具 + resources + prompts，可直接把 hhxg MCP server 挂进 dsh 的 MCP 配置：

```
URL:    https://hhxg.top/mcp/rpc
Header: Authorization: Bearer <你的 MCP Token>
```

本插件的价值是：免费工具无 Token 也能用、工具输出针对模型阅读做了格式化、业务性答复（无数据 / 需要 Max / 参数有误）不会被当成工具故障。

## 设计约定

- **只读（research-only）**：本插件只提供行情与研究数据，不下单、不划转资金，也不存在任何交易执行接口。
- **凭证最小暴露**：Token 仅用于请求的 `Authorization` 头，不写盘、不打日志（日志只记「来自配置 / 环境变量 / 未配置」）；错误信息经脱敏处理，不回显 Token。Token 本体只存在于你本机的 profile 配置或你自己设置的环境变量里（环境变量对同进程插件与继承环境的子进程可见，不是保险库）。
- **上游文本消毒**：新闻标题、题材名等第三方文本进入模型上下文前统一清洗（删不可见字符、压平控制字符、断开链接/图片语法），降低数据侧 prompt injection 风险。
- **免责声明**：所有数据仅供研究参考，不构成投资建议。数据可能存在延迟或缺失，据此操作风险自负。

## 开发

```bash
npm ci                                           # 按 lockfile 安装开发/peer 依赖
npm test                                         # 全部测试（免费工具会真实请求 hhxg.top）
HHXG_SKIP_NETWORK=1 npm test                     # 只跑纯逻辑与契约测试
```

纯 JavaScript（ESM），无构建步骤；`lib/` 即源码。

## License

MIT
