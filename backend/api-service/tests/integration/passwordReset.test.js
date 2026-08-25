// Integration tests for password reset endpoints
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createTestApp, setupTestUser, cleanupTestUser } from '../testHelpers.js';
import { getAuthDb } from '../../db.js';

// Mock the mailer module
vi.mock('../../mailer.js', () => ({
    sendPasswordResetEmail: vi.fn(),
    sendSpaceInviteEmail: vi.fn()
}));

import { sendPasswordResetEmail } from '../../mailer.js';

describe('POST /forgot-password', () => {
    let app, server;
    let testUser;

    beforeAll(() => {
        const result = createTestApp();
        app = result.app;
        server = result.server;
    });

    beforeEach(async () => {
        testUser = await setupTestUser('forgot-password-test@example.com', 'password123');
        vi.clearAllMocks();
    });

    afterEach(() => {
        if (testUser) {
            cleanupTestUser(testUser.userId);
        }
    });

    afterAll(() => {
        return new Promise((resolve) => {
            if (server) {
                server.close(() => resolve());
            } else {
                resolve();
            }
        });
    });

    it('should always return a 200 success message for an existing user', async () => {
        const response = await request(app)
            .post('/forgot-password')
            .send({ email: testUser.email });

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('message');
        expect(response.body.message).toContain('If an account with that email exists');
    });

    it('should call sendPasswordResetEmail with the correct arguments for an existing user', async () => {
        await request(app)
            .post('/forgot-password')
            .send({ email: testUser.email });

        expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
        expect(sendPasswordResetEmail).toHaveBeenCalledWith(
            testUser.email,
            expect.any(String)
        );
    });

    it('should create a valid password_resets token in the database', async () => {
        await request(app)
            .post('/forgot-password')
            .send({ email: testUser.email });

        const db = getAuthDb();
        const resetRequest = db.prepare('SELECT * FROM password_resets WHERE user_id = ?').get(testUser.userId);

        expect(resetRequest).toBeDefined();
        expect(resetRequest.token_hash).toBeDefined();
        expect(resetRequest.expires_at).toBeDefined();

        // Verify the token hasn't expired
        const expiresAt = new Date(resetRequest.expires_at);
        expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('should always return a 200 success message for a non-existent user', async () => {
        const response = await request(app)
            .post('/forgot-password')
            .send({ email: 'nonexistent@example.com' });

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('message');
        expect(response.body.message).toContain('If an account with that email exists');
    });

    it('should NOT call sendPasswordResetEmail for a non-existent user', async () => {
        await request(app)
            .post('/forgot-password')
            .send({ email: 'nonexistent@example.com' });

        expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    });
});

describe('POST /reset-password', () => {
    let app, server;
    let testUser;
    let resetToken;

    beforeAll(() => {
        const result = createTestApp();
        app = result.app;
        server = result.server;
    });

    beforeEach(async () => {
        testUser = await setupTestUser('reset-password-test@example.com', 'password123');

        // Create a valid reset token
        resetToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now

        const db = getAuthDb();
        db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
            .run(tokenHash, testUser.userId, expiresAt);
    });

    afterEach(() => {
        if (testUser) {
            cleanupTestUser(testUser.userId);
        }
    });

    afterAll(() => {
        return new Promise((resolve) => {
            if (server) {
                server.close(() => resolve());
            } else {
                resolve();
            }
        });
    });

    it('should successfully reset the password with a valid token', async () => {
        const response = await request(app)
            .post('/reset-password')
            .send({
                token: resetToken,
                newPassword: 'newpassword456'
            });

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('message');
        expect(response.body.message).toContain('reset successfully');
    });

    it('should allow login with the new password after reset', async () => {
        // Reset password
        await request(app)
            .post('/reset-password')
            .send({
                token: resetToken,
                newPassword: 'newpassword456'
            });

        // Try logging in with old password (should fail)
        const oldPasswordResponse = await request(app)
            .post('/login')
            .send({
                email: testUser.email,
                password: 'password123'
            });
        expect(oldPasswordResponse.status).toBe(401);

        // Try logging in with new password (should succeed)
        const newPasswordResponse = await request(app)
            .post('/login')
            .send({
                email: testUser.email,
                password: 'newpassword456'
            });
        expect(newPasswordResponse.status).toBe(200);
        expect(newPasswordResponse.body).toHaveProperty('token');
    });

    it('should delete the reset token after successful use', async () => {
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

        await request(app)
            .post('/reset-password')
            .send({
                token: resetToken,
                newPassword: 'newpassword456'
            });

        const db = getAuthDb();
        const resetRequest = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(tokenHash);

        expect(resetRequest).toBeUndefined();
    });

    it('should reject with 400 for an invalid or malformed token', async () => {
        const response = await request(app)
            .post('/reset-password')
            .send({
                token: 'invalid-token',
                newPassword: 'newpassword456'
            });

        expect(response.status).toBe(400);
        expect(response.body).toHaveProperty('error');
    });

    it('should reject with 400 for an expired token', async () => {
        // Create an expired token
        const expiredToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(expiredToken).digest('hex');
        const expiresAt = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago

        const db = getAuthDb();
        db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
            .run(tokenHash, testUser.userId, expiresAt);

        const response = await request(app)
            .post('/reset-password')
            .send({
                token: expiredToken,
                newPassword: 'newpassword456'
            });

        expect(response.status).toBe(400);
        expect(response.body).toHaveProperty('error');
        expect(response.body.error).toContain('expired');
    });

    it('should reject with 400 if the new password is too short', async () => {
        const response = await request(app)
            .post('/reset-password')
            .send({
                token: resetToken,
                newPassword: 'short'
            });

        expect(response.status).toBe(400);
        expect(response.body).toHaveProperty('error');
        expect(response.body.error).toContain('6 characters');
    });
});
