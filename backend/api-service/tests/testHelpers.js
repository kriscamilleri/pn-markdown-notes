// Test helper utilities
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createApp } from '../index.js';
import { v4 as uuidv4 } from 'uuid';
import { getAuthDb, deleteTestDb } from '../db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-for-dev';

export function createTestApp() {
    const { app, server, wss, clients, collabManager } = createApp();
    return { app, server, wss, clients, collabManager };
}

export function getTestToken(userId) {
    return jwt.sign({ user_id: userId }, JWT_SECRET);
}

export async function setupTestUser(email, password) {
    const db = getAuthDb();
    const userId = uuidv4();
    const hash = bcrypt.hashSync(password, 10);

    db.prepare(`
        INSERT INTO users (id, name, email, password_hash, created_at)
        VALUES (?, ?, ?, ?, datetime('now'))
    `).run(userId, 'Test User', email, hash);

    return { userId, email, password };
}

export function cleanupTestUser(userId) {
    const db = getAuthDb();
    try {
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    } catch (e) {
        console.error(`Error cleaning up test user ${userId}:`, e);
    }
    deleteTestDb(userId);
}

export function generateSiteId(char = 'a') {
    return char.repeat(32); // 16-byte hex string
}
