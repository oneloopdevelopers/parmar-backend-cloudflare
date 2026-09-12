export const logger = {
  info: (message: string, meta?: unknown) => {
    console.log(`[INFO] [${new Date().toISOString()}] ${message}`, meta !== undefined ? meta : '');
  },
  warn: (message: string, meta?: unknown) => {
    console.warn(`[WARN] [${new Date().toISOString()}] ${message}`, meta !== undefined ? meta : '');
  },
  error: (message: string, error?: unknown) => {
    console.error(`[ERROR] [${new Date().toISOString()}] ${message}`, error !== undefined ? error : '');
  },
  debug: (message: string, meta?: unknown) => {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[DEBUG] [${new Date().toISOString()}] ${message}`, meta !== undefined ? meta : '');
    }
  }
};
