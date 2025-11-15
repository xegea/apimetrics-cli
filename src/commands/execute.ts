import { execa } from "execa";
import axios from "axios";
import chalk from "chalk";

interface RunOptions {
  token?: string;
  apiUrl?: string;
  env?: string;
}

export async function executeCommand(options: RunOptions): Promise<void> {
  // Determine API URL based on environment and options
  let apiUrl: string;
  
  if (options.apiUrl) {
    apiUrl = options.apiUrl;
  } else {
    const env = options.env || process.env.NODE_ENV || 'prod';
    const envApiUrls: Record<string, string> = {
      local: 'http://localhost:3000',
      dev: 'https://apimetrics.onrender.com',
      development: 'https://apimetrics.onrender.com',
      prod: 'https://apimetrics.onrender.com',
      production: 'https://apimetrics.onrender.com'
    };
    apiUrl = envApiUrls[env.toLowerCase()] || 'http://localhost:3000';
  }

  console.log(chalk.cyan(`🌐 API URL: ${apiUrl}`));
  
  // Read configuration from environment variables
  const target = process.env.APIMETRICS_TARGET;
  const method = process.env.APIMETRICS_METHOD || 'GET';
  const rps = parseInt(process.env.APIMETRICS_RPS || '10');
  const duration = process.env.APIMETRICS_DURATION || '30s';
  const id = process.env.APIMETRICS_ID || `embedded-${Date.now()}`;
  const token = options.token || process.env.APIMETRICS_TOKEN;

  // Validate required fields
  if (!target) {
    console.error(chalk.red('❌ Error: APIMETRICS_TARGET environment variable is required'));
    process.exit(1);
  }

  console.log(chalk.cyan(`🚀 Running load test on ${target} with ${rps} RPS for ${duration}`));

  // Check if Vegeta is available
  try {
    await execa('vegeta', ['version'], { timeout: 5000 });
  } catch (error) {
    console.error(chalk.red('❌ Vegeta is not installed. Please install it first:'));
    console.error(chalk.red('  https://github.com/tsenart/vegeta'));
    process.exit(1);
  }

  // Run Vegeta load test
  const attackInput = `${method.toUpperCase()} ${target}\n`;
  
  let results: { avgLatency: number; p95Latency: number; successRate: number; timestamp: string };
  
  try {
    const { stdout } = await execa(
      'sh',
      ['-c', `echo "${attackInput.trim()}" | vegeta attack -rate=${rps} -duration=${duration} | vegeta report -type=json`],
      { 
        stripFinalNewline: true,
        timeout: 60000
      }
    );
    
    const report = JSON.parse(stdout);
    
    console.log(chalk.green(`✅ Load test completed`));
    console.log(chalk.gray(`Requests: ${report.requests || 0}`));
    console.log(chalk.gray(`Duration: ${report.duration || 'N/A'}`));
    
    const latencies = report.latencies || {};
    const statusCodes = report.status_codes || {};
    
    const totalRequests = report.requests || 1;
    const successRequests = Object.entries(statusCodes)
      .filter(([code]) => parseInt(code) >= 200 && parseInt(code) < 300)
      .reduce((sum, [, count]) => sum + (count as number), 0);
    const successRate = successRequests / totalRequests;
    
    results = {
      avgLatency: Math.round(latencies.mean || 0),
      p95Latency: Math.round(latencies["95p"] || latencies.mean || 0),
      successRate: successRate,
      timestamp: new Date().toISOString(),
    };

  } catch (error) {
    console.error(chalk.red("❌ Load test failed:"), error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // Upload results to API
  if (!token) {
    console.log(chalk.yellow('⚠️  No token provided. Skipping result upload.'));
    return;
  }

  console.log(chalk.blue("📊 Uploading results..."));

  try {
    const response = await axios.post(
      `${apiUrl}/results`,
      {
        executionId: id.replace(/-\d+$/, ''),
        avgLatency: results.avgLatency,
        p95Latency: results.p95Latency,
        successRate: results.successRate,
        timestamp: results.timestamp,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 30000, // Increased from 5000ms to 30000ms (30 seconds)
      }
    );

    console.log(chalk.green("✅ Results successfully uploaded"));
  } catch (uploadErr) {
    console.error(chalk.red("❌ Upload failed:"), uploadErr instanceof Error ? uploadErr.message : String(uploadErr));
    process.exit(1);
  }
}
