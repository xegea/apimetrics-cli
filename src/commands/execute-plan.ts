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
import { pipeline } from "stream/promises";

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
  testResultId: string,
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
    const minLatency = sortedLatencies.length > 0 ? Math.min(...sortedLatencies) : 0;
    const maxLatency = sortedLatencies.length > 0 ? Math.max(...sortedLatencies) : 0;
    
    // Debug logging
    console.log(chalk.gray(`      DEBUG: sortedLatencies.length = ${sortedLatencies.length}`));
    console.log(chalk.gray(`      DEBUG: minLatency (ns) = ${minLatency}, maxLatency (ns) = ${maxLatency}`));
    console.log(chalk.gray(`      DEBUG: minLatency (ms) = ${Math.round(minLatency / 1000000)}, maxLatency (ms) = ${Math.round(maxLatency / 1000000)}`));

    const bucketData = {
      testResultId,
      bucketNumber,
      startTime: bucketState.startTime.toISOString(),
      endTime: bucketState.endTime.toISOString(),
      totalRequests,
      successCount: bucketState.successCount,
      failureCount: bucketState.failureCount,
      avgLatency: Math.round(avgLatency / 1000000), // Convert nanoseconds to milliseconds
      minLatency: minLatency > 0 ? Math.max(1, Math.round(minLatency / 1000000)) : 0, // Min 1ms if non-zero
      maxLatency: Math.round(maxLatency / 1000000), // Convert nanoseconds to milliseconds
      p50Latency: Math.round(calculatePercentile(sortedLatencies, 0.5) / 1000000), // Convert nanoseconds to milliseconds
      p95Latency: Math.round(calculatePercentile(sortedLatencies, 0.95) / 1000000), // Convert nanoseconds to milliseconds
      p99Latency: Math.round(calculatePercentile(sortedLatencies, 0.99) / 1000000), // Convert nanoseconds to milliseconds
      successRate: bucketState.successCount / totalRequests,
      bytesIn: bucketState.bytesIn,
      bytesOut: bucketState.bytesOut,
      statusCodes: bucketState.statusCodes,
      errors: Array.from(bucketState.errorSet),
    };

    console.log(chalk.cyan(`\n   📦 Uploading metrics bucket #${bucketNumber}...`));
    console.log(chalk.gray(`      Time Range: ${bucketState.startTime.toISOString()} → ${bucketState.endTime.toISOString()}`));
    console.log(chalk.gray(`      Requests: ${totalRequests} (${bucketState.successCount} success, ${bucketState.failureCount} failed)`));
    console.log(chalk.gray(`      Avg Latency: ${bucketData.avgLatency.toFixed(2)}ms`));
    console.log(chalk.gray(`      📌 ExecutionId: ${executionId}`));
    console.log(chalk.gray(`      📌 TestResultId: ${testResultId}`));
    console.log(chalk.gray(`      📌 API URL: ${apiUrl}/loadtestsexecutions/${executionId}/buckets`));
    console.log(chalk.gray(`      📌 Payload size: ${JSON.stringify(bucketData).length} bytes`));

    const uploadStartTime = Date.now();
    try {
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

      const uploadDuration = Date.now() - uploadStartTime;
      console.log(chalk.green(`      ✅ Bucket #${bucketNumber} uploaded (ID: ${response.data.id}, took ${uploadDuration}ms)`));
      console.log(chalk.gray(`      Response Status: ${response.status}`));
      return true;
    } catch (uploadError) {
      const uploadDuration = Date.now() - uploadStartTime;
      console.log(chalk.red(`      ❌ Upload failed after ${uploadDuration}ms`));
      throw uploadError;
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(chalk.red(`      ❌ Bucket upload error:`), error.message);
    } else {
      console.error(chalk.red(`      ❌ Unexpected error:`, error instanceof Error ? error.message : String(error)));
    }
    return false;
  }
}

