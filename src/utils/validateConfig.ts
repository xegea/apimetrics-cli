export function validateConfig(cfg: any): void {
  const required = ["target", "method", "rps", "duration", "id"];
  for (const key of required) {
    if (!cfg[key]) {
      throw new Error(`Missing required field: ${key}`);
    }
  }

  const validMethods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
  if (!validMethods.includes(cfg.method.toUpperCase())) {
    throw new Error("Invalid HTTP method");
  }

  if (typeof cfg.rps !== 'number' || cfg.rps <= 0) {
    throw new Error("rps must be a positive number");
  }

  if (typeof cfg.duration !== 'string' || !cfg.duration.match(/^\d+[smh]$/)) {
    throw new Error("duration must be a string like '30s', '5m', '1h'");
  }
}
