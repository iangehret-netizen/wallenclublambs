# Wallen Club Lambs — Turning on cross-device sync

Out of the box this app works fully on its own: records save on each phone/computer, no passcode screen.
To make every device share the same data, connect it to a free Firebase project owned by the Wallen Club Lambs family.

## 1. Create the Firebase project (one time, ~10 minutes)
1. Go to https://console.firebase.google.com and sign in with the family's Google account.
2. **Add project** → name it something like `wallen-club-lambs` → Google Analytics can be turned off → Create.

## 2. Turn on the passcode login
1. Left menu → **Build → Authentication → Get started**.
2. **Sign-in method** tab → **Email/Password** → Enable → Save.
3. **Users** tab → **Add user**:
   - Email: any email the family controls (e.g. their own Gmail)
   - Password: **this is the passcode** everyone will type to unlock a device (6+ characters)

## 3. Turn on the database
1. Left menu → **Build → Firestore Database → Create database** → pick a US location → start in **production mode**.
2. Open the **Rules** tab, replace everything with this, then **Publish**:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /wallen_sync/{doc} {
      allow read, write: if request.auth != null;
    }
  }
}
```

## 4. Get the web config
1. Project Overview (gear icon) → **Project settings** → scroll to **Your apps** → click the **</>** (Web) icon.
2. Nickname: `Wallen Club Lambs` → Register app (skip Firebase Hosting).
3. Copy the values from the `firebaseConfig` block it shows.

## 5. Paste into sync.js
Open `sync.js` and fill in the block at the top marked **FIREBASE SETUP**:
- `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId` from step 4
- `SYNC_EMAIL` = the email from step 2.3

## 6. Allow the website address
Authentication → **Settings** → **Authorized domains** → **Add domain** → add the GitHub Pages host (e.g. `yourname.github.io`).

## 7. Publish the update
1. Upload the edited `sync.js` to the GitHub repo.
2. In `sw.js`, change `"v1"` to `"v2"` in the CACHE_NAME line and upload that too, so phones pick up the change.
3. On each device, open the app → enter the passcode once → it stays unlocked after that, even offline.

**Note:** Turn sync on *before* entering lots of records, or enter them on one device first — that device's data uploads automatically the first time it unlocks.
