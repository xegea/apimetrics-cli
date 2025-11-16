import { execa } from "execa";
import axios from "axios";
import fs from "fs/promises";
import path from "path";
import chalk from "chalk";

interface ExecutionPlanFile {
  metadata: {
    name: string;
    planName: string;
    createdAt: string;
    description?: string;
    executionId?: string; // The LoadTestExecution ID to add results to
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
    // Legacy fields for backward compatibility
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

export async function executePlanCommand(planFile: string, options: RunOptions): Promise<void> {
  try {
    // Handle wildcard patterns by expanding them
    let resolvedPlanFile = planFile;
    if (planFile.includes('*')) {
      // If wildcard is provided, try to find matching files
      const dirname = path.dirname(path.resolve(planFile));
      const pattern = path.basename(planFile);
      const files = await fs.readdir(dirname);
      const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
      const matches = files.filter(f => regex.test(f));
      
      if (matches.length === 0) {
        throw new Error(`No execution plan files found matching pattern: ${planFile}\nMake sure the file is in ~/Downloads/ directory`);
      }
      
      if (matches.length > 1) {
        throw new Error(`Multiple execution plan files found matching pattern: ${planFile}\nPlease specify the exact file name or delete old execution plans.`);
      }
      
      resolvedPlanFile = path.join(dirname, matches[0]);
    }

    // Read and parse the execution plan file
    console.log(chalk.cyan(`📋 Loading execution plan from: ${resolvedPlanFile}`));
    const planContent = await fs.readFile(path.resolve(resolvedPlanFile), "utf8");
    const plan: ExecutionPlanFile = JSON.parse(planContent);

    // Validate the plan structure
    if (!plan.metadata || !plan.authentication || !plan.tests) {
      throw new Error("Invalid execution plan file structure");
    }

    const token = plan.authentication.token;
    if (!token) {
      throw new Error("No authentication token found in execution plan");
    }

    // Determine API URL
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

    // Check if Vegeta is available, download if not
    await ensureVegeta();

    // Get the LoadTestExecution ID from the execution plan file
    const executionId = plan.metadata.executionId;
    if (!executionId) {
      throw new Error("No execution ID found in execution plan file. Please download a fresh execution plan from the dashboard.");
    }

    console.log(chalk.cyan(`\n🚀 Starting load tests for execution: ${executionId}\n`));

    const uploadSuccess = await runCombinedTests(plan.tests, token, apiUrl, plan.metadata.name, executionId);

    if (uploadSuccess) {
      console.log(chalk.green(`\n🎉 Load test completed!`));
      console.log(chalk.green(`📊 Results have been added to your execution`));
      console.log(chalk.green(`🌐 View results at: https://apimetrics.ai`));
    } else {
      console.log(chalk.yellow(`\n⚠️  Test result failed to upload. Please check the errors above.`));
      console.log(chalk.yellow(`🔗 Try running again or check your API connection.`));
    }

  } catch (error) {
    console.error(chalk.red("❌ Error:"), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function runCombinedTests(
  tests: ExecutionPlanFile['tests'],
  token: string,
  apiUrl: string,
  planName: string,
  executionId: string
): Promise<boolean> {
  console.log(chalk.blue(`\n🔗 Combining ${tests.length} test(s) into single load test`));
  
  let attackInput = '';
  let totalRequestCount = 0;
  
  // Collect all requests from all tests into a single attack input
  for (const test of tests) {
    if (test.requests && test.requests.length > 0) {
      console.log(chalk.gray(`  • ${test.name}: ${test.requests.length} request(s)`));
      for (const request of test.requests) {
        let target = `${request.method.toUpperCase()} ${request.target}\n`;
        if (request.headers) {
          for (const [key, value] of Object.entries(request.headers)) {
            target += `${key}: ${value}\n`;
          }
        }
        target += '\n'; // Empty line to separate headers from body
        if (request.body) {
          target += request.body + '\n';
        }
        attackInput += target;
        totalRequestCount++;
      }
    } else if (test.method && test.target) {
      console.log(chalk.gray(`  • ${test.name}: 1 request (legacy format)`));
      attackInput += `${test.method.toUpperCase()} ${test.target}\n`;
      totalRequestCount++;
    }
  }
  
  // Show all requests in the cycle loop
  console.log(chalk.cyan(`\n  📋 Requests in cycle loop (will repeat in order):`));
  const requestLines = attackInput.trim().split('\n');
  requestLines.forEach((line, index) => {
    console.log(chalk.gray(`     ${index + 1}. ${line}`));
  });
  
  // Use settings from the first test (they should all be the same)
  const firstTest = tests[0];
  const rps = firstTest.rps;
  const duration = firstTest.duration;
  
  console.log(chalk.gray(`  Total requests to cycle through: ${totalRequestCount}`));
  console.log(chalk.gray(`  RPS: ${rps}, Duration: ${duration}`));
  console.log("");

  // Run vegeta attack with combined requests
  const { stdout } = await execa(
      'sh',
      ['-c', `printf '%s' "${attackInput.trim()}" | vegeta attack -rate=${rps} -duration=${duration} | vegeta report -type=json`],
      {
        stripFinalNewline: true,
        timeout: 300000 // 5 minutes timeout for the test
      }
    );

    // Parse the JSON output
    const report = JSON.parse(stdout);

    console.log(chalk.green(`  ✅ Combined load test completed`));
    console.log(chalk.gray(`     Total Requests: ${report.requests || 0}`));
    console.log(chalk.gray(`     Duration: ${report.duration || 'N/A'}`));
    console.log(chalk.gray(`     Rate: ${report.rate || 'N/A'} RPS`));
    console.log(chalk.gray(`     Throughput: ${report.throughput || 'N/A'} req/sec`));
    console.log(chalk.gray(`     Success Rate: ${(report.success * 100 || 0).toFixed(2)}%`));

    // Extract detailed metrics
    const latencies = report.latencies || {};
    const statusCodes = report.status_codes || {};
    const errors = report.errors || [];

    console.log(chalk.cyan(`\n     📊 Detailed Metrics:`));
    
    // Latency metrics
    console.log(chalk.gray(`     Response Times:`));
    console.log(chalk.gray(`       • Mean: ${(latencies.mean / 1000000 || 0).toFixed(2)}ms`));
    console.log(chalk.gray(`       • Min:  ${(latencies.min / 1000000 || 0).toFixed(2)}ms`));
    console.log(chalk.gray(`       • Max:  ${(latencies.max / 1000000 || 0).toFixed(2)}ms`));
    console.log(chalk.gray(`       • P50:  ${(latencies["50th"] / 1000000 || 0).toFixed(2)}ms`));
    console.log(chalk.gray(`       • P95:  ${(latencies["95th"] / 1000000 || 0).toFixed(2)}ms`));
    console.log(chalk.gray(`       • P99:  ${(latencies["99th"] / 1000000 || 0).toFixed(2)}ms`));

    // Data transfer
    if (report.bytes_in || report.bytes_out) {
      console.log(chalk.gray(`     Data Transfer:`));
      if (report.bytes_in) {
        console.log(chalk.gray(`       • Bytes In:  ${report.bytes_in.total || 0} total, ${(report.bytes_in.mean || 0).toFixed(0)} avg`));
      }
      if (report.bytes_out) {
        console.log(chalk.gray(`       • Bytes Out: ${report.bytes_out.total || 0} total, ${(report.bytes_out.mean || 0).toFixed(0)} avg`));
      }
    }

    // Status codes breakdown
    if (Object.keys(statusCodes).length > 0) {
      console.log(chalk.gray(`     Status Codes:`));
      Object.entries(statusCodes).forEach(([code, count]) => {
        const statusColor = parseInt(code) >= 200 && parseInt(code) < 300 ? chalk.green :
                           parseInt(code) >= 400 && parseInt(code) < 500 ? chalk.yellow :
                           parseInt(code) >= 500 ? chalk.red : chalk.gray;
        console.log(statusColor(`       • ${code}: ${count}`));
      });
    }

    // Errors
    if (errors.length > 0) {
      console.log(chalk.red(`     Errors (${errors.length}):`));
      errors.slice(0, 5).forEach((error: string) => {
        console.log(chalk.red(`       • ${error}`));
      });
      if (errors.length > 5) {
        console.log(chalk.red(`       • ... and ${errors.length - 5} more`));
      }
    }

    // Calculate success rate for upload
    const totalRequests = report.requests || 1;
    const successRequests = Object.entries(statusCodes)
      .filter(([code]) => parseInt(code) >= 200 && parseInt(code) < 300)
      .reduce((sum, [, count]) => sum + (count as number), 0);
    const successRate = successRequests / totalRequests;

    // Prepare results for upload - use the newly created execution ID
    const results = {
      executionId: executionId,
      avgLatency: Math.round(latencies.mean || 0),
      p95Latency: Math.round(latencies["95th"] || latencies.mean || 0),
      successRate: successRate,
      timestamp: new Date().toISOString(),
      // Detailed metrics
      minLatency: Math.round(latencies.min || 0),
      maxLatency: Math.round(latencies.max || 0),
      p50Latency: Math.round(latencies["50th"] || 0),
      p99Latency: Math.round(latencies["99th"] || 0),
      requests: report.requests,
      duration: typeof report.duration === 'string' ? report.duration : `${(Number(report.duration) / 1000000000).toFixed(2)}s`,
      rate: report.rate,
      throughput: report.throughput,
      bytesIn: report.bytes_in?.total,
      bytesOut: report.bytes_out?.total,
      statusCodes: statusCodes,
      errors: errors,
    };

    console.log(chalk.cyan(`\n📦 Prepared results object:`));
    console.log(chalk.gray(`  executionId: ${results.executionId}`));
    console.log(chalk.gray(`  avgLatency: ${results.avgLatency} (type: ${typeof results.avgLatency})`));
    console.log(chalk.gray(`  p95Latency: ${results.p95Latency} (type: ${typeof results.p95Latency})`));
    console.log(chalk.gray(`  successRate: ${results.successRate} (type: ${typeof results.successRate})`));
    console.log(chalk.gray(`  timestamp: ${results.timestamp}`));
    console.log(chalk.gray(`  requests: ${results.requests} (type: ${typeof results.requests})`));

    // Create test result in the execution
    const testId = tests[0].id || 'default-test';
    const resultCreated = await createTestResult(executionId, testId, results, token, apiUrl);
    return resultCreated;
}

async function runTest(
  test: ExecutionPlanFile['tests'][0],
  token: string,
  apiUrl: string,
  index: number,
  total: number
): Promise<boolean> {
  console.log(chalk.blue(`\n[${index}/${total}] ${test.name}`));
  
  let attackInput = '';
  let requestCount = 0;
  
  if (test.requests && test.requests.length > 0) {
    // New format: cycle through all requests
    console.log(chalk.gray(`  Cycling through ${test.requests.length} request(s) in order`));
    console.log(chalk.gray(`  RPS: ${test.rps}, Duration: ${test.duration}`));
    
    // Generate attack input with all requests in order - Vegeta will cycle through them
    for (const request of test.requests) {
      let target = `${request.method.toUpperCase()} ${request.target}\n`;
      if (request.headers) {
        for (const [key, value] of Object.entries(request.headers)) {
          target += `${key}: ${value}\n`;
        }
      }
      target += '\n'; // Empty line to separate headers from body
      if (request.body) {
        target += request.body + '\n';
      }
      attackInput += target;
      requestCount++;
    }
  } else if (test.method && test.target) {
    // Legacy format: single request
    console.log(chalk.gray(`  ${test.method} ${test.target}`));
    console.log(chalk.gray(`  RPS: ${test.rps}, Duration: ${test.duration}`));
    console.log(chalk.gray(`  Description: ${test.description || 'N/A'}`));
    
    attackInput = `${test.method.toUpperCase()} ${test.target}\n`;
    requestCount = 1;
  } else {
    throw new Error('Test must have either requests array or method/target');
  }
  
  console.log(chalk.gray(`  Total requests in sequence: ${requestCount}`));
  console.log("");

  // Run vegeta attack and pipe to vegeta report
  const { stdout } = await execa(
      'sh',
      ['-c', `printf '%s' "${attackInput.trim()}" | vegeta attack -rate=${test.rps} -duration=${test.duration} | vegeta report -type=json`],
      {
        stripFinalNewline: true,
        timeout: 300000 // 5 minutes timeout for the test
      }
    );

    // Parse the JSON output
    const report = JSON.parse(stdout);

    console.log(chalk.green(`  ✅ Load test completed`));
    console.log(chalk.gray(`     Requests: ${report.requests || 0}`));
    console.log(chalk.gray(`     Duration: ${report.duration || 'N/A'}`));
    console.log(chalk.gray(`     Rate: ${report.rate || 'N/A'} RPS`));
    console.log(chalk.gray(`     Throughput: ${report.throughput || 'N/A'} req/sec`));
    console.log(chalk.gray(`     Success Rate: ${(report.success * 100 || 0).toFixed(2)}%`));

    // Extract detailed metrics
    const latencies = report.latencies || {};
    const statusCodes = report.status_codes || {};
    const errors = report.errors || [];

    console.log(chalk.cyan(`\n     📊 Detailed Metrics:`));
    
    // Latency metrics
    console.log(chalk.gray(`     Response Times:`));
    console.log(chalk.gray(`       • Mean: ${(latencies.mean / 1000000 || 0).toFixed(2)}ms`));
    console.log(chalk.gray(`       • Min:  ${(latencies.min / 1000000 || 0).toFixed(2)}ms`));
    console.log(chalk.gray(`       • Max:  ${(latencies.max / 1000000 || 0).toFixed(2)}ms`));
    console.log(chalk.gray(`       • P50:  ${(latencies["50th"] / 1000000 || 0).toFixed(2)}ms`));
    console.log(chalk.gray(`       • P95:  ${(latencies["95th"] / 1000000 || 0).toFixed(2)}ms`));
    console.log(chalk.gray(`       • P99:  ${(latencies["99th"] / 1000000 || 0).toFixed(2)}ms`));

    // Data transfer
    if (report.bytes_in || report.bytes_out) {
      console.log(chalk.gray(`     Data Transfer:`));
      if (report.bytes_in) {
        console.log(chalk.gray(`       • Bytes In:  ${report.bytes_in.total || 0} total, ${(report.bytes_in.mean || 0).toFixed(0)} avg`));
      }
      if (report.bytes_out) {
        console.log(chalk.gray(`       • Bytes Out: ${report.bytes_out.total || 0} total, ${(report.bytes_out.mean || 0).toFixed(0)} avg`));
      }
    }

    // Status codes breakdown
    if (Object.keys(statusCodes).length > 0) {
      console.log(chalk.gray(`     Status Codes:`));
      Object.entries(statusCodes).forEach(([code, count]) => {
        const statusColor = parseInt(code) >= 200 && parseInt(code) < 300 ? chalk.green :
                           parseInt(code) >= 400 && parseInt(code) < 500 ? chalk.yellow :
                           parseInt(code) >= 500 ? chalk.red : chalk.gray;
        console.log(statusColor(`       • ${code}: ${count}`));
      });
    }

    // Errors
    if (errors.length > 0) {
      console.log(chalk.red(`     Errors (${errors.length}):`));
      errors.slice(0, 5).forEach((error: string) => {
        console.log(chalk.red(`       • ${error}`));
      });
      if (errors.length > 5) {
        console.log(chalk.red(`       • ... and ${errors.length - 5} more`));
      }
    }

    // Calculate success rate for upload
    const totalRequests = report.requests || 1;
    const successRequests = Object.entries(statusCodes)
      .filter(([code]) => parseInt(code) >= 200 && parseInt(code) < 300)
      .reduce((sum, [, count]) => sum + (count as number), 0);
    const successRate = successRequests / totalRequests;

    // Prepare results for upload
    const results = {
      executionId: test.id,
      avgLatency: Math.round(latencies.mean || 0),
      p95Latency: Math.round(latencies["95th"] || latencies.mean || 0),
      successRate: successRate,
      timestamp: new Date().toISOString(),
      // Detailed metrics
      minLatency: Math.round(latencies.min || 0),
      maxLatency: Math.round(latencies.max || 0),
      p50Latency: Math.round(latencies["50th"] || 0),
      p99Latency: Math.round(latencies["99th"] || 0),
      requests: report.requests,
      duration: typeof report.duration === 'string' ? report.duration : `${(Number(report.duration) / 1000000000).toFixed(2)}s`,
      rate: report.rate,
      throughput: report.throughput,
      bytesIn: report.bytes_in?.total,
      bytesOut: report.bytes_out?.total,
      statusCodes: statusCodes,
      errors: errors,
    };

    // Upload results
    const uploadSuccess = await uploadResults(results, token, apiUrl, test.name);
    return uploadSuccess;
}

async function createTestResult(
  executionId: string,
  testId: string,
  results: any,
  token: string,
  apiUrl: string
): Promise<boolean> {
  try {
    console.log(chalk.cyan('\n📤 Creating test result...'));
    
    const resultData = {
      testId: testId,
      avgLatency: results.avgLatency,
      p95Latency: results.p95Latency,
      successRate: results.successRate,
      timestamp: results.timestamp,
      minLatency: results.minLatency,
      maxLatency: results.maxLatency,
      p50Latency: results.p50Latency,
      p99Latency: results.p99Latency,
      totalRequests: results.requests,
      testDuration: results.duration,
      actualRate: results.rate,
      throughput: results.throughput,
      bytesIn: results.bytesIn,
      bytesOut: results.bytesOut,
      statusCodes: JSON.stringify(results.statusCodes || {}),
      errorDetails: JSON.stringify(results.errors || []),
    };
    
    const response = await axios.post(
      `${apiUrl}/loadtestsexecutions/${executionId}/loadtests`,
      resultData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 10000,
      }
    );

    console.log(chalk.green(`  ✅ Test result created successfully`));
    console.log(chalk.gray(`  Response: ${response.status} ${response.statusText}`));
    return true;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(chalk.red(`  ⚠️  Result creation error:`), error.message);
      if (error.response) {
        console.error(chalk.red(`     Response Status: ${error.response.status} ${error.response.statusText}`));
        console.error(chalk.red(`     Response Data:`, JSON.stringify(error.response.data, null, 2)));
      }
    } else {
      console.error(chalk.red(`  ⚠️  Unexpected error:`, error instanceof Error ? error.message : String(error)));
    }
    return false;
  }
}

async function uploadResults(
  results: any,
  token: string,
  apiUrl: string,
  testName: string
): Promise<boolean> {
  try {
    console.log(chalk.cyan('\n📤 Uploading results...'));
    console.log(chalk.gray('  Request data being sent:'));
    console.log(chalk.gray(JSON.stringify(results, null, 2)));
    
    const response = await axios.post(
      `${apiUrl}/results`,
      results,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 30000, // Increased from 5000ms to 30000ms (30 seconds)
      }
    );

    console.log(chalk.green(`  📊 Results uploaded successfully`));
    console.log(chalk.gray(`  Response: ${response.status} ${response.statusText}`));
    return true;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(chalk.red(`  ⚠️  Upload Error:`), error.message);
      if (error.response) {
        console.error(chalk.red(`     Response Status: ${error.response.status} ${error.response.statusText}`));
        console.error(chalk.red(`     Response Data:`, JSON.stringify(error.response.data, null, 2)));
      } else if (error.request) {
        console.error(chalk.red(`     No response received from server`));
        console.error(chalk.red(`     Request details:`, error.request));
      }
    } else {
      console.error(chalk.red(`  ⚠️  Upload Error:`), error instanceof Error ? error.message : String(error));
      if (error instanceof Error) {
        console.error(chalk.red(`     Stack:`, error.stack));
      }
    }
    // Don't throw - continue with other tests
    return false;
  }
}

async function ensureVegeta(): Promise<void> {
  try {
    // Check if vegeta is available
    await execa('vegeta', ['version'], { timeout: 5000 });
    console.log(chalk.gray('✅ Vegeta is available'));
  } catch (error) {
    console.log(chalk.yellow('⚠️  Vegeta not found, downloading...'));

    // Determine platform
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
      // Download and extract vegeta
      const tempDir = '/tmp/vegeta-install';
      await execa('rm', ['-rf', tempDir]);
      await execa('mkdir', ['-p', tempDir]);

      const tarballPath = `${tempDir}/vegeta.tar.gz`;
      console.log(chalk.gray(`  Downloading from: ${vegetaUrl}`));
      
      // Use curl with better options
      await execa('curl', ['-L', '-f', '-o', tarballPath, vegetaUrl], {
        timeout: 60000 // 1 minute timeout
      });

      // Verify the file was downloaded
      const stats = await fs.stat(tarballPath);
      if (stats.size === 0) {
        throw new Error('Downloaded file is empty');
      }

      console.log(chalk.gray(`  Extracting to: ${tempDir}`));
      await execa('tar', ['-xzf', tarballPath, '-C', tempDir]);

      // Find the vegeta binary (may be in subdirectory)
      let vegetaBinary: string | undefined;
      try {
        const { stdout: findOutput } = await execa('find', [tempDir, '-name', 'vegeta', '-type', 'f']);
        vegetaBinary = findOutput.trim().split('\n')[0];
      } catch {
        // If find fails, try listing directory
        const { stdout: lsOutput } = await execa('ls', ['-la', tempDir]);
        console.log(chalk.gray(`Directory contents:\n${lsOutput}`));
      }

      if (!vegetaBinary) {
        throw new Error('Could not find vegeta binary in downloaded archive');
      }

      console.log(chalk.gray(`  Installing binary: ${vegetaBinary}`));

      // Move to /usr/local/bin (may require sudo)
      try {
        await execa('sudo', ['mv', vegetaBinary, '/usr/local/bin/vegeta']);
        await execa('sudo', ['chmod', '+x', '/usr/local/bin/vegeta']);
        console.log(chalk.green('✅ Vegeta installed to /usr/local/bin'));
      } catch (sudoError) {
        // Try to install to user directory
        const userBinDir = path.join(process.env.HOME || '/tmp', '.local', 'bin');
        await execa('mkdir', ['-p', userBinDir]);
        await execa('cp', [vegetaBinary, `${userBinDir}/vegeta`]);
        await execa('chmod', ['+x', `${userBinDir}/vegeta`]);

        // Add to PATH for this session
        process.env.PATH = `${userBinDir}:${process.env.PATH}`;
        console.log(chalk.green(`✅ Vegeta installed to ${userBinDir}`));
        console.log(chalk.yellow('⚠️  You may need to add ~/.local/bin to your PATH in your shell config'));
      }

      // Cleanup
      await execa('rm', ['-rf', tempDir]);

      console.log(chalk.green('✅ Vegeta installed successfully'));
    } catch (downloadError) {
      console.error(chalk.red('❌ Failed to download Vegeta:'), downloadError instanceof Error ? downloadError.message : String(downloadError));
      throw new Error('Vegeta is required for load testing. Please install it manually: https://github.com/tsenart/vegeta/releases');
    }
  }
}
