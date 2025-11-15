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

    // Run each test
    console.log(chalk.cyan(`\n🚀 Starting ${plan.tests.length} test(s)...\n`));

    for (let i = 0; i < plan.tests.length; i++) {
      const test = plan.tests[i];
      await runTest(test, token, apiUrl, i + 1, plan.tests.length);
    }

    console.log(chalk.green(`\n🎉 All tests completed!`));
    console.log(chalk.green(`📊 Results have been uploaded to your ApiMetrics dashboard`));
    console.log(chalk.green(`🌐 View results at: https://apimetrics.ai`));

  } catch (error) {
    console.error(chalk.red("❌ Error:"), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

async function runTest(
  test: ExecutionPlanFile['tests'][0],
  token: string,
  apiUrl: string,
  index: number,
  total: number
): Promise<void> {
  console.log(chalk.blue(`\n[${index}/${total}] ${test.name}`));
  
  let attackInput = '';
  let requestCount = 0;
  
  if (test.requests && test.requests.length > 0) {
    // New format: cycle through all requests
    console.log(chalk.gray(`  Cycling through ${test.requests.length} request(s) in order`));
    console.log(chalk.gray(`  RPS: ${test.rps}, Duration: ${test.duration}`));
    
    // Generate attack input with all requests in order - Vegeta will cycle through them
    for (const request of test.requests) {
      attackInput += `${request.method.toUpperCase()} ${request.target}\n`;
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

  try {
    // Run vegeta attack and pipe to vegeta report
    const { stdout } = await execa(
      'sh',
      ['-c', `echo "${attackInput.trim()}" | vegeta attack -rate=${test.rps} -duration=${test.duration} | vegeta report -type=json`],
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

    // Extract metrics
    const latencies = report.latencies || {};
    const statusCodes = report.status_codes || {};

    // Calculate success rate
    const totalRequests = report.requests || 1;
    const successRequests = Object.entries(statusCodes)
      .filter(([code]) => parseInt(code) >= 200 && parseInt(code) < 300)
      .reduce((sum, [, count]) => sum + (count as number), 0);
    const successRate = successRequests / totalRequests;

    // Prepare results
    const results = {
      executionId: test.id,
      avgLatency: Math.round(latencies.mean || 0),
      p95Latency: Math.round(latencies["95p"] || latencies.mean || 0),
      successRate: successRate,
      timestamp: new Date().toISOString(),
    };

    console.log(chalk.gray(`     Avg Latency: ${results.avgLatency}ns`));
    console.log(chalk.gray(`     P95 Latency: ${results.p95Latency}ns`));
    console.log(chalk.gray(`     Success Rate: ${(successRate * 100).toFixed(2)}%`));

    // Upload results
    await uploadResults(results, token, apiUrl, test.name);

  } catch (error) {
    console.error(chalk.red(`  ❌ Test failed:`), error instanceof Error ? error.message : String(error));
    // Continue with next test instead of failing completely
  }
}

async function uploadResults(
  results: any,
  token: string,
  apiUrl: string,
  testName: string
): Promise<void> {
  try {
    const response = await axios.post(
      `${apiUrl}/results`,
      results,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 5000,
      }
    );

    console.log(chalk.green(`  📊 Results uploaded successfully`));
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(chalk.red(`  ⚠️  Upload Error:`), error.message);
      if (error.response) {
        console.error(chalk.red(`     Response: ${error.response.status} ${error.response.statusText}`));
      }
    } else {
      console.error(chalk.red(`  ⚠️  Upload Error:`), error instanceof Error ? error.message : String(error));
    }
    // Don't throw - continue with other tests
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
