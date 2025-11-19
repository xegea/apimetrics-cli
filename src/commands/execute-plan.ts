import { execa } from "execa";
import axios from "axios";
import fs from "fs/promises";
import fsCB from "fs";
import path from "path";
import chalk from "chalk";
import os from "os";
import { writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import readline from "readline";

interface RequestMetric {
  timestamp: string;
  latency: number;
  statusCode: number;
  bytesIn: number;
  bytesOut: number;
  error?: string;
  url?: string;
}

interface RequestMetricSummary {
  requestIndex: number;
  method: string;
  target: string;
  totalRequests: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  successRate: number;
  bytesIn: number;
  bytesOut: number;
  statusCodes: Record<string, number>;
  errors: string[];
}

interface BucketState {
  bucketKey: number;
  startTime: Date;
  endTime: Date;
  metrics: RequestMetric[];
  totalRequests: number;
  successCount: number;
  failureCount: number;
  statusCodes: Record<string, number>;
  errorSet: Set<string>;
  bytesIn: number;
  bytesOut: number;
  latencies: number[];
}

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)([smh])$/);
  if (!match) return 30;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    default: return 30;
  }
}

function calculatePercentile(sortedLatencies: number[], percentile: number): number {
  if (sortedLatencies.length === 0) return 0;
  const index = Math.floor(sortedLatencies.length * percentile);
  return sortedLatencies[Math.max(0, index - 1)] || sortedLatencies[0];
}

interface ExecutionPlanFile {
  metadata: {
    name: string;
    planName: string;
    createdAt: string;
    description?: string;
    executionId?: string;
  };
  authentication: {
    token: string;
    tokenType: string;
    note?: string;
  };
  tests: Array<{
    id: string;
    name: string;
    requests?: Array<{
      method: string;
      target: string;
      description?: string;
      headers?: Record<string, string>;
      body?: string;
    }>;
    method?: string;
    target?: string;
    rps: number;
    duration: string;
    iterations?: number;
    delayBetweenRequests?: string;
    description?: string;
  }>;
  instructions?: {
    step1?: string;
    step2?: string;
    step3?: string;
  };
}

interface RunOptions {
  apiUrl?: string;
  env?: string;
}

interface LoadTestExecution {
  id: string;
  name: string;
  status: string;
  executionPlanId: string;
}

interface ExecutionPlan {
  id: string;
  name: string;
  executionTime?: string;
  delayBetweenRequests?: string;
  iterations?: number;
}

async function uploadMetricsBucket(
  executionId: string,
  bucketNumber: number,
  bucketState: BucketState,
  token: string,
  apiUrl: string
): Promise<boolean> {
  try {
    if (bucketState.metrics.length === 0) {
      return true;
    }

    const sortedLatencies = bucketState.latencies.sort((a, b) => a - b);
    const totalRequests = bucketState.metrics.length;
    const avgLatency = sortedLatencies.reduce((a, b) => a + b, 0) / totalRequests;
    const minLatency = Math.min(...sortedLatencies);
    const maxLatency = Math.max(...sortedLatencies);

    const bucketData = {
      bucketNumber,
      startTime: bucketState.startTime.toISOString(),
      endTime: bucketState.endTime.toISOString(),
      totalRequests,
      successCount: bucketState.successCount,
      failureCount: bucketState.failureCount,
      avgLatency: Math.round(avgLatency),
      minLatency: Math.round(minLatency),
      maxLatency: Math.round(maxLatency),
      p50Latency: Math.round(calculatePercentile(sortedLatencies, 0.5)),
      p95Latency: Math.round(calculatePercentile(sortedLatencies, 0.95)),
      p99Latency: Math.round(calculatePercentile(sortedLatencies, 0.99)),
      successRate: bucketState.successCount / totalRequests,
      bytesIn: bucketState.bytesIn,
      bytesOut: bucketState.bytesOut,
      statusCodes: bucketState.statusCodes,
      errors: Array.from(bucketState.errorSet),
    };

    console.log(chalk.cyan(`\n   📦 Uploading metrics bucket #${bucketNumber}...`));
    console.log(chalk.gray(`      Time Range: ${bucketState.startTime.toISOString()} → ${bucketState.endTime.toISOString()}`));
    console.log(chalk.gray(`      Requests: ${totalRequests} (${bucketState.successCount} success, ${bucketState.failureCount} failed)`));
    console.log(chalk.gray(`      Avg Latency: ${(bucketData.avgLatency / 1000000).toFixed(2)}ms`));

    const response = await axios.post(
      `${apiUrl}/loadtestsexecutions/${executionId}/buckets`,
      bucketData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    console.log(chalk.green(`      ✅ Bucket #${bucketNumber} uploaded (ID: ${response.data.id})`));
    return true;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(chalk.red(`      ❌ Bucket upload error:`), error.message);
    } else {
      console.error(chalk.red(`      ❌ Unexpected error:`, error instanceof Error ? error.message : String(error)));
    }
    return false;
  }
}

