/**
 * Cloudflare Workers Environment Bindings and Context Types
 */

export interface KVNamespace {
  get(key: string, options?: any): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list?(options?: any): Promise<any>;
}

export type KVNamespaceLike = KVNamespace;

export interface Env {
  FIREBASE_PROJECT_ID?: string;
  NODE_ENV?: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY?: string;
  GOOGLE_OAUTH_SETUP_KEY?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  GOOGLE_OAUTH_STATE?: KVNamespace;
  DOCUMENT_PASSWORD_ENCRYPTION_KEY?: string;
  [key: string]: unknown;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
