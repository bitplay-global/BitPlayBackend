# Complete API Documentation

## Base URL
All APIs are prefixed with `/api` in the main api.js router.

---

## 1. **FAQs** (`/faqs`)
Route file: `routes/api_routes/faqs.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Get all FAQs |
| POST | `/create` | Create a new FAQ |
| DELETE | `/:id` | Delete an FAQ |

---

## 2. **Support/Help** (`/help`)
Route file: `routes/api_routes/support.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/create` | Create a support ticket |
| DELETE | `/:id/delete` | Delete a support ticket |
| GET | `/:userId` | Get support tickets for a user |
| POST | `/reply` | Reply to a support ticket |

---

## 3. **Users Management** (`/users`)
Route file: `routes/api_routes/users.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| PUT | `/:id/status` | Update user status (requires auth) |
| DELETE | `/:id` | Delete a user (requires auth) |
| POST | `/update-status` | Update user status (requires auth) |

---

## 4. **Transactions** (`/transactions`)
Route file: `routes/api_routes/transactions.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/create` | Create a transaction |
| GET | `/:userId` | Get user transactions |
| GET | `/all/:userId` | Get all user transactions |
| GET | `/last7days/:userId` | Get transactions from last 7 days |

---

## 5. **Subscription Plans** (`/subscriptionplans`)
Route file: `routes/api_routes/subscriptions.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/create` | Create a subscription plan |
| POST | `/create_user_sub` | Create user subscription |
| GET | `/` | Get all subscription plans |
| DELETE | `/:id` | Delete a subscription plan |
| GET | `/hashpower/:userId` | Get user's hashpower/subscriptions |
| DELETE | `/usersub/:id` | Delete user subscription |

---

## 6. **Daily Rewards** (`/daily-rewards`)
Route file: `routes/api_routes/dailyRewardController.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Get all daily rewards |
| POST | `/create` | Create a daily reward |
| POST | `/claim` | Claim a daily reward |
| DELETE | `/:id` | Delete a daily reward |

---

## 7. **Withdrawals** (`/withdrawals`)
Route file: `routes/api_routes/withdrawal_routes.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Get all withdrawals |
| GET | `/limits` | Get min/max withdrawal limits in BTC (for app validation/display) |
| GET | `/user/:userId` | Get withdrawals for a specific user |
| POST | `/` | Create a withdrawal request (body may include `amountBtc` for min/max validation) |
| PATCH | `/:id/approve` | Approve a withdrawal |
| PATCH | `/:id/reject` | Reject a withdrawal |
| PATCH | `/:id/sent` | Mark withdrawal as sent |
| PATCH | `/:id/confirm` | Confirm a withdrawal |
| POST | `/create-speed-payment` | Create a speed payment |

---

## 8. **Notification Preferences** (`/notification-preferences`)
Route file: `routes/api_routes/notification_handles.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:userId` | Get notification preferences for a user |
| PUT | `/:userId` | Update notification preferences for a user |

---

## 9. **Deposit Addresses (Alchemy)** (`/deposit-address`)
Route file: `routes/api_routes/alchemy_deposit.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:userId/:asset` | Get deposit address for a user and asset |
| GET | `/:userId` | Get all deposit addresses for a user |

---

## 10. **Wallet Balance** (`/wallet`)
Route file: `routes/api_routes/balance.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/balance` | Get wallet balance |
| POST | `/balance` | Update/set wallet balance |
| GET | `/history` | Get balance history |

---

## 11. **Firebase Tokens/Notifications** (`/firebase_tokens`)
Route file: `routes/api_routes/firebase_notifications.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/create` | Create/register a Firebase token |
| GET | `/check/:user_id` | Check Firebase tokens for a user |
| POST | `/mining-stopped` | Send mining stopped notification |
| POST | `/custom-notification` | Send custom notification |

---

## 12. **Lightning Handles** (`/lightning-handles`)
Route file: `routes/api_routes/lightning-handle.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/pay-invoice` | Get/pay Lightning invoice |

---

## 13. **Google Ads** (`/google-ads`)
Route file: `routes/api_routes/google_ads.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/id/ios` | Get Google Ads ID for iOS |
| GET | `/id/android` | Get Google Ads ID for Android |
| GET | `/ids` | Get all Google Ads IDs |

---

## 14. **Delete Handles** (`/delete-handles`)
Route file: `routes/api_routes/delete_handles.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/create` | Create a delete request |

---

## 15. **Security** (`/security`)
Route file: `routes/api_routes/security_handles.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/switch` | Switch/toggle 2FA or security setting |
| GET | `/2fa-status/:user_id` | Get 2FA status for a user |

---

## 16. **User Mining** (`/user_mining`)
Route file: `routes/api_routes/user-mining-handles.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:userId` | Get user mining details |
| POST | `/` | Create/update user mining record |
| POST | `/increment-video` | Increment daily video count |
| POST | `/increment-loss-ad` | Increment loss offset ad |
| GET | `/daily-progress/:userId` | Get daily mining progress |

---

## 17. **Daily Miner** (`/claim_daily_miner`)
Route file: `routes/api_routes/daily-miner-handles.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/` | Create daily miner record |
| GET | `/:userId` | Get daily miner details for a user |

---

## 18. **Purchases** (`/purchases`)
Route file: `routes/api_routes/purchases.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/:userId` | Create a purchase |
| GET | `/:userId` | Get purchases for a user |

---

## 19. **Mining Sessions** (`/mining-sessions`)
Route file: `routes/api_routes/mining-session-handles.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/start` | Start a mining session |
| POST | `/update` | Update a mining session |
| POST | `/stop` | Stop a mining session |
| GET | `/status/:userId` | Get mining session status for a user |

---

## 20. **Admin Dashboard** (Requires Authentication)
Route file: `routes/api.js`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/dashboard-stats` | Get dashboard statistics |
| PUT | `/support/:id/status` | Update support ticket status |
| POST | `/profile/save` | Save admin profile |
| GET | `/referrals?code=CODE` | Get referral count for a code |
| GET | `/referrals/rewards/:userId` | Get total referral rewards for a user |

---

## Authentication

Some endpoints require authentication:
- Middleware: `requireAuth` checks `req.session.isLoggedIn`
- Applied to: `/users`, `/admin` routes

---

## Summary by Category

### **Mining & Crypto**
- User Mining (`/user_mining`)
- Daily Miner (`/claim_daily_miner`)
- Mining Sessions (`/mining-sessions`)
- Wallet Balance (`/wallet`)
- Deposit Addresses (`/deposit-address`)
- Withdrawals (`/withdrawals`)
- Lightning Handles (`/lightning-handles`)

### **User Management**
- Users (`/users`)
- Subscription Plans (`/subscriptionplans`)
- Daily Rewards (`/daily-rewards`)

### **Notifications & Preferences**
- Notification Preferences (`/notification-preferences`)
- Firebase Tokens (`/firebase_tokens`)

### **Transactions & Purchases**
- Transactions (`/transactions`)
- Purchases (`/purchases`)

### **Support & Content**
- Support/Help (`/help`)
- FAQs (`/faqs`)

### **Security & Ads**
- Security (`/security`)
- Google Ads (`/google-ads`)
- Delete Handles (`/delete-handles`)

### **Admin Panel**
- Dashboard Stats
- Support Management
- Profile Management
- Referral Management

---

## Total API Endpoints
**Approximately 60+ API endpoints** across all routes.