async function createTestResult(
  executionId: string,
  testId: string,
  results: any,
  token: string,
  apiUrl: string,
  requestMetrics?: RequestMetricSummary[]
): Promise<boolean> {
  try {
    console.log(chalk.cyan('\n📤 Uploading final TestResult...'));
    
    const payload = {
      ...results,
      requestMetrics: requestMetrics || []
    };

    if (requestMetrics && requestMetrics.length > 0) {
      console.log(chalk.gray(`  Including ${requestMetrics.length} per-request metrics`));
    }
    
    console.log(chalk.gray(`\n  📊 TestResult Summary:`));
    console.log(chalk.gray(`     - Execution ID: ${executionId}`));
    console.log(chalk.gray(`     - Total Requests: ${results.totalRequests}`));
    console.log(chalk.gray(`     - Success Rate: ${(results.successRate * 100).toFixed(2)}%`));
    console.log(chalk.gray(`     - Avg Latency: ${(results.avgLatency / 1000000).toFixed(2)}ms`));
    console.log(chalk.gray(`     - P95 Latency: ${(results.p95Latency / 1000000).toFixed(2)}ms`));

    console.log(chalk.gray(`\n  🔗 Posting TestResult to: ${apiUrl}/loadtestsexecutions/${executionId}/loadtests`));

    const response = await axios.post(
      `${apiUrl}/loadtestsexecutions/${executionId}/loadtests`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    console.log(chalk.green(`\n  ✅ TestResult uploaded successfully`));
    console.log(chalk.gray(`     Response Status: ${response.status} ${response.statusText}`));
    return true;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(chalk.red(`\n  ⚠️  TestResult upload error:`), error.message);
      if (error.response) {
        console.error(chalk.red(`     Response Status: ${error.response.status} ${error.response.statusText}`));
        console.error(chalk.red(`     Response Data:`, JSON.stringify(error.response.data, null, 2)));
      }
    } else {
      console.error(chalk.red(`\n  ⚠️  Unexpected error:`, error instanceof Error ? error.message : String(error)));
    }
    return false;
  }
}

