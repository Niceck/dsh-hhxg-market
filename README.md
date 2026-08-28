# dsh-hhxg-market

[恢恢量化 hhxg.top](https://hhxg.top) A股量化数据插件 for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/dsh)。

把 A股日报快照、财经快讯、融资融券、市场情绪、题材热度等量化数据变成 dsh Agent 的原生工具——问一句"今天市场情绪怎么样"，模型自己调工具拿真实数据回答。

- **7 个免费工具**：零配置、无需注册，安装即用
- **5 个 VIP 工具**：个股综合诊断、量化策略信号、连板晋级预测等，填入 [MCP Token](https://hhxg.top/account/mcp.html) 解锁

## 安装

```bash
dsh plugin --profile web add github:Niceck/dsh-hhxg-market
```

或从 npm（发布后）：

```bash
dsh plugin --profile web add @hhxg/dsh-hhxg-market
```

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
| `hhxg_datasets` | 全部 46 个开放数据集目录（id / 分类 / 格式 / 更新频率），`hhxg_query_dataset` 的 id 发现入口 |

数据每个交易日盘后约 20:00 更新（快讯每小时）；非交易日返回最近一个交易日。

### VIP（需 MCP Token）

| 工具 | 说明 |
|---|---|
| `hhxg_diagnose_stock` | 个股综合诊断：日/周/月技术指标、异动评级、两融趋势、龙虎榜、涨停、大宗、公告、概念 |
| `hhxg_strategy_signals` | 量化选股/风险预警全市场信号（约 5500 股 × 107 指标，12 类策略） |
| `hhxg_predict_lianban` | 连板股次日晋级率预测（题材热度 / 行业热度 / 板高强度 3 因子） |
| `hhxg_stock_alerts` | 个股近 30 日异动历史（普通 / 临近严重 / 严重异动逐日记录） |
| `hhxg_query_dataset` | 对 JSON 类数据集做过滤 / 排序 / 截断查询（先用免费的 `hhxg_datasets` 查合法 id） |

**解锁步骤**：

1. 到 [hhxg.top/vip.html](https://hhxg.top/vip.html) 开通 VIP（月度 ¥20 / 年度 ¥200）
2. 到 [hhxg.top/account/mcp.html](https://hhxg.top/account/mcp.html) 生成 MCP Token（30 天有效）
3. 把 Token 填入插件配置的 `mcpToken` 字段：

```yaml
# 你 profile 的 cordis.patch.yml
- update:
    - id: hhxg-market
      config:
        mcpToken: "<你的 MCP Token>"
```

未填 Token 时 VIP 工具仍会注册为引导占位（调用返回开通指引），不影响免费工具。设 `enableVipTools: false` 可整体关闭 VIP 工具注册。

### 零代码替代方案（VIP 用户）

dsh 原生支持 MCP。不装本插件、或想要全部 11 个 MCP 工具 + resources + prompts，可直接把 hhxg MCP server 挂进 dsh 的 MCP 配置：

```
URL:    https://hhxg.top/mcp/rpc
Header: Authorization: Bearer <你的 MCP Token>
```

本插件的价值是：免费工具无 Token 也能用、工具输出针对模型阅读做了格式化、以及和 dsh 配置界面集成。

## 设计约定

- **只读（research-only）**：本插件只提供行情与研究数据，不下单、不划转资金，也不存在任何交易执行接口。
- **凭证最小暴露**：Token 仅用于请求的 `Authorization` 头，不写盘、不打日志；错误信息经脱敏处理，不回显 Token。Token 本体只存在于你本机的 profile 配置。
- **上游文本消毒**：新闻标题、题材名等第三方文本进入模型上下文前统一清洗（删不可见字符、压平控制字符、断开链接/图片语法），降低数据侧 prompt injection 风险。
- **免责声明**：所有数据仅供研究参考，不构成投资建议。数据可能存在延迟或缺失，据此操作风险自负。

## 开发

```bash
node --test 'test/*.test.js'          # 全部测试（免费工具会真实请求 hhxg.top）
HHXG_SKIP_NETWORK=1 node --test 'test/*.test.js'   # 只跑纯逻辑测试
```

纯 JavaScript（ESM），无构建步骤；`lib/` 即源码。

## License

MIT
