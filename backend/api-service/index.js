// /backend/api-service/index.js
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import { authRoutes, authenticateToken } from './auth.js';
import { syncRoutes } from './sync.js';
import { imageRoutes, startImageOrphanPruneJob } from './image.js';
import { pdfRoutes } from './pdf.js'; // Import the new route
import { signupRoutes } from './signup.js';
import { passwordResetRoutes } from './passwordReset.js';
import { backupPublicRoutes, backupRoutes } from './backup.js';
import { closeAllConnections, initDb } from './db.js';
import { revisionRoutes, startRevisionMaintenanceJob } from './revision.js';
import { attachWebSocketHandlers } from './websocket.js';
import { spaceRoutes, startSpaceDeletionJob } from './spaces.js';
import { spaceTransferRoutes } from './spaceTransfer.js';
import { startCollabRecoveryJob } from './collab.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

initDb();
// Test suites exercise each scheduler explicitly. Process-wide background
// sweeps would race fixture teardown and can open databases another test has
// just removed, so only the real service starts recurring maintenance here.
if (process.env.NODE_ENV !== 'test') {
    startImageOrphanPruneJob();
    startRevisionMaintenanceJob();
    startSpaceDeletionJob();
    startCollabRecoveryJob();
}

const PORT = process.env.PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-for-dev';

/**
 * Create and configure the Express app with WebSocket support
 * @returns {Object} { app, server, wss, clients }
 */
export function createApp() {
    const app = express();

    // Add CORP header to all responses to comply with frontend's COEP policy
    app.use((req, res, next) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        next();
    });

    const server = createServer(app); // Create an HTTP server
    const wss = new WebSocketServer({ server }); // Create a WebSocket server

    const clients = new Map();

    const collabManager = attachWebSocketHandlers(wss, clients, JWT_SECRET);

    // Middleware to attach WebSocket server and clients to requests
    app.use((req, res, next) => {
        req.wss = wss;
        req.clients = clients;
        next();
    });

    app.use(cors());
    app.use(express.json({ limit: '50mb' }));

    // --- Routes ---
    // Public routes
    app.use(signupRoutes);
    app.use(passwordResetRoutes);
    app.use(backupPublicRoutes);

    // Routes that are mixed public/private
    app.use(authRoutes);

    // Authenticated routes
    app.use(authenticateToken);
    app.use(syncRoutes);
    app.use(spaceRoutes);
    app.use(spaceTransferRoutes);
    app.use(imageRoutes);
    app.use(pdfRoutes); // Mount the new PDF route
    app.use(backupRoutes);
    app.use(revisionRoutes);

    return { app, server, wss, clients, collabManager };
}

// Only start the server if this file is run directly (not imported)
if (import.meta.url === `file://${process.argv[1]}`) {
    const { server, wss, collabManager } = createApp();
    server.listen(PORT, () => {
        console.log(`API and WebSocket services listening on port ${PORT}`);
    });

    let shuttingDown = false;
    process.on('SIGTERM', async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        server.close();
        wss.close();
        const result = await collabManager.shutdown({ deadlineMs: 12_000 });
        if (result.unflushed > 0) {
            console.error(`[collab] shutdown left ${result.unflushed} recoverable session(s) unflushed`);
            process.exitCode = 1;
        }
        closeAllConnections();
        process.exit();
    });
}
