import { execa } from "execa";
import axios from "axios";
import fs from "fs/promises";
import path from "path";
import chalk from "chalk";
import { validateConfig } from "../utils/validateConfig.js";

interface Config {
  target: string;
  method: string;
  rps: number;
  duration: string;
  id: string;
}

interface RunOptions {
  token?: string;
  apiUrl?: string;
  env?: string;
}

export async function runCommand(definitionPath: string, options: RunOptions): Promise<void> {
    // Determine API URL based on environment and options
    let apiUrl: string;
    
    if (options.apiUrl) {
      // Explicitly provided API URL takes precedence
      apiUrl = options.apiUrl;
    } else {
      // Determine based on environment
      const env = options.env || process.env.NODE_ENV || 'local';
      
      const envApiUrls = {
        local: 'http://localhost:3000',
        dev: 'https://apimetrics.onrender.com',
        development: 'https://apimetrics.onrender.com',
        prod: 'https://apimetrics.onrender.com',
        production: 'https://apimetrics.onrender.com'
      };
      
      apiUrl = envApiUrls[env.toLowerCase() as keyof typeof envApiUrls] || 'http://localhost:3000';
    }

    console.log(chalk.cyan(`🌐 API URL: ${apiUrl}`));
    console.log(chalk.gray(`📍 Environment: ${options.env || process.env.NODE_ENV || 'local'}`));

    const config: Config = JSON.parse(await fs.readFile(definitionPath, "utf8"));
    validateConfig(config);

    console.log(chalk.cyan(`🚀 Running load test on ${config.target} with ${config.rps} RPS for ${config.duration}`));

    // Run Vegeta load test
    const attackInput = `${config.method.toUpperCase()} ${config.target}\n`;
    
    let results: { avgLatency: number; p95Latency: number; successRate: number; timestamp: string };
    
    try {
      // Run vegeta attack and pipe to vegeta report
      const { stdout } = await execa(
        'sh',
        ['-c', `echo "${attackInput.trim()}" | vegeta attack -rate=${config.rps} -duration=${config.duration} | vegeta report -type=json`],
        { 
          stripFinalNewline: true,
          timeout: 60000 // 1 minute timeout for the test
        }
      );
      
      // Parse the JSON output
      const report = JSON.parse(stdout);
      
      console.log(chalk.green(`✅ Load test completed`));
      console.log(chalk.gray(`Requests: ${report.requests || 0}`));
      console.log(chalk.gray(`Duration: ${report.duration || 'N/A'}`));
      console.log(chalk.gray(`Rate: ${report.rate || 'N/A'} RPS`));
      
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
      results = {
        avgLatency: Math.round((latencies.mean || 0) * 1000000), // Convert to nanoseconds
        p95Latency: Math.round((latencies["95p"] || latencies.mean || 0) * 1000000),
        successRate: successRate,
        timestamp: new Date().toISOString(),
      };

    } catch (error) {
      console.error(chalk.red("❌ Load test failed:"), error instanceof Error ? error.message : String(error));
      throw error;
    }

    console.log(chalk.blue("📊 Sending results..."));

      // Upload results to Apimetrics backend
      try {
        const headers: any = {};
        
        // Add authorization header if token is provided
        if (options.token) {
          headers.Authorization = `Bearer ${options.token}`;
        }
        
        const response = await axios.post(
          `${apiUrl}/results`,
          {
            id: config.id,
            avgLatency: results.avgLatency,
            p95Latency: results.p95Latency,
            successRate: results.successRate,
            timestamp: results.timestamp,
          },
          {
            headers,
            timeout: 5000,
          }
        );

        console.log(chalk.green("📊 Results successfully uploaded."));
        console.log(chalk.gray(`Response: ${response.status} ${response.statusText}`));
      } catch (uploadErr) {
        if (axios.isAxiosError(uploadErr)) {
          console.error(chalk.red("❌ Upload Error:"), uploadErr.message);
          if (uploadErr.response) {
            console.error(chalk.red("Response:"), uploadErr.response.status, uploadErr.response.statusText);
            console.error(chalk.red("Details:"), JSON.stringify(uploadErr.response.data));
          } else if (uploadErr.request) {
            console.error(chalk.red("No response from server"));
          }
        } else {
          console.error(chalk.red("❌ Upload Error:"), uploadErr instanceof Error ? uploadErr.message : String(uploadErr));
        }
        throw uploadErr;
      }
    }
