#!/usr/bin/env node

import { Command } from "commander";
import { runCommand } from "./commands/run.js";

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
  .version("0.1.0");

program
  .command("run <definition>")
  .description("Run a single API request and upload results")
  .option("-t, --token <jwtToken>", "JWT token for authentication")
  .option("--api-url <url>", "API endpoint URL (overrides environment-based defaults)")
  .option("--env <environment>", "Environment (local, dev, prod) - overrides NODE_ENV")
  .action(runCommand);

program.parse();
