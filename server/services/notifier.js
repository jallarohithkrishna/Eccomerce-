/**
 * Notifier Service — PS-01 Phase C2
 *
 * Delivers in-app notifications (saved to returns/{id}/messages in the same
 * Firestore batch as any accompanying write) and mock emails.
 *
 * Every call is an audit event (the caller is responsible for recording it).
 *
 * In a real deployment, replace `_sendEmail` with calls to SendGrid, SES, etc.
 * The interface stays the same.
 */

import * as returnStore from '../returns/store.js';

/**
 * Send an in-app message to a return thread AND a mock email.
 * The in-app message is persisted to returns/{id}/messages.
 *
 * @param {object}       opts
 * @param {object|null}  opts.db          – Firestore Admin SDK instance (or null)
 * @param {string}       opts.returnId    – the return case ID
 * @param {string}       opts.toUserId    – the recipient's UID
 * @param {string}       opts.toEmail     – the recipient's email address
 * @param {string}       opts.subject     – notification subject / headline
 * @param {string}       opts.body        – notification body text
 * @param {string}       [opts.sender]    – sender label, default 'system'
 * @returns {Promise<{ messageId: string, emailSent: boolean }>}
 */
export async function notify({
  db,
  returnId,
  toUserId,
  toEmail,
  subject,
  body,
  sender = 'system',
} = {}) {
  if (!returnId) throw new Error('notify: returnId is required');
  if (!body) throw new Error('notify: body is required');

  // 1. Persist in-app message to returns/{id}/messages
  const msg = await returnStore.appendReturnMessage({
    db,
    returnId,
    message: {
      sender,
      toUserId: toUserId || null,
      subject: subject || 'Update on your return',
      text: body,
      type: 'notification',
      read: false,
    },
  });

  // 2. Mock email — in production replace with a real email provider call.
  const emailSent = await _sendEmail({ toEmail, subject, body });

  return {
    messageId: msg.id,
    returnId,
    emailSent,
  };
}

/**
 * Internal mock email sender.
 * Logs to stdout in development; always returns true (success).
 * Replace this implementation with a real provider in production.
 * @returns {Promise<boolean>}
 */
async function _sendEmail({ toEmail, subject, body }) {
  if (process.env.NODE_ENV !== 'test') {
    console.log(`[notifier] Mock email → ${toEmail} | subject: ${subject} | body: ${body?.slice(0, 80)}`);
  }
  return true;
}
