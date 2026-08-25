// /backend/api-service/mailer.js
import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, FRONTEND_URL } = process.env;

export function buildSpaceInviteUrl(token) {
    const baseUrl = (FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    return `${baseUrl}/#/spaces/invitations/${token}`;
}

const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT || '587', 10),
    secure: (SMTP_PORT === '465'), // true for 465, false for other ports
    ...(SMTP_USER && SMTP_PASS ? {
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS,
        },
    } : {}),
});

export async function sendPasswordResetEmail(to, token) {
    const resetLink = `${FRONTEND_URL || 'http://localhost:5173'}/#/reset-password/${token}`;
    const mailOptions = {
        from: `Panino <${SMTP_FROM}>`,
        to: to,
        subject: 'Your Panino Password Reset Request',
        text: `You requested a password reset. Click this link to reset your password: ${resetLink}\n\nThis link will expire in 1 hour.`,
        html: `<p>You requested a password reset. Click this link to reset your password:</p><p><a href="${resetLink}">${resetLink}</a></p><p>This link will expire in 1 hour.</p>`,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Password reset email sent to ${to}`);
    } catch (error) {
        console.error(`Error sending password reset email to ${to}:`, error);
        // In a real app, you'd have more robust error handling here
    }
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

export async function sendSpaceInviteEmail(to, token, spaceName) {
    const inviteLink = buildSpaceInviteUrl(token);
    const safeLink = escapeHtml(inviteLink);
    const safeSpaceName = escapeHtml(spaceName);
    const mailOptions = {
        from: `Panino <${SMTP_FROM}>`,
        to,
        subject: 'You were invited to a Panino space',
        text: `You were invited to collaborate in “${spaceName}”. Open this link while signed in to the invited email address: ${inviteLink}\n\nThis invitation expires in 7 days.`,
        html: `<p>You were invited to collaborate in <strong>${safeSpaceName}</strong>.</p><p><a href="${safeLink}">Accept invitation</a></p><p>Sign in with the invited email address. This invitation expires in 7 days.</p>`,
    };

    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('[mailer] Failed to send a space invitation:', error?.message || 'unknown error');
        return false;
    }
}
