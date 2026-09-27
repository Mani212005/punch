#!/bin/bash
echo "# Bench Results" > bench-results.md

echo "Running all 6 public-repository benchmarks in parallel..."

pnpm punch bench https://github.com/expressjs/express --runs 1 > bench-express.txt 2>&1 &
PID1=$!
pnpm punch bench https://github.com/fastify/fastify --runs 1 > bench-fastify.txt 2>&1 &
PID2=$!
pnpm punch bench https://github.com/vercel/next.js --runs 1 > bench-nextjs.txt 2>&1 &
PID3=$!
pnpm punch bench https://github.com/expressjs/express --runs 1 --chaos timeout:impact > bench-express-chaos.txt 2>&1 &
PID4=$!
pnpm punch bench https://github.com/fastify/fastify --runs 1 --chaos kill-after:reachability:1 > bench-fastify-chaos.txt 2>&1 &
PID5=$!
pnpm punch bench https://github.com/vercel/next.js --runs 1 --chaos rate-limit:ag-cli > bench-nextjs-chaos.txt 2>&1 &
PID6=$!

wait $PID1 $PID2 $PID3 $PID4 $PID5 $PID6

echo "## expressjs/express (clean)" >> bench-results.md
cat bench-express.txt >> bench-results.md
echo "## fastify/fastify (clean)" >> bench-results.md
cat bench-fastify.txt >> bench-results.md
echo "## vercel/next.js (clean)" >> bench-results.md
cat bench-nextjs.txt >> bench-results.md
echo "## expressjs/express (chaos timeout)" >> bench-results.md
cat bench-express-chaos.txt >> bench-results.md
echo "## fastify/fastify (chaos kill)" >> bench-results.md
cat bench-fastify-chaos.txt >> bench-results.md
echo "## vercel/next.js (chaos rate-limit)" >> bench-results.md
cat bench-nextjs-chaos.txt >> bench-results.md

echo "Done"
