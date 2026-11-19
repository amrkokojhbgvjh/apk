# Security Specification — APK Store Firestore Rules

## 1. Data Invariants
1. **PII Isolation (`users/{userId}`)**: A user profile contains an `email` address and is strictly readable only by the owning authenticated user (`request.auth.uid == userId`) or a verified admin. Listing `/users` is globally forbidden.
2. **Atomic Counter Integrity (`storeStats/summary`)**: `registeredUsersCount` may only be created with value `1` or incremented by exactly `+1` in the same atomic batch where the caller's own `/users/{uid}` profile transitions from non-existent (`!exists`) to existent (`existsAfter`).
3. **Verified Publisher Integrity (`apps/{appId}`)**: Only authenticated users with `email_verified == true` who have an existing `/users/{uid}` profile may publish an app, with `uploaderId == request.auth.uid`, `downloadsCount == 0`, `status == 'published'`, and server timestamps (`request.time`).
4. **Action-Based Updates & Immutability (`apps/{appId}`)**: Immutable fields (`id`, `uploaderId`, `fileId`, `fileName`, `fileSize`, `status`, `createdAt`) cannot be altered after creation. Updates are strictly partitioned into Owner Metadata Edit (`name`, `description`, `screenshotCount`, `updatedAt`) and Verified Download Increment (`downloadsCount == existing + 1`, `updatedAt`).
5. **Relational Parent Ownership (`apps/{appId}/screenshots/{screenshotId}`)**: Screenshots can only be created when the parent `/apps/{appId}` document (checked via `getAfter`) is owned by `request.auth.uid`, with `order` bounded to `0..3`.
6. **Public Read Scope (`apps` & `screenshots`)**: Public `get` and `list` are strictly scoped to `existing().status == 'published'` with zero `get()`/`exists()` lookups inside `allow list`.

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Return PERMISSION_DENIED)
1. **Identity Spoofing on App Create**: User A attempts to create `/apps/app1` with `uploaderId: "userB"`.
2. **Shadow / Ghost Field Injection**: User A attempts to create `/apps/app1` with an extra field `isFeatured: true`.
3. **Client Timestamp Forgery**: User A creates `/apps/app1` with a forged `createdAt` not equal to `request.time`.
4. **Pre-Inflated Downloads Count**: User A creates `/apps/app1` with `downloadsCount: 9999`.
5. **Path ID Poisoning**: User A writes to `/apps/../../../evil` or a 200-character ID failing `isValidId()`.
6. **PII Cross-User Read**: User B attempts `get` on `/users/userA`.
7. **Users Collection Scraping**: Any user attempts `list` on `/users`.
8. **Counter Spoofing Without Registration**: Existing User A attempts to increment `/storeStats/summary.registeredUsersCount` by `+1` or `+100`.
9. **Unauthorized App Metadata Edit**: User B attempts to update `name` or `description` on User A's `/apps/app1`.
10. **Value Poisoning on Whitelisted Update Field**: User A attempts to update `downloadsCount` to `"not-a-number"` or increment by `+5`.
11. **Unverified Email Bypass**: A user with `email_verified: false` (even with admin email) attempts to publish or delete an app.
12. **Orphan / Cross-Owner Screenshot Injection**: User B attempts to create `/apps/app1/screenshots/shot1` under User A's app.
