# apimetrics-cli

Secure CLI to run API load tests locally with Vegeta and upload results to [Apimetrics.ai](https://apimetrics.ai).

## ⚙️ Installation

```bash
npm install -g apimetrics-cli

# or

npx apimetrics-cli run ./test.json --token=YOUR_JWT_TOKEN
```

## 🧩 Example test definition

Create a JSON file (e.g., `test.json`) with your request configuration:

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
# Run a load test and upload results
apimetrics run ./test.json --token=YOUR_JWT_TOKEN

# Or using npx
npx apimetrics-cli run ./test.json --token=YOUR_JWT_TOKEN
```

### Environment Configuration

The CLI automatically determines the API endpoint based on the environment:

| Environment | API URL |
|-------------|---------|
| `local` (default) | `http://localhost:3000` |
| `dev` / `development` | `https://apimetrics.onrender.com` |
| `prod` / `production` | `https://apimetrics.onrender.com` |

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

## 📦 Publishing

The project is configured to automatically publish to npm when a GitHub release is created. See `.github/workflows/publish.yml` for details.

## 📄 License

MIT
