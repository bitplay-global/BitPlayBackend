# Firebase Push Notifications Setup Guide

## Overview
This project uses Firebase Cloud Messaging (FCM) to send push notifications to users. The notification system is already implemented, but you need to configure Firebase credentials.

## Current Status
✅ Notification service code is implemented  
✅ Cron job integration is complete  
✅ FCM token storage is working  
❌ Firebase credentials need to be configured

## Firebase Credentials Setup

**Important:** These credentials are for your **BACKEND/SERVER**, not for iOS or Android apps. The same server credentials work for **BOTH iOS and Android** push notifications. Your mobile apps have separate Firebase configuration files (GoogleService-Info.plist for iOS, google-services.json for Android), but those are different from these server-side credentials.

You have **two options** to configure Firebase:

### Option 1: Service Account JSON File (Recommended for Local Development)

1. **Get Firebase Service Account Key:**
   - Go to [Firebase Console](https://console.firebase.google.com/)
   - Select your project (or create a new one)
   - Go to **Project Settings** (gear icon) → **Service Accounts** tab
   - Click **Generate New Private Key**
   - Download the JSON file

2. **Place the file:**
   - Save the downloaded JSON file as `firebase-service-account.json`
   - Place it in the `/config/` directory
   - **IMPORTANT:** Add `firebase-service-account.json` to `.gitignore` to avoid committing credentials

3. **Verify:**
   - The file should be at: `/config/firebase-service-account.json`
   - Restart your server
   - Check logs for: `✅ Firebase Admin SDK initialized with service account file`

### Option 2: Environment Variables (Recommended for Production)

1. **Get Firebase Credentials:**
   - Go to Firebase Console → Project Settings → Service Accounts
   - You'll need:
     - `project_id`
     - `private_key`
     - `client_email`

2. **Add to `.env` file:**
   ```env
   FIREBASE_PROJECT_ID=your-project-id-here
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour private key here\n-----END PRIVATE KEY-----\n"
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
   ```
   
   **Note:** These credentials are used by your Node.js backend to send push notifications to BOTH iOS and Android devices. You only need ONE set of credentials for the server.

3. **Important Notes:**
   - The `FIREBASE_PRIVATE_KEY` should include the full key with `\n` characters
   - Keep the quotes around the private key value
   - Restart your server after adding these

## Testing the Setup

### 1. Test Firebase Initialization
When you start the server, check the logs:
- ✅ Success: `✅ Firebase Admin SDK initialized with service account file` or `✅ Firebase Admin SDK initialized with environment variables`
- ❌ Error: `⚠️ Firebase Admin SDK not initialized: Missing credentials`

### 2. Test Notification Endpoint
Use the test endpoint to manually trigger a notification:

```bash
POST /api/firebase_tokens/test-notification
Content-Type: application/json

{
  "user_id": "your-user-id-here"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Notification sent successfully",
  "user_id": "your-user-id-here",
  "notification_result": {
    "success": true,
    "response": "projects/xxx/messages/xxx"
  }
}
```

**Response (No Token):**
```json
{
  "success": false,
  "message": "No FCM token found for this user. Please register a token first.",
  "user_id": "your-user-id-here"
}
```

### 3. Check User Setup
Before notifications can be sent, ensure:
1. User has registered FCM token: `POST /api/firebase_tokens/create`
2. User has push notifications enabled (defaults to enabled if no preference exists)

## Notification Flow

1. **User registers FCM token:**
   ```
   POST /api/firebase_tokens/create
   { "user_id": "xxx", "token": "fcm-token-here" }
   ```

2. **Cron job runs at midnight:**
   - Resets user mining data
   - Calls `sendMiningStoppedNotification(userId)`
   - Sends notification: "User mining stopped please start mining"

3. **Notification Service:**
   - Checks if Firebase is initialized
   - Checks user notification preferences (defaults to enabled)
   - Retrieves FCM token
   - Sends notification via Firebase
   - Handles errors (invalid tokens, disabled notifications, etc.)

## Troubleshooting

### Issue: "Firebase Admin SDK not initialized"
**Solution:** 
- Check if `firebase-service-account.json` exists in `/config/` directory
- OR check if environment variables are set correctly
- Verify file permissions

### Issue: "No FCM token found"
**Solution:**
- User needs to register their FCM token first
- Call `/api/firebase_tokens/create` from mobile app

### Issue: "User has disabled push notifications"
**Solution:**
- User has explicitly disabled notifications in their preferences
- Check `/api/notification-preferences/:userId` endpoint
- Update preferences: `PUT /api/notification-preferences/:userId` with `{ "push": true }`

### Issue: "messaging/invalid-registration-token"
**Solution:**
- Token is expired or invalid
- The system automatically removes invalid tokens
- User needs to register a new token

## API Endpoints

### FCM Token Management
- `POST /api/firebase_tokens/create` - Register/update FCM token
- `POST /api/firebase_tokens/test-notification` - Test notification (manual trigger)

### Notification Preferences
- `GET /api/notification-preferences/:userId` - Get user preferences
- `PUT /api/notification-preferences/:userId` - Update preferences

## Files Involved

- `/config/firebase.js` - Firebase initialization
- `/services/notificationService.js` - Notification service
- `/cronJobs.js` - Cron job that triggers notifications
- `/models/FirebaseNotificationModels.js` - FCM token storage
- `/models/NotificationPreferences.js` - User preferences
- `/routes/api_routes/firebase_notifications.js` - Token & test endpoints

## Next Steps

1. ✅ Set up Firebase credentials (Option 1 or 2 above)
2. ✅ Test Firebase initialization (check server logs)
3. ✅ Test notification endpoint with a real user_id and FCM token
4. ✅ Verify cron job will trigger at midnight
5. ✅ Monitor logs when cron runs

## Security Notes

- ⚠️ **NEVER commit** `firebase-service-account.json` to git
- ⚠️ **NEVER commit** `.env` file with credentials
- ✅ Use environment variables in production
- ✅ Rotate credentials if exposed

