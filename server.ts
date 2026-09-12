import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { app } from './src/app.ts';
import { config } from './src/config/environment';
import { logger } from './src/utils/logger';

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;

  // Mount Vite middleware for development or static build for production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // Express 4 wildcard fallback for client SPA
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Backend API server running on http://0.0.0.0:${PORT}`);
    logger.info(`Health check available at http://0.0.0.0:${PORT}/api/health`);
    logger.info(`Profile endpoint available at http://0.0.0.0:${PORT}/api/profile`);
  });
}

startServer().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});

export { app, startServer };
