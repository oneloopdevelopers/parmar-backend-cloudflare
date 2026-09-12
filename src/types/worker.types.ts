/**
 * Cloudflare Workers Environment Bindings and Context Types
 */

export interface Env {
  FIREBASE_PROJECT_ID?: string;
  NODE_ENV?: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  [key: string]: unknown;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
