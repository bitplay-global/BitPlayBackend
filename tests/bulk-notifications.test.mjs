/**
 * The admin "send to all" broadcast used to fire one database lookup pair and
 * one Firebase request per user, all at once, over an unindexed collection.
 * Verifies the batched sender: everyone with a token is reached, opted-out
 * users are not, Firebase gets at most 500 messages per call one call at a
 * time, dead tokens are removed, and a failed batch does not stop the rest.
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'bulktest' });
const Tokens = (await import('../models/FirebaseNotificationModels.js')).default;
const Prefs = (await import('../models/NotificationPreferences.js')).default;
await Tokens.syncIndexes();
const { sendBulkNotifications } = await import('../services/notificationService.js');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const uid = () => new mongoose.Types.ObjectId().toString();

// 1,100 users with a token, 100 of whom opted out; 100 with no token; one user
// with two token rows; two tokens Firebase reports as dead.
const withToken = Array.from({ length: 1100 }, uid);
const optedOut = withToken.slice(0, 100);
const optedIn = withToken.slice(100, 150);
const noToken = Array.from({ length: 100 }, uid);
await Tokens.insertMany(withToken.map((u, i) => ({ user_id: u, token: `tok-${i}` })));
await Tokens.create({ user_id: withToken[500], token: 'tok-500-second-device' });
await Prefs.insertMany([
  ...optedOut.map(u => ({ user: u, push: false })),
  ...optedIn.map(u => ({ user: u, push: true })),
]);
const DEAD = new Set(['tok-700', 'tok-701']);

function fakeMessaging({ failBatch = -1 } = {}) {
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  return {
    calls,
    get maxInFlight() { return maxInFlight; },
    async sendEach(batch) {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(batch);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      if (calls.length - 1 === failBatch) throw Object.assign(new Error('network down'), { code: 'app/network-error' });
      const responses = batch.map(m => DEAD.has(m.token)
        ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
        : { success: true, messageId: `id-${m.token}` });
      return { responses, successCount: responses.filter(r => r.success).length, failureCount: responses.filter(r => !r.success).length };
    },
  };
}

console.log('\n--- broadcast to everyone ---');
const everyone = [...withToken, ...noToken, withToken[3]]; // duplicate id too
let fm = fakeMessaging();
const started = Date.now();
let res = await sendBulkNotifications(everyone, { title: 'Hello', body: 'World', data: { type: 'admin_broadcast' } }, { messaging: fm });
const sentTo = fm.calls.flat();
check('every opted-in user with a token is sent exactly once', sentTo.length === 1000 && new Set(sentTo.map(m => m.token)).size === 1000, `sent ${sentTo.length}`);
check('opted-out users (push:false) are not sent', !sentTo.some(m => ['tok-0', 'tok-50', 'tok-99'].includes(m.token)));
check('explicit push:true users are sent', sentTo.some(m => m.token === 'tok-120'));
check('a user with two token rows gets one message', sentTo.filter(m => m.token.startsWith('tok-500')).length === 1);
check('at most 500 messages per Firebase call', fm.calls.every(b => b.length <= 500) && fm.calls.length === 2, `batches ${fm.calls.map(b => b.length)}`);
check('one Firebase call at a time', fm.maxInFlight === 1, `max in flight ${fm.maxInFlight}`);
check('counts: 998 sent, 100 disabled, 100 no token, 2 failed', res.sent === 998 && res.disabled === 100 && res.noToken === 100 && res.failed === 202, JSON.stringify(res));
check('dead tokens removed from the database', res.invalidTokensRemoved === 2 && !(await Tokens.exists({ token: 'tok-700' })) && !!(await Tokens.exists({ token: 'tok-702' })));
check('message shape unchanged (title, body, data, android, apns)',
  sentTo[0].notification.title === 'Hello' && sentTo[0].notification.body === 'World' && sentTo[0].data.type === 'admin_broadcast'
  && sentTo[0].android.priority === 'high' && sentTo[0].apns.payload.aps.sound === 'default');
check('fast: 1,200 users in well under the nginx timeout', Date.now() - started < 10000, `${Date.now() - started} ms`);

console.log('\n--- resilience ---');
fm = fakeMessaging({ failBatch: 0 });
res = await sendBulkNotifications(withToken.slice(100), { title: 'T', body: 'B' }, { messaging: fm });
check('first batch failing does not stop the second', fm.calls.length === 2 && res.sent > 0 && res.failed >= 500, JSON.stringify(res));
res = await sendBulkNotifications(withToken, { title: 'T', body: 'B' }, { messaging: null });
check('Firebase not configured: nothing sent, all counted failed', res.sent === 0 && res.failed === withToken.length);
res = await sendBulkNotifications([], { title: 'T', body: 'B' }, { messaging: fakeMessaging() });
check('no users: no error', res.total === 0 && res.sent === 0);

console.log('\n--- index ---');
const idx = await Tokens.collection.indexes();
check('FCM tokens indexed by user_id', idx.some(i => i.key && i.key.user_id === 1), JSON.stringify(idx.map(i => i.key)));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
