import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Provider } from "./types.js";
import { errMsg, isFileNotFound } from "./utils/errors.js";
import { createLogger } from "./utils/logger.js";
import { clawHome } from "./utils/paths.js";

// --- OpenAI Codex OAuth constants (from pi-ai/oauth/openai-codex.js) ---
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_SCOPE = "openid profile email offline_access";
const OPENAI_JWT_CLAIM_PATH = "https://api.openai.com/auth";

const AUTH_DIR = clawHome("auth");
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

interface StoredAuth {
  provider: Provider;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  account_id: string;
}

/**
 * PKCE OAuth token provider for OpenAI Codex (ChatGPT subscription).
 */
export class TokenProvider {
  private readonly log;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt: number = 0;
  private accountId: string | null = null;

  constructor(private readonly provider: Provider) {
    this.log = createLogger(`auth:${provider}`);
  }

  private get authFile(): string {
    return path.join(AUTH_DIR, `${this.provider}.json`);
  }

  /** Load stored credentials, or run interactive login if none exist. */
  async init(): Promise<void> {
    const stored = this.readStored();
    if (stored) {
      this.accessToken = stored.access_token;
      this.refreshToken = stored.refresh_token;
      this.expiresAt = stored.expires_at;
      this.accountId = stored.account_id;
      this.log.info(`Loaded stored token, expires ${new Date(this.expiresAt).toISOString()}`);
      return;
    }

    this.log.info("No stored credentials found. Starting OAuth login...");
    await this.login();
  }

  /** Get a valid access token, refreshing if needed. */
  async getToken(): Promise<string> {
    if (!this.accessToken || !this.refreshToken) {
      throw new Error("Token provider not initialized. Call init() first.");
    }

    if (Date.now() >= this.expiresAt - EXPIRY_BUFFER_MS) {
      await this.refresh();
    }

    return this.accessToken;
  }

  /** Get the ChatGPT account ID (OpenAI only, extracted from JWT). */
  getAccountIdSync(): string {
    return this.accountId ?? "";
  }

  // ─── Login ───────────────────────────────────────────────────────────

  private async login(): Promise<void> {
    await this.loginOpenAI();
  }

  private async loginOpenAI(): Promise<void> {
    const { verifier, challenge } = await generatePKCE();
    const state = randomBytes(16).toString("hex");

    const url = new URL(OPENAI_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", OPENAI_CLIENT_ID);
    url.searchParams.set("redirect_uri", OPENAI_REDIRECT_URI);
    url.searchParams.set("scope", OPENAI_SCOPE);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", "clawarts");

    const code = await this.startCallbackServer({
      port: 1455,
      callbackPath: "/auth/callback",
      expectedState: state,
      authorizeUrl: url.toString(),
    });
    if (!code) throw new Error("OAuth login failed: no authorization code received");

    const resp = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: OPENAI_REDIRECT_URI,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token exchange failed (${resp.status}): ${text}`);
    }

    const result = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const accountId = this.extractOpenAIAccountId(result.access_token) ?? "";
    this.saveTokens(result.access_token, result.refresh_token, result.expires_in, accountId);
    this.log.info("OAuth login successful");
  }

  // ─── Callback server ─────────────────────────────────────────────────

  private startCallbackServer(opts: {
    port: number;
    callbackPath: string;
    expectedState: string;
    authorizeUrl: string;
  }): Promise<string | null> {
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (code: string | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        server.close();
        resolve(code);
      };

      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "", "http://localhost");
        if (url.pathname !== opts.callbackPath) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        if (url.searchParams.get("state") !== opts.expectedState) {
          res.writeHead(400);
          res.end("State mismatch");
          return;
        }
        const code = url.searchParams.get("code");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Authentication complete. You can close this window.</h2></body></html>");
        finish(code);
      });

      server.listen(opts.port, "127.0.0.1", async () => {
        this.log.info(`Open this URL in your browser to log in:\n\n  ${opts.authorizeUrl}\n`);
        try {
          const { execFile } = await import("node:child_process");
          const cmd = process.platform === "darwin" ? "open" : "xdg-open";
          execFile(cmd, [opts.authorizeUrl]);
        } catch {
          // User will open manually
        }
      });

      server.on("error", () => {
        this.log.error(`Failed to bind port ${opts.port}. Please complete login manually.`);
        finish(null);
      });

      const timer = setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);
      if (timer.unref) timer.unref();
    });
  }

  // ─── Refresh ──────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    this.log.info("Refreshing OAuth token...");
    const resp = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: OPENAI_CLIENT_ID,
        refresh_token: this.refreshToken!,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token refresh failed (${resp.status}): ${text}`);
    }

    const result = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const accountId = this.extractOpenAIAccountId(result.access_token) ?? "";
    this.saveTokens(result.access_token, result.refresh_token, result.expires_in, accountId);
    this.log.info(`Token refreshed, expires ${new Date(this.expiresAt).toISOString()}`);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private saveTokens(accessToken: string, refreshToken: string, expiresIn: number, accountId: string): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.expiresAt = Date.now() + expiresIn * 1000;
    this.accountId = accountId;

    this.writeStored({
      provider: this.provider,
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: this.expiresAt,
      account_id: accountId,
    });
  }

  private extractOpenAIAccountId(token: string): string | null {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
      return payload?.[OPENAI_JWT_CLAIM_PATH]?.chatgpt_account_id ?? null;
    } catch {
      return null;
    }
  }

  private readStored(): StoredAuth | null {
    try {
      return JSON.parse(fs.readFileSync(this.authFile, "utf-8")) as StoredAuth;
    } catch (err) {
      // ENOENT is expected on first run — only warn on real errors (corrupted file, permission denied)
      if (isFileNotFound(err)) return null;
      this.log.warn(`Corrupted auth file ${this.authFile}, will re-login:`, errMsg(err));
      return null;
    }
  }

  private writeStored(data: StoredAuth): void {
    const tmp = this.authFile + `.tmp.${process.pid}`;
    try {
      fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
      // Atomic write: temp + rename to prevent credential corruption on crash
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, this.authFile);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      this.log.warn("Failed to write auth file:", errMsg(err));
    }
  }
}

/** Generate PKCE verifier + challenge (S256). */
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBytes(32)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9\-._~]/g, "");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}
