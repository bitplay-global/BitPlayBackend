/**
 * Firebase Admin SDK Configuration
 */

import admin from 'firebase-admin';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let firebaseAdmin = null;

/**
 * Initialize Firebase Admin SDK
 *
 */
export const initializeFirebase = () => {
  if (firebaseAdmin) {
    return firebaseAdmin; // Return existing instance (singleton pattern)
  }

  try {
    // Option 1: Use service account JSON file
    const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');

    if (fs.existsSync(serviceAccountPath)) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

      firebaseAdmin = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id
      });

      console.log('✅ Firebase Admin SDK initialized with service account file');
      return firebaseAdmin;
    }

    // Option 2: Use environment variables (for production/cloud deployments)
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
      let pk = process.env.FIREBASE_PRIVATE_KEY.trim();
      if ((pk.startsWith('"') && pk.endsWith('"')) || (pk.startsWith("'") && pk.endsWith("'"))) {
        pk = pk.slice(1, -1);
      }
      pk = pk.replace(/\\n/g, '\n');
      firebaseAdmin = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID.trim(),
          privateKey: pk,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL.trim(),
        }),
        projectId: process.env.FIREBASE_PROJECT_ID.trim()
      });

      console.log('✅ Firebase Admin SDK initialized with environment variables');
      return firebaseAdmin;
    }

    console.warn('⚠️ Firebase Admin SDK not initialized: Missing credentials');
    console.warn('   Please add firebase-service-account.json or set environment variables');
    return null;

  } catch (error) {
    console.error('❌ Error initializing Firebase Admin SDK:', error.message);
    return null;
  }
};

/**
 * Get Firebase Admin instance
 *
 */
export const getFirebaseAdmin = () => {
  if (!firebaseAdmin) {
    return initializeFirebase();
  }
  return firebaseAdmin;
};

/**
 * Get Firebase Messaging instance
 *
 */
export const getMessaging = () => {
  const admin = getFirebaseAdmin();
  return admin ? admin.messaging() : null;
};

export default {
  initializeFirebase,
  getFirebaseAdmin,
  getMessaging
};
