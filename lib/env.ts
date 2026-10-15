/**
 * Environment variable validation and access.
 * All Kite credentials are server-side only. Never import this in client components.
 */

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        `Copy .env.example to .env.local and fill in the value.`
    );
  }
  return value.trim();
}

export function getKiteApiKey(): string {
  return requireEnv("KITE_API_KEY");
}

export function getKiteApiSecret(): string {
  return requireEnv("KITE_API_SECRET");
}

export function getKiteRedirectUrl(): string {
  return requireEnv("KITE_REDIRECT_URL");
}

/**
 * Returns true if all required Kite environment variables are configured.
 * Does NOT throw — safe to use for status checks.
 */
export function areKiteEnvVarsSet(): boolean {
  return (
    Boolean(process.env.KITE_API_KEY?.trim()) &&
    Boolean(process.env.KITE_API_SECRET?.trim()) &&
    Boolean(process.env.KITE_REDIRECT_URL?.trim())
  );
}