async function createInitialTestResult(
  executionId: string,
  testId: string,
  token: string,
  apiUrl: string
): Promise<string | null> {
  try {
    console.log(chalk.cyan(`\n📝 Creating initial TestResult...`));
    
    const payload = {
      testId,
      timestamp: new Date().toISOString(),
      totalRequests: 0,
      successRate: 0,
    };

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

    const testResultId = response.data.id;
    console.log(chalk.green(`✅ TestResult created with ID: ${testResultId}`));
    return testResultId;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(chalk.red(`❌ Failed to create TestResult:`), error.message);
      if (error.response) {
        console.error(chalk.red(`Status:`, error.response.status));
        console.error(chalk.red(`Response:`, JSON.stringify(error.response.data, null, 2)));
      }
      if (error.request && !error.response) {
        console.error(chalk.red(`No response received. Request was made but no response.`));
      }
      console.error(chalk.red(`Full error:`, error));
    } else {
      console.error(chalk.red(`❌ Unexpected error:`, error instanceof Error ? error.message : String(error)));
      console.error(chalk.red(`Full error:`, error));
    }
    return null;
  }
}

async function createTestResult(
  executionId: string,
  testResultId: string,
  testId: string,
  results: any,
  token: string,
  apiUrl: string,
  requestMetrics?: RequestMetricSummary[]
): Promise<boolean> {
  try {
    console.log(chalk.cyan('\n📤 Uploading final TestResult metrics...'));
    
    const payload = {
      ...results,
      testId,
      requestMetrics: requestMetrics || []
    };

    if (requestMetrics && requestMetrics.length > 0) {
      console.log(chalk.gray(`  Including ${requestMetrics.length} per-request metrics`));
    }
    
    console.log(chalk.gray(`\n  📊 TestResult Summary:`));
    console.log(chalk.gray(`     - Execution ID: ${executionId}`));
    console.log(chalk.gray(`     - TestResult ID: ${testResultId}`));
    console.log(chalk.gray(`     - Total Requests: ${results.totalRequests}`));
    console.log(chalk.gray(`     - Success Rate: ${(results.successRate * 100).toFixed(2)}%`));
    console.log(chalk.gray(`     - Avg Latency: ${(results.avgLatency / 1000000).toFixed(2)}ms`));
    console.log(chalk.gray(`     - P95 Latency: ${(results.p95Latency / 1000000).toFixed(2)}ms`));

    console.log(chalk.gray(`\n  🔗 Updating TestResult at: ${apiUrl}/loadtestsexecutions/${executionId}/loadtests/${testResultId}`));

    const response = await axios.patch(
      `${apiUrl}/loadtestsexecutions/${executionId}/loadtests/${testResultId}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    console.log(chalk.green(`\n  ✅ TestResult updated successfully`));
    console.log(chalk.gray(`     Response Status: ${response.status} ${response.statusText}`));
    return true;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(chalk.red(`\n  ⚠️  TestResult update error:`), error.message);
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
  executionId: string,
  testResultId: string
): Promise<boolean> {
  console.log(chalk.blue(`\n🔗 Combining ${tests.length} test(s) into single load test with REAL-TIME streaming metrics`));
  console.log(chalk.gray(`   TestResult ID: ${testResultId}`));

  let binaryOutputFile = '';  // Declare at function level for cleanup in finally
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
    const bucketsNeedingUpdate = new Set<number>(); // Track buckets that got modified after upload
    const bucketDuration = 5000; // 5 seconds
    let firstMetricTime: number | null = null;
    let totalRequests = 0;
    let successRequests = 0;
    const allStatusCodes: Record<string, number> = {};
    const allErrorSet = new Set<string>();
    let totalBytesIn = 0;
    let totalBytesOut = 0;
    const allLatencies: number[] = [];
    let maxBucketKeySeen = -1; // Track the highest bucket key we've seen

    try {
      console.log(chalk.gray(`\n   Starting vegeta load test...`));
      console.log(chalk.gray(`   📌 ExecutionId: ${executionId}`));
      console.log(chalk.gray(`   📌 TestResultId: ${testResultId}`));
      console.log(chalk.gray(`   📌 Process ID: ${process.pid}`));
      
      // Simple timeout wrapper for vegeta execution
      const durationSeconds = parseInt(duration);
      const totalTimeoutMs = (durationSeconds + 10) * 1000;  // Add 10 seconds buffer
      
      console.log(chalk.gray(`   Running vegeta (timeout: ${totalTimeoutMs / 1000}s)`));
      console.log(chalk.gray(`   Vegeta config: RPS=${rps}, Duration=${duration}`));
      console.log(chalk.gray(`   Temp file: ${tempFile}`));
      
      // Use execSync with timeout to run vegeta in-process
      let jsonOutput: string;
      const vegaStartTime = Date.now();
      try {
        const cmd = `vegeta attack -rate=${rps} -duration=${duration} -timeout=30s -targets="${tempFile}" | vegeta encode --to=json`;
        console.log(chalk.gray(`   🔄 Executing vegeta command: ${cmd}`));
        jsonOutput = execSync(cmd, {
          timeout: totalTimeoutMs,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        });
        const vegaDuration = Date.now() - vegaStartTime;
        console.log(chalk.gray(`   ✓ Vegeta completed in ${vegaDuration}ms`));
      } catch (syncError: any) {
        console.log(chalk.red(`   ❌ Vegeta execution error`));
        console.log(chalk.red(`   Error type: ${syncError.code || syncError.signal || 'UNKNOWN'}`));
        console.log(chalk.red(`   Error message: ${syncError.message}`));
        if (syncError.signal === 'SIGTERM') {
          throw new Error(`Vegeta timeout after ${totalTimeoutMs / 1000}s - targets may be unreachable`);
        }
        throw syncError;
      }

      // Parse the JSON output line by line
      console.log(chalk.gray(`\n   📊 Vegeta output received, parsing metrics...`));
      console.log(chalk.gray(`   📌 Output length: ${jsonOutput.length} characters`));
      
      const lines = jsonOutput.split('\n').filter(l => l.trim());
      console.log(chalk.gray(`   📊 Total lines to process: ${lines.length}`));
      
      if (lines.length === 0) {
        console.log(chalk.yellow(`   ⚠️  WARNING: No metrics received from vegeta!`));
        console.log(chalk.yellow(`   ⚠️  This usually means vegeta didn't generate requests.`));
        console.log(chalk.gray(`   Raw vegeta output (first 500 chars): ${jsonOutput.substring(0, 500)}`));
      }
      
      console.log(chalk.gray(`\n   🔄 Starting metric processing loop...`));
      let metricProcessingStartTime = Date.now();
      let linesParsed = 0;
      let linesFailed = 0;
      
      for (const line of lines) {
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
          linesParsed++;
          
          if (statusCode >= 200 && statusCode < 300) {
            successRequests++;
          }

          allStatusCodes[statusCode] = (allStatusCodes[statusCode] || 0) + 1;
          if (error && error.trim()) {
            allErrorSet.add(error);
          }

          totalBytesIn += bytesIn;
          totalBytesOut += bytesOut;
          
          // Only include non-zero latencies (Vegeta returns 0 for failed requests)
          if (latency > 0) {
            allLatencies.push(latency);
          }

          // Initialize first metric time
          if (firstMetricTime === null) {
            firstMetricTime = timestamp.getTime();
            console.log(chalk.gray(`\n   ⏱️  First metric received at: ${timestamp.toISOString()}`));
          }

          // Assign to bucket based on 5-second windows from first metric
          const metricTime = timestamp.getTime();
          let bucketKey = Math.floor((metricTime - firstMetricTime) / bucketDuration);
          
          // Handle metrics that arrive before the first metric time (clock skew, out of order)
          // Put them in bucket 0
          if (bucketKey < 0) {
            console.log(chalk.yellow(`   ⚠️  Metric arrived before first metric time (clock skew), assigning to bucket 0. Metric time: ${metricTime}, First metric time: ${firstMetricTime}`));
            bucketKey = 0;
          }

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
          
          // If this bucket was already uploaded, mark it for update
          if (uploadedBuckets.has(bucketKey)) {
            bucketsNeedingUpdate.add(bucketKey);
          }
          
          bucket.metrics.push(metric);
          bucket.totalRequests++;
          
          // Only include non-zero latencies (Vegeta returns 0 for failed requests)
          if (latency > 0) {
            bucket.latencies.push(latency);
          }
          
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

          // When we see a metric from a new bucket, upload all previous buckets (real-time)
          if (bucketKey > maxBucketKeySeen) {
            maxBucketKeySeen = bucketKey;
            
            // Upload ALL completed buckets up to (but not including) the current bucket
            for (let bk = 0; bk < bucketKey; bk++) {
              if (!uploadedBuckets.has(bk) && buckets.has(bk)) {
                const bucketToUpload = buckets.get(bk)!;
                if (bucketToUpload.metrics.length > 0) {
                  await uploadMetricsBucket(executionId, testResultId, bk, bucketToUpload, token, apiUrl);
                  uploadedBuckets.add(bk);
                }
              }
            }
          }

          // Progress indicator
          if (totalRequests % 50 === 0) {
            console.log(chalk.gray(`   ✓ Processed ${totalRequests} metrics in real-time...`));
          }
        } catch (parseError) {
          linesFailed++;
          console.warn(chalk.yellow(`   ⚠️  Skipped unparseable line (error #${linesFailed}): ${line.substring(0, 50)}`));
          if (linesFailed <= 3) {
            console.warn(chalk.yellow(`      Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
          }
        }
      }
      
      const metricProcessingDuration = Date.now() - metricProcessingStartTime;
      console.log(chalk.gray(`\n   📊 Metric processing completed in ${metricProcessingDuration}ms`));
      console.log(chalk.gray(`   📌 Total lines parsed: ${linesParsed}`));
      console.log(chalk.gray(`   📌 Lines failed to parse: ${linesFailed}`));
      console.log(chalk.gray(`   📌 Total requests collected: ${totalRequests}`));
      console.log(chalk.gray(`   📌 Success requests: ${successRequests}`));
      console.log(chalk.gray(`   📌 All latencies collected: ${allLatencies.length}`));

      // After stream ends, upload remaining buckets and update any that changed
      console.log(chalk.cyan(`\n📦 Finalizing metrics buckets...`));
      console.log(chalk.gray(`   Total buckets created: ${buckets.size}`));
      console.log(chalk.gray(`   Already uploaded: ${uploadedBuckets.size}`));
      console.log(chalk.gray(`   Need updates: ${bucketsNeedingUpdate.size}`));
      
      const sortedBuckets = Array.from(buckets.entries())
        .sort(([keyA], [keyB]) => keyA - keyB);

      let bucketsUploaded = 0;
      let bucketsUpdated = 0;
      let totalMetricsInBuckets = 0;
      
      console.log(chalk.gray(`\n   📌 Bucket details:`));
      for (const [bk, bs] of sortedBuckets) {
        console.log(chalk.gray(`      Bucket #${bk}: ${bs.metrics.length} metrics, time range: ${bs.startTime.toISOString()} → ${bs.endTime.toISOString()}`));
      }
      
      // Upload remaining buckets and update modified ones
      console.log(chalk.gray(`\n   🚀 Starting bucket upload process...`));
      for (const [bucketKey, bucketState] of sortedBuckets) {
        if (bucketKey >= 0 && bucketState.metrics.length > 0) {
          totalMetricsInBuckets += bucketState.metrics.length;
          
          if (!uploadedBuckets.has(bucketKey)) {
            // New bucket - upload it
            console.log(chalk.gray(`   → [${bucketsUploaded + 1}] Uploading bucket #${bucketKey} with ${bucketState.metrics.length} metrics`));
            const uploadStart = Date.now();
            try {
              await uploadMetricsBucket(executionId, testResultId, bucketKey, bucketState, token, apiUrl);
              const uploadDuration = Date.now() - uploadStart;
              console.log(chalk.gray(`      ✓ Uploaded in ${uploadDuration}ms`));
              bucketsUploaded++;
            } catch (uploadError) {
              console.log(chalk.red(`      ✗ Failed to upload: ${uploadError instanceof Error ? uploadError.message : String(uploadError)}`));
            }
          } else if (bucketsNeedingUpdate.has(bucketKey)) {
            // Bucket needs update - re-upload with corrected data
            console.log(chalk.yellow(`   ⟳ Updating bucket #${bucketKey} with final ${bucketState.metrics.length} metrics`));
            const updateStart = Date.now();
            try {
              await uploadMetricsBucket(executionId, testResultId, bucketKey, bucketState, token, apiUrl);
              const updateDuration = Date.now() - updateStart;
              console.log(chalk.gray(`      ✓ Updated in ${updateDuration}ms`));
              bucketsUpdated++;
            } catch (updateError) {
              console.log(chalk.red(`      ✗ Failed to update: ${updateError instanceof Error ? updateError.message : String(updateError)}`));
            }
          }
        }
      }
      
      console.log(chalk.green(`   ✅ Uploaded ${bucketsUploaded} new buckets, updated ${bucketsUpdated} buckets`));
      console.log(chalk.green(`   ✅ Total metrics in all buckets: ${totalMetricsInBuckets}`));

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
      console.log(chalk.gray(`   Total Requests (all metrics): ${totalRequests}`));
      console.log(chalk.gray(`   Total Requests (in buckets): ${Array.from(uploadedBuckets).reduce((sum, bk) => sum + (buckets.get(bk)?.metrics.length || 0), 0)}`));
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
      const resultCreated = await createTestResult(executionId, testResultId, results.testId, results, token, apiUrl, requestMetricSummaries);
      
      return resultCreated;
    } catch (vegeteaError) {
      console.error(chalk.red(`\n❌ Vegeta streaming failed:`));
      console.error(chalk.red(`  Command: vegeta attack | vegeta encode -to json`));
      console.error(chalk.red(`  Error: ${vegeteaError instanceof Error ? vegeteaError.message : String(vegeteaError)}`));
      
      throw vegeteaError;
    }
  } finally {
    // Clean up temp files
    try {
      unlinkSync(tempFile);
      unlinkSync(binaryOutputFile);
    } catch (e) {
      // Ignore - files might not exist
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
): Promise<any> {
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
  const checkStartTime = Date.now();
  console.log(chalk.gray(`\n📌 Checking for vegeta (Process ID: ${process.pid})...`));
  
  try {
    const { stdout } = await execa('vegeta', ['version'], { timeout: 5000 });
    const checkDuration = Date.now() - checkStartTime;
    console.log(chalk.green(`✅ Vegeta is available: ${stdout.trim().split('\n')[0]} (check took ${checkDuration}ms)`));
    return;
  } catch (error) {
    const checkDuration = Date.now() - checkStartTime;
    console.log(chalk.yellow(`⚠️  Vegeta not found in PATH (check took ${checkDuration}ms), attempting to install...`));
    console.log(chalk.gray(`   📌 Check error: ${error instanceof Error ? error.message : String(error)}`));

    const platform = process.platform;
    const arch = process.arch;

    let vegetaUrl: string;
    let isWindows = false;
    
    if (platform === 'darwin') {
      if (arch === 'arm64') {
        vegetaUrl = 'https://github.com/tsenart/vegeta/releases/download/v12.13.0/vegeta_12.13.0_darwin_arm64.tar.gz';
      } else {
        vegetaUrl = 'https://github.com/tsenart/vegeta/releases/download/v12.13.0/vegeta_12.13.0_darwin_amd64.tar.gz';
      }
    } else if (platform === 'win32') {
      isWindows = true;
      if (arch === 'x64') {
        // Windows releases use zip format, not tar.gz
        vegetaUrl = 'https://github.com/tsenart/vegeta/releases/download/v12.12.0/vegeta_12.12.0_windows_amd64.zip';
      } else if (arch === 'arm64') {
        vegetaUrl = 'https://github.com/tsenart/vegeta/releases/download/v12.12.0/vegeta_12.12.0_windows_arm64.zip';
      } else {
        throw new Error(`Unsupported Windows architecture: ${arch}`);
      }
    } else if (platform === 'linux') {
      if (arch === 'x64') {
        vegetaUrl = 'https://github.com/tsenart/vegeta/releases/download/v12.13.0/vegeta_12.13.0_linux_amd64.tar.gz';
      } else if (arch === 'arm64') {
        vegetaUrl = 'https://github.com/tsenart/vegeta/releases/download/v12.13.0/vegeta_12.13.0_linux_arm64.tar.gz';
      } else {
        throw new Error(`Unsupported Linux architecture: ${arch}`);
      }
    } else {
      throw new Error(`Unsupported platform: ${platform} ${arch}`);
    }

    try {
      const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${process.pid}`;
      const tempDir = isWindows 
        ? path.join(os.tmpdir(), `vegeta-install-${uniqueId}`)
        : `/tmp/vegeta-install-${uniqueId}`;
      
      // Create temp directory
      if (isWindows) {
        await fs.mkdir(tempDir, { recursive: true });
      } else {
        await execa('rm', ['-rf', tempDir]);
        await execa('mkdir', ['-p', tempDir]);
      }

      const archivePath = isWindows 
        ? path.join(tempDir, 'vegeta.zip')
        : path.join(tempDir, 'vegeta.tar.gz');
      
      console.log(chalk.gray(`  Downloading from: ${vegetaUrl}`));
      
      // Download using curl (available in Git Bash on Windows)
      await execa('curl', ['-L', '-f', '-o', archivePath, vegetaUrl], {
        timeout: 60000
      });

      const stats = await fs.stat(archivePath);
      if (stats.size === 0) {
        throw new Error('Downloaded file is empty');
      }

      console.log(chalk.gray(`  Extracting to: ${tempDir}`));
      
      if (isWindows) {
        // Use PowerShell to extract ZIP on Windows
        await execa('powershell', [
          '-Command',
          `Expand-Archive -Path "${archivePath}" -DestinationPath "${tempDir}" -Force`
        ]);
      } else {
        await execa('tar', ['-xzf', archivePath, '-C', tempDir]);
      }

      // Find vegeta binary
      const vegetaBinaryName = isWindows ? 'vegeta.exe' : 'vegeta';
      const vegetaBinary = path.join(tempDir, vegetaBinaryName);
      
      // Check if binary exists
      try {
        await fs.access(vegetaBinary);
        console.log(chalk.gray(`  Found vegeta binary at: ${vegetaBinary}`));
      } catch {
        throw new Error(`Could not find ${vegetaBinaryName} in downloaded archive.`);
      }

      console.log(chalk.gray(`  Installing binary: ${vegetaBinary}`));

      if (isWindows) {
        // On Windows, install to user's local bin directory
        const localBinDir = path.join(os.homedir(), '.local', 'bin');
        await fs.mkdir(localBinDir, { recursive: true });
        
        const targetPath = path.join(localBinDir, 'vegeta.exe');
        await fs.copyFile(vegetaBinary, targetPath);
        
        // Update PATH for current process
        process.env.PATH = `${localBinDir};${process.env.PATH}`;
        
        console.log(chalk.green(`✅ Vegeta installed to ${localBinDir}`));
        console.log(chalk.yellow(`⚠️  Add to your PATH: ${localBinDir}`));
      } else {
        // Unix installation - use user bin directory to avoid sudo password prompt
        const userBinDir = path.join(process.env.HOME || '/tmp', '.local', 'bin');
        const lockFile = path.join(userBinDir, '.vegeta-install.lock');
        
        console.log(chalk.gray(`  📌 Unix installation: userBinDir=${userBinDir}`));
        console.log(chalk.gray(`  📌 Lock file: ${lockFile}`));
        console.log(chalk.gray(`  📌 Process ID: ${process.pid}`));
          
          // Wait for any other process to finish installing
          let waitAttempts = 0;
          const lockWaitStart = Date.now();
          while (await fs.access(lockFile).then(() => true).catch(() => false)) {
            if (waitAttempts % 5 === 0) {
              console.log(chalk.gray(`  📌 Waiting for lock file... (attempt ${waitAttempts + 1}, ${Date.now() - lockWaitStart}ms)`));
            }
            if (waitAttempts > 30) {
              throw new Error(`Timeout waiting for vegeta installation lock after ${Date.now() - lockWaitStart}ms`);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            waitAttempts++;
          }
          
          if (waitAttempts > 0) {
            console.log(chalk.gray(`  📌 Lock file released after ${waitAttempts} attempts (${Date.now() - lockWaitStart}ms)`));
          }
          
          // Create lock file
          const lockCreateStart = Date.now();
          try {
            await fs.writeFile(lockFile, `${Date.now()}-${process.pid}`);
            console.log(chalk.gray(`  📌 Lock file created (${Date.now() - lockCreateStart}ms)`));
          } catch (e) {
            // Lock file already exists from another process, wait a bit more
            console.log(chalk.gray(`  📌 Lock file creation failed, waiting for other process...`));
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          
          try {
            const mkdirStart = Date.now();
            await execa('mkdir', ['-p', userBinDir]);
            console.log(chalk.gray(`  📌 userBinDir created/exists (${Date.now() - mkdirStart}ms)`));
            
            // Check if vegeta already installed (another process might have done it)
            const checkStart = Date.now();
            try {
              await fs.access(path.join(userBinDir, 'vegeta'));
              console.log(chalk.green(`✅ Vegeta already installed to ${userBinDir} (checked in ${Date.now() - checkStart}ms)`));
            } catch {
              // Not installed yet, do it now
              const cpStart = Date.now();
              await execa('cp', [vegetaBinary, `${userBinDir}/vegeta`]);
              await execa('chmod', ['+x', `${userBinDir}/vegeta`]);
              const cpDuration = Date.now() - cpStart;
              console.log(chalk.green(`✅ Vegeta installed to ${userBinDir} (took ${cpDuration}ms)`));
            }
          } finally {
            // Remove lock file
            try {
              await fs.unlink(lockFile);
              console.log(chalk.gray(`  📌 Lock file removed`));
            } catch (e) {
              // Ignore
              console.log(chalk.gray(`  📌 Lock file removal failed (this is ok)`));
            }
          }
          
        process.env.PATH = `${userBinDir}:${process.env.PATH}`;
        console.log(chalk.yellow('⚠️  You may need to add ~/.local/bin to your PATH'));
      }

      // Clean up
      if (isWindows) {
        await fs.rm(tempDir, { recursive: true, force: true });
      } else {
        await execa('rm', ['-rf', tempDir]);
      }
      
      console.log(chalk.green('✅ Vegeta installed successfully'));
    } catch (downloadError) {
      console.error(chalk.red('❌ Failed to download Vegeta:'), downloadError instanceof Error ? downloadError.message : String(downloadError));
      throw new Error('Vegeta is required. Install from: https://github.com/tsenart/vegeta/releases');
    }
  }
}

export async function executePlanCommand(planFile: string, options: RunOptions): Promise<void> {
  const globalStartTime = Date.now();
  const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    console.log(chalk.cyan('\n🚀 ApiMetrics CLI starting...\n'));
    console.log(chalk.gray('⏳ Initializing execution environment, please wait...'));
    console.log(chalk.gray(`📌 Session ID: ${sessionId}`));
    console.log(chalk.gray(`📌 Process ID: ${process.pid}`));
    console.log(chalk.gray(`📌 Node Version: ${process.version}`));
    console.log(chalk.gray(`📌 Platform: ${os.platform()}`));
    
    // Expand ~ to home directory for cross-platform compatibility
    let resolvedPlanFile = planFile;
    if (planFile.startsWith('~')) {
      resolvedPlanFile = path.join(os.homedir(), planFile.slice(1));
    }
    
    if (resolvedPlanFile.includes('*')) {
      const dirname = path.dirname(path.resolve(resolvedPlanFile));
      const pattern = path.basename(resolvedPlanFile);
      const files = await fs.readdir(dirname);
      const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
      const matches = files.filter(f => regex.test(f));
      
      if (matches.length === 0) {
        throw new Error(`No execution plan files found matching pattern: ${resolvedPlanFile}`);
      }
      
      if (matches.length > 1) {
        throw new Error(`Multiple execution plan files found matching pattern: ${resolvedPlanFile}`);
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

    let executionId: string;
    if (plan.metadata.executionId) {
      executionId = plan.metadata.executionId;
    } else {
      console.log(chalk.cyan(`\n🔧 No execution ID found in plan, creating new LoadTestExecution...`));
      
      // Create a new LoadTestExecution
      // Use plan name as executionPlanId, or generate a unique one
      const executionPlanId = plan.metadata.planName || `plan-${Date.now()}`;
      const executionName = `${plan.metadata.name} - ${new Date().toISOString()}`;
      
      const newExecution = await createLoadTestExecution(executionPlanId, executionName, token, apiUrl);
      if (!newExecution) {
        throw new Error("Failed to create new LoadTestExecution");
      }
      
      executionId = newExecution.id;
      console.log(chalk.green(`✅ Created new LoadTestExecution: ${executionId}`));
    }

    console.log(chalk.cyan(`\n🚀 Starting load tests for execution: ${executionId}\n`));
    console.log(chalk.gray(`📌 Execution ID: ${executionId}`));
    console.log(chalk.gray(`📌 Session ID: ${sessionId}`));

    // Create TestResult first to get testResultId for bucket uploads
    const testId = `test-${Date.now()}`;
    console.log(chalk.gray(`📌 Test ID: ${testId}`));
    console.log(chalk.gray(`📌 About to create initial TestResult...`));
    
    const testResultCreateStart = Date.now();
    const testResultId = await createInitialTestResult(executionId, testId, token, apiUrl);
    const testResultCreateDuration = Date.now() - testResultCreateStart;
    console.log(chalk.gray(`📌 TestResult creation took ${testResultCreateDuration}ms`));
    
    if (!testResultId) {
      throw new Error("Failed to create TestResult");
    }
    console.log(chalk.gray(`📌 TestResult ID: ${testResultId}`));

    console.log(chalk.gray(`\n📌 About to start combined load tests...`));
    const loadTestStart = Date.now();
    const uploadSuccess = await runCombinedTests(plan.tests, token, apiUrl, plan.metadata.name, executionId, testResultId);
    const loadTestDuration = Date.now() - loadTestStart;
    console.log(chalk.gray(`📌 Combined load tests completed in ${loadTestDuration}ms`));

    if (uploadSuccess) {
      const totalDuration = Date.now() - globalStartTime;
      console.log(chalk.green(`\n🎉 Load test completed!`));
      console.log(chalk.green(`📊 Results have been added to your execution`));
      console.log(chalk.green(`🌐 View results at: https://apimetrics.ai`));
      console.log(chalk.gray(`\n📌 Total execution time: ${totalDuration}ms`));
      console.log(chalk.gray(`📌 Session ID: ${sessionId}`));
    } else {
      console.log(chalk.yellow(`\n⚠️  Test result failed to upload.`));
      console.log(chalk.yellow(`🔗 Try running again or check your API connection.`));
      console.log(chalk.gray(`📌 Session ID: ${sessionId}`));
    }

  } catch (error) {
    const totalDuration = Date.now() - globalStartTime;
    console.error(chalk.red("❌ Error:"), error instanceof Error ? error.message : String(error));
    console.error(chalk.gray(`📌 Session ID: ${sessionId}`));
    console.error(chalk.gray(`📌 Total execution time before error: ${totalDuration}ms`));
    if (error instanceof Error && error.stack) {
      console.error(chalk.gray(`📌 Stack trace: ${error.stack}`));
    }
    process.exit(1);
  }
}
