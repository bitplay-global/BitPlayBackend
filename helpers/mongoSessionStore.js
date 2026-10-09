/**
 * express-session store backed by the app's own MongoDB connection, so admin
 * logins survive a server restart (the default MemoryStore lost them all).
 *
 * Documents: { _id: <session id>, session: <JSON string>, expires: Date }
 * (the same shape connect-mongo uses). A TTL index on `expires` lets MongoDB
 * delete expired sessions; `get` also ignores any not yet removed.
 *
 * Uses mongoose's connection, which queues operations until it is connected,
 * so the store can be created before connectDB() finishes.
 */
import session from 'express-session';

const DAY_MS = 24 * 60 * 60 * 1000;

export class MongoSessionStore extends session.Store {
  /**
   * @param {{connection: import('mongoose').Connection, collectionName?: string, defaultTtlMs?: number}} opts
   */
  constructor({ connection, collectionName = 'sessions', defaultTtlMs = DAY_MS } = {}) {
    super();
    if (!connection) throw new Error('MongoSessionStore needs a mongoose connection');
    this.connection = connection;
    this.collectionName = collectionName;
    this.defaultTtlMs = defaultTtlMs;
    this.indexReady = null;
  }

  col() {
    return this.connection.collection(this.collectionName);
  }

  ensureIndex() {
    if (!this.indexReady) {
      this.indexReady = this.col()
        .createIndex({ expires: 1 }, { expireAfterSeconds: 0, name: 'expires_ttl' })
        .catch(err => { this.indexReady = null; throw err; });
    }
    return this.indexReady;
  }

  expiresFor(sess) {
    const e = sess?.cookie?.expires ? new Date(sess.cookie.expires) : null;
    return e && !Number.isNaN(e.getTime()) ? e : new Date(Date.now() + this.defaultTtlMs);
  }

  get(sid, cb) {
    this.col().findOne({ _id: sid })
      .then(doc => {
        if (!doc) return cb(null, null);
        if (doc.expires && new Date(doc.expires).getTime() <= Date.now()) {
          return this.destroy(sid, () => cb(null, null));
        }
        let data;
        try { data = typeof doc.session === 'string' ? JSON.parse(doc.session) : doc.session; }
        catch { return cb(null, null); }
        return cb(null, data);
      })
      .catch(err => cb(err));
  }

  set(sid, sess, cb = () => {}) {
    this.ensureIndex()
      .then(() => this.col().updateOne(
        { _id: sid },
        { $set: { session: JSON.stringify(sess), expires: this.expiresFor(sess) } },
        { upsert: true },
      ))
      .then(() => cb(null))
      .catch(err => cb(err));
  }

  touch(sid, sess, cb = () => {}) {
    this.col().updateOne({ _id: sid }, { $set: { expires: this.expiresFor(sess) } })
      .then(() => cb(null))
      .catch(err => cb(err));
  }

  destroy(sid, cb = () => {}) {
    this.col().deleteOne({ _id: sid })
      .then(() => cb(null))
      .catch(err => cb(err));
  }
}
