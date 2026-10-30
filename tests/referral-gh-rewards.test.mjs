/**
 * Referral rewards are bonus mining power, not BTC (services/referralRewardService.js,
 * App Store 3.1.5(v)). Verifies: a referral's settled day gives the referrer 24h
 * of GH/s worth 5% of that day's mining; no BTC is credited; the same day never
 * rewards twice; the bonus comes off when it expires; self-referrals and
 * referrers without a mining record are not rewarded; the rewards API reports
 * the GH/s while keeping old BTC rewards.
 * Run: node tests/referral-gh-rewards.test.mjs
 */
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(mongod.getUri(), { dbName: 'referralgh' });
const Mining = (await import('../models/UserMiningDetails.js')).default;
const Bonus = (await import('../models/BonusGrant.js')).default;
const History = (await import('../models/ReferralRewardHistory.js')).default;
await Bonus.syncIndexes(); await History.syncIndexes();
const { processReferralRewardForChild, referralRewardGh } = await import('../services/referralRewardService.js');
const { expireBonusGrants } = await import('../helpers/bonusGrants.js');
const { BTC_PER_GH_PER_DAY } = await import('../helpers/miningDaySettlement.js');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const users = mongoose.connection.collection('users');
const balances = mongoose.connection.collection('balances');
const D = v => mongoose.Types.Decimal128.fromString(String(v));
const mining = async u => Mining.findOne({ user: u }).lean();

const parent = new mongoose.Types.ObjectId();
const child = new mongoose.Types.ObjectId();
await users.insertMany([
  { _id: parent, email: 'p@x', referralCode: 'PARENT1', isActive: true },
  { _id: child, email: 'c@x', referralUsed: 'parent1', isActive: true },
]);
await Mining.collection.insertOne({ user: String(parent), hashpower: 300, claimedHashpower: 300, purchasedHashpower: 0 });
await balances.insertOne({ user: String(parent), BTC: D(0), BTC_DEPOSIT: D('0.000001') });

// The child mined a full day at 1,000 GH/s.
const childBtc = 1000 * BTC_PER_GH_PER_DAY;
const day = new Date('2026-10-30T00:00:00Z');

console.log('\n--- conversion ---');
check('5% of a 1,000 GH/s day is 50 GH/s for a day', referralRewardGh(childBtc) === 50, String(referralRewardGh(childBtc)));
check('dust rounds to 0', referralRewardGh(1e-15) === 0);

console.log('\n--- reward ---');
let r = await processReferralRewardForChild(String(child), childBtc, day);
let m = await mining(String(parent));
check('referrer gets +50 GH/s', r?.rewardGh === 50 && m.hashpower === 350 && m.purchasedHashpower === 50, JSON.stringify({ r, m }));
check('claimed GH/s untouched', m.claimedHashpower === 300);
const bal = await balances.findOne({ user: String(parent) });
check('no BTC credited', bal.BTC_DEPOSIT.toString() === '0.000001', bal.BTC_DEPOSIT.toString());
const g = await Bonus.findOne({ user: parent }).lean();
check('bonus lasts 24h', g && Math.abs(g.expires_at - g.starts_at - 864e5) < 1000 && g.key === `referral:${child}:2026-10-30`, JSON.stringify(g));
const h = await History.findOne({ parentUserId: String(parent) }).lean();
check('history row says GH/s, 0 BTC', h?.rewardType === 'ghs' && h.rewardGh === 50 && h.rewardAmount.toString() === '0', JSON.stringify(h));

console.log('\n--- repeat ---');
r = await processReferralRewardForChild(String(child), childBtc, day);
m = await mining(String(parent));
check('same day again: no second reward', r?.alreadyProcessed === true && m.hashpower === 350, JSON.stringify(r));

console.log('\n--- expiry ---');
await expireBonusGrants(new Date(Date.now() + 864e5 + 1000));
m = await mining(String(parent));
check('bonus removed after 24h', m.hashpower === 300 && m.purchasedHashpower === 0, JSON.stringify(m));

console.log('\n--- no reward ---');
const selfie = new mongoose.Types.ObjectId();
await users.insertOne({ _id: selfie, email: 's@x', referralCode: 'SELF1', referralUsed: 'self1', isActive: true });
await Mining.collection.insertOne({ user: String(selfie), hashpower: 10, claimedHashpower: 10, purchasedHashpower: 0 });
r = await processReferralRewardForChild(String(selfie), childBtc, day);
check('self-referral: nothing', r === null && (await mining(String(selfie))).hashpower === 10);
const orphanParent = new mongoose.Types.ObjectId();
const child2 = new mongoose.Types.ObjectId();
await users.insertMany([
  { _id: orphanParent, email: 'o@x', referralCode: 'NOMINE', isActive: true },
  { _id: child2, email: 'c2@x', referralUsed: 'NOMINE', isActive: true },
]);
let err = '';
try { await processReferralRewardForChild(String(child2), childBtc, day); } catch (e) { err = e.message; }
check('referrer without a mining record: error, recorded as failed', /no mining record/.test(err) && (await History.findOne({ parentUserId: String(orphanParent) }))?.status === 'failed', err);

console.log('\n--- rewards API ---');
await History.create({ parentUserId: String(parent), childUserId: String(child), rewardDate: new Date('2026-10-01'), childDailyMining: D('0.000001'), rewardAmount: D('0.00000005'), status: 'processed' });
const { default: api } = await import('../routes/api.js');
const app = express(); app.use(express.json()); app.use('/api', api);
const res = await request(app).get(`/api/referrals/rewards/${parent}`);
check('API: old BTC kept, GH/s reported', res.status === 200 && Number(res.body.totalRewardsRaw) === 0.00000005 && res.body.totalRewardGh === 50 && res.body.activeRewardGh === 50, JSON.stringify(res.body).slice(0, 300));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
