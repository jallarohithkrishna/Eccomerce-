/**
 * Notifications Hook & Transition Test Suite — PS-01 Phase C5
 *
 * Verifies Item 1 requirements:
 * 1. Single transition helper hook: after a successful transition, calls notify()
 *    with a template per target state (APPROVED, REJECTED, NEEDS_INFO, PICKUP_SCHEDULED,
 *    IN_TRANSIT, RECEIVED, REFUND_PROCESSING, COMPLETED, HUMAN_REVIEW, CLOSED_STALE).
 * 2. Text is built only from fields of the return record.
 * 3. Each transition creates one message.
 * 4. Numbers in the message exist in the record.
 * 5. Replay adds nothing (one message per transition, none on replay).
 * 6. A notify failure never blocks a transition.
 */

import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import * as returnStore from '../returns/store.js';
import { transitionReturn, STATES, buildNotificationTemplate } from '../returns/stateMachine.js';

describe('Phase C5 Item 1: Notifications Hook in transitionReturn', () => {
  it('NOTIF01: buildNotificationTemplate builds expected text from record fields for all target states', () => {
    const mockRecord = {
      id: 'ret_test_1',
      rma_number: 'RMA-999',
      item: { name: 'Running Shoes', price: 2999 },
      rejection_reason: 'PAST_WINDOW_EXPIRED',
      missing_info: 'clear photo of broken sole',
      pickup_details: { slot: 'Tomorrow, 10:00 AM - 1:00 PM' },
      carrier_tracking: 'TRK-55443322',
      refund_amount: 2999,
      escalation_reason: 'Customer dispute',
    };

    // APPROVED
    const app = buildNotificationTemplate(STATES.APPROVED, mockRecord);
    assert.ok(app.body.includes('Running Shoes') || app.body.includes('RMA-999'));

    // REJECTED with reason code and appeal option
    const rej = buildNotificationTemplate(STATES.REJECTED, mockRecord);
    assert.ok(rej.body.includes('PAST_WINDOW_EXPIRED'));
    assert.ok(rej.body.toLowerCase().includes('appeal'));

    // NEEDS_INFO with what is missing
    const ni = buildNotificationTemplate(STATES.NEEDS_INFO, mockRecord);
    assert.ok(ni.body.includes('clear photo of broken sole'));

    // PICKUP_SCHEDULED with slot
    const ps = buildNotificationTemplate(STATES.PICKUP_SCHEDULED, mockRecord);
    assert.ok(ps.body.includes('Tomorrow, 10:00 AM - 1:00 PM'));

    // IN_TRANSIT with tracking
    const itState = buildNotificationTemplate(STATES.IN_TRANSIT, mockRecord);
    assert.ok(itState.body.includes('TRK-55443322'));

    // RECEIVED
    const rec = buildNotificationTemplate(STATES.RECEIVED, mockRecord);
    assert.ok(rec.body.toLowerCase().includes('received at our warehouse') || rec.body.toLowerCase().includes('received at the warehouse'));

    // REFUND_PROCESSING with amount
    const rp = buildNotificationTemplate(STATES.REFUND_PROCESSING, mockRecord);
    assert.ok(rp.body.includes('2999'));

    // COMPLETED with refund amount
    const comp = buildNotificationTemplate(STATES.COMPLETED, mockRecord);
    assert.ok(comp.body.includes('2999'));

    // HUMAN_REVIEW with escalation reason
    const hr = buildNotificationTemplate(STATES.HUMAN_REVIEW, mockRecord);
    assert.ok(hr.body.includes('Customer dispute'));

    // CLOSED_STALE
    const cs = buildNotificationTemplate(STATES.CLOSED_STALE, mockRecord);
    assert.ok(cs.body.includes('RMA-999'));
    assert.ok(cs.body.includes('7 days'));
  });

  it('NOTIF02: each transition creates exactly one in-app message in returns/{id}/messages', async () => {
    const returnId = `ret_notif_each_${Date.now()}`;
    const initialDoc = {
      id: returnId,
      status: STATES.REQUESTED,
      userId: 'user_notif_1',
      rma_number: 'RMA-EACH-1',
      refund_amount: 1250,
      item: { name: 'Cotton Shirt', price: 1250 },
    };
    await returnStore.saveReturn({ db: null, returnRecord: initialDoc });

    // Transition 1: REQUESTED -> APPROVED
    const { updatedDoc: docApproved } = await transitionReturn({
      db: null,
      returnDoc: initialDoc,
      toState: STATES.APPROVED,
      actor: 'staff',
    });
    assert.equal(docApproved.status, STATES.APPROVED);

    const msgs1 = await returnStore.getReturnMessages({ db: null, returnId });
    assert.equal(msgs1.length, 1, 'Should have exactly 1 message after first transition');
    assert.equal(msgs1[0].subject, 'Return Approved');

    // Transition 2: APPROVED -> PICKUP_SCHEDULED
    const { updatedDoc: docPickup } = await transitionReturn({
      db: null,
      returnDoc: {
        ...docApproved,
        pickup_slot: 'Friday (2 PM - 5 PM)',
      },
      toState: STATES.PICKUP_SCHEDULED,
      actor: 'system',
    });
    assert.equal(docPickup.status, STATES.PICKUP_SCHEDULED);

    const msgs2 = await returnStore.getReturnMessages({ db: null, returnId });
    assert.equal(msgs2.length, 2, 'Should have exactly 2 messages after second transition');
    assert.equal(msgs2[1].subject, 'Return Pickup Scheduled');
  });

  it('NOTIF03: numbers present in the record exist in the notification message', async () => {
    const returnId = `ret_notif_numbers_${Date.now()}`;
    const refundAmount = 7890;
    const doc = {
      id: returnId,
      status: STATES.REFUND_PROCESSING,
      userId: 'user_notif_num',
      refund_amount: refundAmount,
      item: { name: 'Smart Watch', price: refundAmount },
    };
    await returnStore.saveReturn({ db: null, returnRecord: doc });

    await transitionReturn({
      db: null,
      returnDoc: doc,
      toState: STATES.COMPLETED,
      actor: 'system',
    });

    const msgs = await returnStore.getReturnMessages({ db: null, returnId });
    assert.equal(msgs.length, 1);
    assert.ok(
      msgs[0].text.includes(String(refundAmount)),
      `Message body "${msgs[0].text}" must contain refund amount ${refundAmount}`
    );
  });

  it('NOTIF04: replaying a transition adds zero new messages (idempotent notification)', async () => {
    const returnId = `ret_notif_replay_${Date.now()}`;
    const doc = {
      id: returnId,
      status: STATES.REQUESTED,
      userId: 'user_replay_test',
      rma_number: 'RMA-REPLAY-1',
      item: { name: 'Noise Cancelling Headphones', price: 4999 },
    };
    await returnStore.saveReturn({ db: null, returnRecord: doc });

    // First transition to APPROVED
    const { updatedDoc } = await transitionReturn({
      db: null,
      returnDoc: doc,
      toState: STATES.APPROVED,
      actor: 'agent',
    });

    const msgsAfterFirst = await returnStore.getReturnMessages({ db: null, returnId });
    assert.equal(msgsAfterFirst.length, 1);

    // Replay transition to APPROVED on the updated doc
    const replayRes = await transitionReturn({
      db: null,
      returnDoc: updatedDoc,
      toState: STATES.APPROVED,
      actor: 'agent',
    });

    // Replay adds nothing
    const msgsAfterReplay = await returnStore.getReturnMessages({ db: null, returnId });
    assert.equal(msgsAfterReplay.length, 1, 'Replay must not add additional notification messages');
    assert.equal(replayRes.notification, null, 'Notification on replay must be null');
  });

  it('NOTIF05: a notification failure never blocks a state transition', async () => {
    const returnId = `ret_notif_fail_${Date.now()}`;
    const doc = {
      id: returnId,
      status: STATES.REQUESTED,
      userId: null, // trigger potential notifier edge case
    };
    await returnStore.saveReturn({ db: null, returnRecord: doc });

    // Transition should still succeed cleanly even if notify encounters an issue
    const { updatedDoc } = await transitionReturn({
      db: null,
      returnDoc: doc,
      toState: STATES.APPROVED,
      actor: 'staff',
    });

    assert.equal(updatedDoc.status, STATES.APPROVED);
  });
});
