# Bench Results

## express-app (clean)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench fixtures/repos/express-app --runs 1

# Punch bench - fixtures/repos/express-app

- Runs: 1
- Chaos: none
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 12050ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 18377ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 18377ms | $0.0000    | 4     | 1         | 0ms            |

## fastify-app (clean)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench fixtures/repos/fastify-app --runs 1

# Punch bench - fixtures/repos/fastify-app

- Runs: 1
- Chaos: none
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 10674ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 18790ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 18790ms | $0.0000    | 4     | 1         | 0ms            |

## nextjs-app (clean)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench fixtures/repos/nextjs-app --runs 1

# Punch bench - fixtures/repos/nextjs-app

- Runs: 1
- Chaos: none
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 9828ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 16472ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 16472ms | $0.0000    | 4     | 1         | 0ms            |

## express-app (chaos timeout)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench fixtures/repos/express-app --runs 1 --chaos timeout:impact

# Punch bench - fixtures/repos/express-app

- Runs: 1
- Chaos: timeout:impact
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 10444ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 18197ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 18197ms | $0.0000    | 4     | 1         | 0ms            |

## fastify-app (chaos kill)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench fixtures/repos/fastify-app --runs 1 --chaos kill-after:reachability:1

# Punch bench - fixtures/repos/fastify-app

- Runs: 1
- Chaos: kill-after:reachability:1
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 10637ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 17386ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 17386ms | $0.0000    | 4     | 1         | 0ms            |

## nextjs-app (chaos rate-limit)

> punch@ punch /Users/manijoshi/.treehouse/punch-314546/1/punch
> pnpm --filter @punch/engine exec node bin/punch.js bench fixtures/repos/nextjs-app --runs 1 --chaos rate-limit:ag-cli

# Punch bench - fixtures/repos/nextjs-app

- Runs: 1
- Chaos: rate-limit:ag-cli
- Task completion rate: 0.0% (0/1)
- Takeovers: 1 total, 1.00 mean per run
- Mean detection-to-takeover time: 0ms
- Mean takeover time: 10288ms
- Mean cost per run: $0.0000 (measured)
- Mean latency per run: 18018ms (measured)

| Run | Status | Latency | Cost (USD) | Steps | Takeovers | Mean detection |
| --- | ------ | ------- | ---------- | ----- | --------- | -------------- |
| 1   | failed | 18018ms | $0.0000    | 4     | 1         | 0ms            |