async function runCombinedTests(
  tests: ExecutionPlanFile['tests'],
  token: string,
  apiUrl: string,
  planName: string,
  executionId: string
): Promise<boolean> {
  console.log(chalk.blue(`\n🔗 Combining ${tests.length} test(s) into single load test with REAL-TIME streaming metrics`));

  let attackInput = '';
  let totalRequestCount = 0;

  // Collect all requests
  for (const test of tests) {
    if (test.requests && test.requests.length > 0) {
      console.log(chalk.gray(`  • ${test.name}: ${test.requests.length} request(s)`));
      for (const request of test.requests) {
        attackInput += `${request.method.toUpperCase()} ${request.target}\n`;
        if (request.headers) {
          for (const [key, value] of Object.entries(request.headers)) {
            attackInput += `${key}: ${value}\n`;
          }
        }
        attackInput += '\n';
        if (request.body) {
          attackInput += `${request.body}\n`;
        }
        totalRequestCount++;
      }
    } else if (test.method && test.target) {
      console.log(chalk.gray(`  • ${test.name}: 1 request (legacy format)`));
      attackInput += `${test.method.toUpperCase()} ${test.target}\n\n`;
      totalRequestCount++;
    }
  }

  console.log(chalk.cyan(`\n  📋 Requests in cycle loop (will repeat in order):`));
  const requestLines = attackInput.trim().split('\n');
  requestLines.slice(0, 10).forEach((line, index) => {
    console.log(chalk.gray(`     ${index + 1}. ${line}`));
  });
  if (requestLines.length > 10) {
    console.log(chalk.gray(`     ... (${requestLines.length - 10} more lines)`));
  }

  const firstTest = tests[0];
  const rps = firstTest.rps;
  const duration = firstTest.duration;

  console.log(chalk.gray(`  Total requests to cycle through: ${totalRequestCount}`));
  console.log(chalk.gray(`  RPS: ${rps}, Duration: ${duration}`));
  console.log("");

  const tempDir = os.tmpdir();
  const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${process.pid}`;
  const tempFile = path.join(tempDir, `vegeta-requests-${uniqueId}.txt`);

  try {
    const fileContent = attackInput.trim() + '\n';
    writeFileSync(tempFile, fileContent, 'utf8');

    console.log(chalk.gray(`\n  📝 Vegeta input file: ${tempFile}`));
    console.log(chalk.gray(`  📊 File size: ${fileContent.length} bytes`));

    // REAL-TIME STREAMING MODE: vegeta attack | vegeta encode -to json
    console.log(chalk.cyan(`\n🚀 Starting real-time streaming metrics collection...`));
    console.log(chalk.cyan(`   Processing Vegeta output line-by-line as it arrives...`));
    
    const allMetrics: RequestMetric[] = [];
    const buckets: Map<number, BucketState> = new Map();
    const uploadedBuckets = new Set<number>(); // Track which buckets have been uploaded
    const bucketDuration = 5000; // 5 seconds
    let firstMetricTime: number | null = null;
    let totalRequests = 0;
    let successRequests = 0;
    const allStatusCodes: Record<string, number> = {};
    const allErrorSet = new Set<string>();
    let totalBytesIn = 0;
    let totalBytesOut = 0;
    const allLatencies: number[] = [];

    try {
      // Stream vegeta output: cat file | vegeta attack | vegeta encode -to json
      const cmd = `cat "${tempFile}" | vegeta attack -rate=${rps} -duration=${duration} -timeout=30s | vegeta encode -to json`;
      
      // Use stdout: 'pipe' to stream output in real-time
      const vegeta = execa('sh', ['-c', cmd], {
        timeout: 600000,
        stdout: 'pipe',
      });

      // Create readline interface to process JSON lines as they arrive
      const rl = readline.createInterface({
        input: vegeta.stdout as any,
        crlfDelay: Infinity,
      });

      // Process each JSON line in real-time
      for await (const line of rl) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);
          
          const timestamp = new Date(parsed.timestamp);
          const latency = parsed.latency;
          const statusCode = parsed.code;
          const bytesIn = parsed.in || 0;
          const bytesOut = parsed.out || 0;
          const error = parsed.error || undefined;
          const url = parsed.url;

          const metric: RequestMetric = {
            timestamp: timestamp.toISOString(),
            latency,
            statusCode,
            bytesIn,
            bytesOut,
            error,
            url,
          };

          allMetrics.push(metric);
          totalRequests++;
          
          if (statusCode >= 200 && statusCode < 300) {
            successRequests++;
          }

          allStatusCodes[statusCode] = (allStatusCodes[statusCode] || 0) + 1;
          if (error && error.trim()) {
            allErrorSet.add(error);
          }

          totalBytesIn += bytesIn;
          totalBytesOut += bytesOut;
          allLatencies.push(latency);

          // Initialize first metric time
          if (firstMetricTime === null) {
            firstMetricTime = timestamp.getTime();
            console.log(chalk.gray(`\n   Execution started at: ${timestamp.toISOString()}`));
          }

          // Assign to bucket based on 5-second windows from first metric
          const metricTime = timestamp.getTime();
          const bucketKey = Math.floor((metricTime - firstMetricTime) / bucketDuration);

          // Create bucket if it doesn't exist
          if (!buckets.has(bucketKey)) {
            const bucketStart = new Date(firstMetricTime + bucketKey * bucketDuration);
            const bucketEnd = new Date(bucketStart.getTime() + bucketDuration);
            
            buckets.set(bucketKey, {
              bucketKey,
              startTime: bucketStart,
              endTime: bucketEnd,
              metrics: [],
              totalRequests: 0,
              successCount: 0,
              failureCount: 0,
              statusCodes: {},
              errorSet: new Set<string>(),
              bytesIn: 0,
              bytesOut: 0,
              latencies: [],
            });
          }

          // Add metric to current bucket
          const bucket = buckets.get(bucketKey)!;
          bucket.metrics.push(metric);
          bucket.totalRequests++;
          bucket.latencies.push(latency);
          bucket.bytesIn += bytesIn;
          bucket.bytesOut += bytesOut;
          bucket.statusCodes[statusCode] = (bucket.statusCodes[statusCode] || 0) + 1;

          if (statusCode >= 200 && statusCode < 300) {
            bucket.successCount++;
          } else {
            bucket.failureCount++;
          }

          if (error && error.trim()) {
            bucket.errorSet.add(error);
          }

          // Check if we've moved to a new bucket - if so, upload the previous one IMMEDIATELY
          const prevBucketKey = bucketKey - 1;
          if (prevBucketKey >= 0 && !uploadedBuckets.has(prevBucketKey) && buckets.has(prevBucketKey)) {
            const prevBucket = buckets.get(prevBucketKey)!;
            if (prevBucket.metrics.length > 0) {
              // Upload the completed bucket IMMEDIATELY (happens during streaming)
              await uploadMetricsBucket(executionId, prevBucketKey, prevBucket, token, apiUrl);
              uploadedBuckets.add(prevBucketKey);
            }
          }

          // Progress indicator
          if (totalRequests % 50 === 0) {
            console.log(chalk.gray(`   ✓ Processed ${totalRequests} metrics in real-time...`));
          }
        } catch (parseError) {
          console.warn(chalk.yellow(`   ⚠️  Skipped unparseable line: ${line.substring(0, 50)}`));
        }
      }

      // After stream ends, upload any remaining buckets that weren't uploaded yet
      console.log(chalk.cyan(`\n📦 Uploading final metrics buckets...`));
      const sortedBuckets = Array.from(buckets.entries())
        .sort(([keyA], [keyB]) => keyA - keyB);

      // Only upload buckets with valid keys (>= 0) that weren't already uploaded
      for (const [bucketKey, bucketState] of sortedBuckets) {
        if (bucketKey >= 0 && !uploadedBuckets.has(bucketKey) && bucketState.metrics.length > 0) {
          await uploadMetricsBucket(executionId, bucketKey, bucketState, token, apiUrl);
          uploadedBuckets.add(bucketKey);
        }
      }

      // Calculate final aggregated summary
      const sortedLatencies = allLatencies.sort((a, b) => a - b);
      const successRate = totalRequests > 0 ? successRequests / totalRequests : 0;

      const results = {
        executionId,
        testId: tests[0].id || 'default-test',
        avgLatency: totalRequests > 0 ? Math.round(sortedLatencies.reduce((a, b) => a + b, 0) / totalRequests) : 0,
        minLatency: sortedLatencies.length > 0 ? Math.round(sortedLatencies[0]) : 0,
        maxLatency: sortedLatencies.length > 0 ? Math.round(sortedLatencies[sortedLatencies.length - 1]) : 0,
        p50Latency: Math.round(calculatePercentile(sortedLatencies, 0.5)),
        p95Latency: Math.round(calculatePercentile(sortedLatencies, 0.95)),
        p99Latency: Math.round(calculatePercentile(sortedLatencies, 0.99)),
        successRate,
        timestamp: new Date().toISOString(),
        totalRequests,
        testDuration: duration,
        bytesIn: totalBytesIn,
        bytesOut: totalBytesOut,
        statusCodes: JSON.stringify(allStatusCodes),
        errorDetails: JSON.stringify(Array.from(allErrorSet)),
      };

      console.log(chalk.cyan(`\n📊 Final Test Summary:`));
      console.log(chalk.gray(`   Total Requests: ${totalRequests}`));
      console.log(chalk.gray(`   Success Rate: ${(successRate * 100).toFixed(2)}%`));
      console.log(chalk.gray(`   Avg Latency: ${(results.avgLatency / 1000000).toFixed(2)}ms`));
      console.log(chalk.gray(`   P95 Latency: ${(results.p95Latency / 1000000).toFixed(2)}ms`));
      console.log(chalk.gray(`   P99 Latency: ${(results.p99Latency / 1000000).toFixed(2)}ms`));
      console.log(chalk.gray(`   Status Codes: ${JSON.stringify(allStatusCodes)}`));

      // Create per-request metric summaries (grouped by URL)
      const metricsByUrl: { [url: string]: RequestMetric[] } = {};
      allMetrics.forEach((metric) => {
        if (metric.url) {
          if (!metricsByUrl[metric.url]) {
            metricsByUrl[metric.url] = [];
          }
          metricsByUrl[metric.url].push(metric);
        }
      });

      const requestMetricSummaries: RequestMetricSummary[] = Object.entries(metricsByUrl).map(([url, metrics], idx) => {
        const latencies = metrics.map(m => m.latency).sort((a, b) => a - b);
        const totalReqs = metrics.length;
        const avgLat = latencies.reduce((a, b) => a + b, 0) / totalReqs;
        const successCnt = metrics.filter(m => m.statusCode >= 200 && m.statusCode < 300).length;
        const statusCodeMap: { [key: string]: number } = {};
        const errorSet = new Set<string>();

        metrics.forEach((m) => {
          statusCodeMap[m.statusCode] = (statusCodeMap[m.statusCode] || 0) + 1;
          if (m.error && m.error.trim()) {
            errorSet.add(m.error);
          }
        });

        return {
          requestIndex: idx,
          method: 'GET',
          target: url,
          totalRequests: totalReqs,
          avgLatency: Math.round(avgLat),
          minLatency: Math.round(latencies[0] || avgLat),
          maxLatency: Math.round(latencies[totalReqs - 1] || avgLat),
          p50Latency: Math.round(calculatePercentile(latencies, 0.5)),
          p95Latency: Math.round(calculatePercentile(latencies, 0.95)),
          p99Latency: Math.round(calculatePercentile(latencies, 0.99)),
          successRate: successCnt / totalReqs,
          bytesIn: metrics.reduce((sum, m) => sum + m.bytesIn, 0),
          bytesOut: metrics.reduce((sum, m) => sum + m.bytesOut, 0),
          statusCodes: statusCodeMap,
          errors: Array.from(errorSet),
        };
      });

      // Upload the final TestResult
      console.log(chalk.cyan(`\n📊 Uploading final TestResult with aggregated metrics...`));
      const resultCreated = await createTestResult(executionId, results.testId, results, token, apiUrl, requestMetricSummaries);
      return resultCreated;
    } catch (vegeteaError) {
      console.error(chalk.red(`\n❌ Vegeta streaming failed:`));
      console.error(chalk.red(`  Command: vegeta attack | vegeta encode -to json`));
      console.error(chalk.red(`  Error: ${vegeteaError instanceof Error ? vegeteaError.message : String(vegeteaError)}`));
      throw vegeteaError;
    }
  } finally {
    try {
      unlinkSync(tempFile);
    } catch (e) {
      // Ignore
    }
  }
}

async function createOrGetExecutionPlan(
  plan: ExecutionPlanFile,
  token: string,
  apiUrl: string
): Promise<ExecutionPlan | null> {
  try {
    const response = await axios.post(
      `${apiUrl}/loadtestsplans`,
      {
        name: plan.metadata.planName,
        executionTime: plan.tests[0]?.duration || '1m',
        delayBetweenRequests: plan.tests[0]?.delayBetweenRequests || '100ms',
        iterations: plan.tests[0]?.iterations || 1,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 10000,
      }
    );
    return response.data;
  } catch (error) {
    console.error(chalk.red('Failed to create/get execution plan:'), error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function createLoadTestExecution(
  executionPlanId: string,
  name: string,
  token: string,
  apiUrl: string
): Promise<LoadTestExecution | null> {
  try {
    const response = await axios.post(
      `${apiUrl}/loadtestsexecutions`,
      {
        executionPlanId,
        name,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 10000,
      }
    );
    return response.data;
  } catch (error) {
    console.error(chalk.red('Failed to create load test execution:'), error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function ensureVegeta(): Promise<void> {
  try {
    const { stdout } = await execa('vegeta', ['version'], { timeout: 5000 });
    console.log(chalk.green(`✅ Vegeta is available: ${stdout.trim().split('\n')[0]}`));
    return;
  } catch (error) {
    console.log(chalk.yellow('⚠️  Vegeta not found in PATH, attempting to install...'));

    const platform = process.platform;
    const arch = process.arch;

    let vegetaUrl: string;
    if (platform === 'darwin') {
      if (arch === 'arm64') {
        vegetaUrl = 'https://github.com/tsenart/vegeta/releases/download/v12.13.0/vegeta_12.13.0_darwin_arm64.tar.gz';
      } else {
        vegetaUrl = 'https://github.com/tsenart/vegeta/releases/download/v12.13.0/vegeta_12.13.0_darwin_amd64.tar.gz';
      }
    } else {
      throw new Error(`Unsupported platform: ${platform} ${arch}`);
    }

    try {
      const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${process.pid}`;
      const tempDir = `/tmp/vegeta-install-${uniqueId}`;
      await execa('rm', ['-rf', tempDir]);
      await execa('mkdir', ['-p', tempDir]);

      const tarballPath = `${tempDir}/vegeta.tar.gz`;
      console.log(chalk.gray(`  Downloading from: ${vegetaUrl}`));
      
      await execa('curl', ['-L', '-f', '-o', tarballPath, vegetaUrl], {
        timeout: 60000
      });

      const stats = await fs.stat(tarballPath);
      if (stats.size === 0) {
        throw new Error('Downloaded file is empty');
      }

      console.log(chalk.gray(`  Extracting to: ${tempDir}`));
      await execa('tar', ['-xzf', tarballPath, '-C', tempDir]);

      const { stdout: lsOutput } = await execa('ls', ['-la', tempDir]);
      console.log(chalk.gray(`  Contents of ${tempDir}:`));
      lsOutput.split('\n').forEach(line => console.log(chalk.gray(`    ${line}`)));

      let vegetaBinary: string | undefined;
      try {
        const { stdout: findOutput } = await execa('find', [tempDir, '-name', 'vegeta', '-type', 'f', '-executable']);
        const lines = findOutput.trim().split('\n').filter(l => l.length > 0);
        vegetaBinary = lines[0];
        console.log(chalk.gray(`  Found vegeta binary at: ${vegetaBinary}`));
      } catch (findError) {
        console.log(chalk.gray(`  Find command failed, trying alternative method`));
        vegetaBinary = `${tempDir}/vegeta`;
        try {
          await execa('test', ['-f', vegetaBinary]);
        } catch {
          try {
            const { stdout: lsFiles } = await execa('find', [tempDir, '-type', 'f']);
            const files = lsFiles.trim().split('\n');
            vegetaBinary = files.find(f => f.includes('vegeta'));
          } catch {
            vegetaBinary = undefined;
          }
        }
      }

      if (!vegetaBinary) {
        throw new Error('Could not find vegeta binary in downloaded archive.');
      }

      console.log(chalk.gray(`  Installing binary: ${vegetaBinary}`));

      try {
        await execa('sudo', ['mv', vegetaBinary, '/usr/local/bin/vegeta']);
        await execa('sudo', ['chmod', '+x', '/usr/local/bin/vegeta']);
        console.log(chalk.green('✅ Vegeta installed to /usr/local/bin'));
      } catch (sudoError) {
        const userBinDir = path.join(process.env.HOME || '/tmp', '.local', 'bin');
        await execa('mkdir', ['-p', userBinDir]);
        await execa('cp', [vegetaBinary, `${userBinDir}/vegeta`]);
        await execa('chmod', ['+x', `${userBinDir}/vegeta`]);
        process.env.PATH = `${userBinDir}:${process.env.PATH}`;
        console.log(chalk.green(`✅ Vegeta installed to ${userBinDir}`));
        console.log(chalk.yellow('⚠️  You may need to add ~/.local/bin to your PATH'));
      }

      await execa('rm', ['-rf', tempDir]);
      console.log(chalk.green('✅ Vegeta installed successfully'));
    } catch (downloadError) {
      console.error(chalk.red('❌ Failed to download Vegeta:'), downloadError instanceof Error ? downloadError.message : String(downloadError));
      throw new Error('Vegeta is required. Install from: https://github.com/tsenart/vegeta/releases');
    }
  }
}

