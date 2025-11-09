#!/usr/bin/env node

// Simple mock API server for testing
import http from 'http';

const server = http.createServer((req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/results') {
    let data = '';
    
    req.on('data', chunk => {
      data += chunk;
    });

    req.on('end', () => {
      try {
        const body = JSON.parse(data);
        console.log('📨 Received test results:');
        console.log(`  - Test ID: ${body.testId}`);
        console.log(`  - Requests: ${body.metrics?.requests || 'N/A'}`);
        console.log(`  - Latency: ${body.metrics?.latencies?.mean}ms (mean)`);
        console.log(`  - Success: ${(body.metrics?.success * 100 || 0).toFixed(2)}%`);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: body.testId,
          message: 'Test result saved successfully',
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(3000, '0.0.0.0', () => {
  console.log('🚀 Mock API server listening on http://localhost:3000');
  console.log('Available endpoints:');
  console.log('  - GET /health');
  console.log('  - POST /results');
});