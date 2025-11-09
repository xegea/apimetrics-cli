# apimetrics-cli

Secure CLI to run API load tests locally with Vegeta and upload results to [Apimetrics.ai](https://apimetrics.ai).

## ⚙️ Installation

### **Step 1: Install the CLI**
```bash
npm install -g @xegea/apimetrics-cli
```

### **Step 2: Restart your terminal**
After installation, restart your terminal or run:
```bash
source ~/.zshrc  # (or ~/.bashrc if using bash)
```

### **Step 3: Verify installation**
```bash
apimetrics --help
```

## 🧩 Quick Start

### **Step 4: Create a test configuration**
Create a file called `test.json`:
```json
{
  "target": "https://httpbin.org/get",
  "method": "GET",
  "rps": 5,
  "duration": "10s",
  "id": "my-first-test"
}
```

### **Step 5: Run your first load test**
```bash
apimetrics run test.json --token YOUR_JWT_TOKEN
```

## 📋 Complete Example

```bash
# 1. Install
npm install -g @xegea/apimetrics-cli

# 2. Restart terminal
source ~/.zshrc

# 3. Verify
apimetrics --help

# 4. Create test.json
# {
#   "target": "https://your-api.com/endpoint",
#   "method": "GET",
#   "rps": 10,
#   "duration": "30s",
#   "id": "my-test"
# }

# 5. Run test
apimetrics run test.json --token YOUR_JWT_TOKEN --env dev
```

## 🧩 Test Configuration

Create a JSON file with your request configuration:

```json
{
  "target": "https://api.example.com/users",
  "method": "GET",
  "rps": 10,
  "duration": "30s",
  "id": "demo-123"
}
```

### Configuration fields

- `target`: The API endpoint URL to test
- `method`: HTTP method (GET, POST, PUT, DELETE, PATCH)
- `rps`: Requests per second rate
- `duration`: Test duration (e.g., "30s", "5m", "1h")
- `id`: Unique identifier for this test

## 🚀 Usage

### Basic Usage

```bash
# Run a load test and upload results (defaults to prod environment)
apimetrics run ./test.json --token YOUR_JWT_TOKEN

# Run against dev environment
apimetrics run ./test.json --token YOUR_JWT_TOKEN --env dev

# Run against local environment
apimetrics run ./test.json --token YOUR_JWT_TOKEN --env local
```

### Alternative: Using npx

```bash
npx @xegea/apimetrics-cli run ./test.json --token=YOUR_JWT_TOKEN
```

### Environment Configuration

The CLI automatically determines the API endpoint based on the environment:

| Environment | API URL |
|-------------|---------|
| `prod` / `production` (default) | `https://apimetrics.onrender.com` |
| `dev` / `development` | `https://apimetrics.onrender.com` |
| `local` | `http://localhost:3000` |

You can control the environment in these ways:

1. **NODE_ENV environment variable**:
   ```bash
   NODE_ENV=dev apimetrics run test.json --key YOUR_API_KEY
   ```

2. **--env command line flag**:
   ```bash
   apimetrics run test.json --key YOUR_API_KEY --env dev
   ```

3. **APIMETRICS_API_URL environment variable** (overrides all):
   ```bash
   APIMETRICS_API_URL=https://custom-api.com apimetrics run test.json --key YOUR_API_KEY
   ```

4. **--api-url command line flag** (overrides all):
   ```bash
   apimetrics run test.json --key YOUR_API_KEY --api-url https://custom-api.com
   ```

### Options

```bash
apimetrics run <definition> [options]

Options:
  -k, --key <apiKey>     API key for authentication (required)
  --api-url <url>        API endpoint URL (overrides environment-based defaults)
  --env <environment>    Environment (local, dev, prod) - overrides NODE_ENV
  -h, --help             Show help
```

## 📋 Prerequisites

- **Node.js** 18+ installed
- **Vegeta** installed and available in your PATH
  - Install from: https://github.com/tsenart/vegeta
  - Or via Homebrew: `brew install vegeta`

## 🔐 Security

- ✅ Open-source and npm-published
- ✅ Requires user API key
- ✅ No remote code execution
- ✅ Sends only aggregated metrics (no payloads)

## 🛠️ Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Test locally
npm start run test.json --key=abc123
```

## � Troubleshooting

### Command not found after installation
If `apimetrics` command isn't found:
1. **Restart your terminal** (close and reopen)
2. **Or reload your shell config:**
   ```bash
   source ~/.zshrc  # (or ~/.bashrc)
   ```
3. **Check if npm bin directory is in PATH:**
   ```bash
   npm config get prefix
   echo $PATH | grep -o '/.*/bin'
   ```

### Permission issues
If you get permission errors during installation:
```bash
# Try with sudo (not recommended)
sudo npm install -g @xegea/apimetrics-cli

# Or fix npm permissions
npm config set prefix ~/.npm
export PATH="$HOME/.npm/bin:$PATH"
```

## �📦 Publishing

The project is configured to automatically publish to npm when a GitHub release is created. See `.github/workflows/publish.yml` for details.

## 📄 License

MIT