export async function executePlanCommand(planFile: string, options: RunOptions): Promise<void> {
  try {
    let resolvedPlanFile = planFile;
    if (planFile.includes('*')) {
      const dirname = path.dirname(path.resolve(planFile));
      const pattern = path.basename(planFile);
      const files = await fs.readdir(dirname);
      const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
      const matches = files.filter(f => regex.test(f));
      
      if (matches.length === 0) {
        throw new Error(`No execution plan files found matching pattern: ${planFile}`);
      }
      
      if (matches.length > 1) {
        throw new Error(`Multiple execution plan files found matching pattern: ${planFile}`);
      }
      
      resolvedPlanFile = path.join(dirname, matches[0]);
    }

    console.log(chalk.cyan(`📋 Loading execution plan from: ${resolvedPlanFile}`));
    const planContent = await fs.readFile(path.resolve(resolvedPlanFile), "utf8");
    const plan: ExecutionPlanFile = JSON.parse(planContent);

    if (!plan.metadata || !plan.authentication || !plan.tests) {
      throw new Error("Invalid execution plan file structure");
    }

    const token = plan.authentication.token;
    if (!token) {
      throw new Error("No authentication token found in execution plan");
    }

    let apiUrl: string;
    if (options.apiUrl) {
      apiUrl = options.apiUrl;
    } else {
      const env = options.env || process.env.NODE_ENV || 'prod';
      const envApiUrls = {
        local: 'http://localhost:3000',
        dev: 'https://apimetrics.onrender.com',
        development: 'https://apimetrics.onrender.com',
        prod: 'https://apimetrics.onrender.com',
        production: 'https://apimetrics.onrender.com'
      };
      apiUrl = envApiUrls[env.toLowerCase() as keyof typeof envApiUrls] || 'http://localhost:3000';
    }

    console.log(chalk.green("✅ Execution plan loaded successfully"));
    console.log(chalk.cyan(`\n📊 Execution Details:`));
    console.log(chalk.gray(`  Name: ${plan.metadata.name}`));
    console.log(chalk.gray(`  Plan: ${plan.metadata.planName}`));
    console.log(chalk.gray(`  Tests: ${plan.tests.length}`));
    console.log(chalk.gray(`  API URL: ${apiUrl}`));
    console.log(chalk.gray(`  Token: ${token.substring(0, 20)}...${token.substring(token.length - 10)}`));

    await ensureVegeta();

    const executionId = plan.metadata.executionId;
    if (!executionId) {
      throw new Error("No execution ID in plan. Download fresh plan from Test Executions.");
    }

    console.log(chalk.cyan(`\n🚀 Starting load tests for execution: ${executionId}\n`));

    const uploadSuccess = await runCombinedTests(plan.tests, token, apiUrl, plan.metadata.name, executionId);

    if (uploadSuccess) {
      console.log(chalk.green(`\n🎉 Load test completed!`));
      console.log(chalk.green(`📊 Results have been added to your execution`));
      console.log(chalk.green(`🌐 View results at: https://apimetrics.ai`));
    } else {
      console.log(chalk.yellow(`\n⚠️  Test result failed to upload.`));
      console.log(chalk.yellow(`🔗 Try running again or check your API connection.`));
    }

  } catch (error) {
    console.error(chalk.red("❌ Error:"), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
