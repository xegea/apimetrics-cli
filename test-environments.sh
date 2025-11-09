#!/bin/bash

echo "🧪 Testing ApiMetrics CLI Environment Configuration"
echo "=================================================="
echo

echo "1️⃣  Testing default (local) environment:"
node dist/index.js run --help | grep "default:"
echo

echo "2️⃣  Testing --env dev flag:"
echo "Expected: https://apimetrics.onrender.com"
node dist/index.js run example-test.json --key test123 --env dev 2>&1 | head -2
echo

echo "3️⃣  Testing --env prod flag:"
echo "Expected: https://apimetrics.onrender.com"
node dist/index.js run example-test.json --key test123 --env prod 2>&1 | head -2
echo

echo "4️⃣  Testing NODE_ENV=dev environment variable:"
echo "Expected: https://apimetrics.onrender.com"
NODE_ENV=dev node dist/index.js run example-test.json --key test123 2>&1 | head -2
echo

echo "5️⃣  Testing custom --api-url override:"
echo "Expected: https://custom-api.example.com"
node dist/index.js run example-test.json --key test123 --api-url https://custom-api.example.com 2>&1 | head -2
echo

echo "6️⃣  Testing --env flag override with custom API URL (should use custom):"
echo "Expected: https://custom-api.example.com"
node dist/index.js run example-test.json --key test123 --env dev --api-url https://custom-api.example.com 2>&1 | head -2
echo

echo "✅ Environment configuration testing complete!"