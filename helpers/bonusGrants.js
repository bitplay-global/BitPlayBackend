/**
 * Time-limited hashpower (models/BonusGrant.js): added now, removed when it
 * expires. Used for the goodwill credit to buyers whose pack renewals were
 * charged before renewals were honoured (scripts/grant-past-renewal-credit.js).
 */
import mongoose from 'mongoose';
import BonusGrant from '../models/BonusGrant.js';
import { addHashpower } from './subscriptionGrants.js';

/**
 * Gives `hashpower` GH/s to a user until `expiresAt`. A key that was already
 * used is a no-op, so running the same credit twice never grants twice.
 * @returns {Promise<'granted'|'exists'>}
 */
export async function grantBonus({ key, userId, hashpower, expiresAt, reason = '', now = new Date() }) {
  if (!(hashpower > 0) || !(expiresAt > now)) throw new Error(`invalid bonus ${key}`);
  const session = await mongoose.startSession();
  try {
    let result = 'granted';
    await session.withTransaction(async () => {
      result = 'granted';
      if (await BonusGrant.exists({ key }).session(session)) { result = 'exists'; return; }
      await BonusGrant.create([{ key, user: userId, hashpower, starts_at: now, expires_at: expiresAt, active: true, reason }], { session });
      if (!(await addHashpower(userId, hashpower, session))) throw new Error(`no mining record for user ${userId}`);
    });
    if (result === 'granted') console.log(`[Bonus] ON  ${hashpower} GH/s for user ${userId} until ${expiresAt.toISOString()}: ${reason}`);
    return result;
  } catch (err) {
    if (err?.code === 11000) return 'exists';
    throw err;
  } finally {
    session.endSession();
  }
}

/** Takes off every bonus whose time is up. Safe to run any number of times. */
export async function expireBonusGrants(now = new Date()) {
  const due = await BonusGrant.find({ active: true, expires_at: { $lte: now } }).lean();
  let ended = 0;
  for (const g of due) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const r = await BonusGrant.updateOne({ _id: g._id, active: true }, { $set: { active: false, ended_at: now } }, { session });
        if (!r.modifiedCount) return; // already ended elsewhere
        await addHashpower(g.user, -g.hashpower, session);
        ended += 1;
        console.log(`[Bonus] OFF ${g.hashpower} GH/s for user ${g.user}: expired ${g.expires_at.toISOString()}`);
      });
    } catch (err) {
      console.warn(`[Bonus] could not end ${g.key}: ${err.message}`);
    } finally {
      session.endSession();
    }
  }
  return ended;
}
