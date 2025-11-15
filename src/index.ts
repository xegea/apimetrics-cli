#!/usr/bin/env node

import { Command } from "commander";
import { runCommand } from "./commands/run.js";
import { executeCommand } from "./commands/execute.js";
import { executePlanCommand } from "./commands/execute-plan.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let version = "0.2.5"; // fallback version
try {
  const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
  version = packageJson.version;
} catch (error) {
  // If package.json not found, use fallback version
  console.warn("Could not read package.json, using fallback version:", version);
}

// Determine default API URL based on environment
function getDefaultApiUrl(): string {
  // Check if explicitly set in environment
  if (process.env.APIMETRICS_API_URL) {
    return process.env.APIMETRICS_API_URL;
  }
  
  // Default based on NODE_ENV
  const env = process.env.NODE_ENV || 'local';
  
  switch (env.toLowerCase()) {
    case 'development':
    case 'dev':
      return 'https://apimetrics.onrender.com';
    case 'production':
    case 'prod':
      return 'https://apimetrics.onrender.com';
    case 'local':
    default:
      return 'http://localhost:3000';
  }
}

const program = new Command();

program
  .name("apimetrics")
  .description("Run and upload API load tests using Vegeta")
  .version(version);

program
  .command("run <definition>")
  .description("Run a single API request and upload results")
  .option("-t, --token <jwtToken>", "JWT token for authentication")
  .option("--api-url <url>", "API endpoint URL (overrides environment-based defaults)")
  .option("--env <environment>", "Environment (local, dev, prod) - overrides NODE_ENV")
  .action(runCommand);

program
  .command("execute-plan <planFile>")
  .description("Execute a load test plan from a JSON file (downloaded from dashboard)")
  .option("--api-url <url>", "API endpoint URL (overrides environment-based defaults)")
  .option("--env <environment>", "Environment (local, dev, prod) - overrides NODE_ENV")
  .action(executePlanCommand);

program.parse();
