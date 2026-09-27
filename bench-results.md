# Bench Results

The clean fixture bench now resolves paths from the invoking shell directory and
completes at 100% (1/1, zero takeovers, 49ms, $0.0841) after rebuilding core
and engine. The six public-repository runs below were executed once each with
the local live-agent configuration; all stopped before a task result (0%
completion, $0 measured). Trace inspection attributed these failures to the
local provider quota/model configuration, so these are diagnostic runs rather
than successful repository-quality measurements.

## expressjs/express (clean)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench https://github.com/expressjs/express --runs 1

# Punch bench - https://github.com/expressjs/express

- Runs: 1
- Chaos: none
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 11243ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 18712ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 18712ms | $0.0000    | 4     | 1         | 0ms            |

## fastify/fastify (clean)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench https://github.com/fastify/fastify --runs 1

# Punch bench - https://github.com/fastify/fastify

- Runs: 1
- Chaos: none
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 12746ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 20133ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 20133ms | $0.0000    | 4     | 1         | 0ms            |

## vercel/next.js (clean)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench https://github.com/vercel/next.js --runs 1

# Punch bench - https://github.com/vercel/next.js

- Runs: 1
- Chaos: none
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 12863ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 20123ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 20123ms | $0.0000    | 4     | 1         | 0ms            |

## expressjs/express (chaos timeout)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench https://github.com/expressjs/express --runs 1 --chaos timeout:impact

# Punch bench - https://github.com/expressjs/express

- Runs: 1
- Chaos: timeout:impact
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 12842ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 20044ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 20044ms | $0.0000    | 4     | 1         | 0ms            |

## fastify/fastify (chaos kill)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench https://github.com/fastify/fastify --runs 1 --chaos kill-after:reachability:1

# Punch bench - https://github.com/fastify/fastify

- Runs: 1
- Chaos: kill-after:reachability:1
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 12617ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 19707ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 19707ms | $0.0000    | 4     | 1         | 0ms            |

## vercel/next.js (chaos rate-limit)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench https://github.com/vercel/next.js --runs 1 --chaos rate-limit:ag-cli

# Punch bench - https://github.com/vercel/next.js

- Runs: 1
- Chaos: rate-limit:ag-cli
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 12558ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 19710ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 19710ms | $0.0000    | 4     | 1         | 0ms            |
