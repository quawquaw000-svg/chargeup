# ChargeUp

A static, GitHub Pages-ready charger booking page. The site has no build step. When Firebase is configured, bookings, lesson locks, and cable availability are stored in Firestore and synchronized live. Without Firebase configuration, it runs in browser-only demo mode.

Students choose Vincent or Max as the pickup person. Each has two cables; the selected person must have a cable free for every lesson in the requested range. Availability is checked again inside the reservation transaction to handle simultaneous bookings safely.

## One-time Firebase setup

The Firebase project and web app are already created. Firestore is in the Zurich (`europe-west6`) region and starts in production/deny-by-default mode.

1. In Firebase Console, open **Authentication → Get started → Sign-in method**. Enable **Anonymous** and **Email/Password**.
2. In **Firestore Database → Rules**, replace the editor contents with [`firestore.rules`](./firestore.rules), then click **Publish**. Do not use Firestore test mode or public read/write rules.
3. In **Authentication → Users**, add an Email/Password user for Vincent and Max to use as the admin. Keep this password private.
4. Copy that user’s UID. In **Firestore Database → Data**, create a root collection named `admins`; add a document whose document ID is the UID, with a boolean field `enabled` set to `true`. Only users with this marker can see bookings or use admin actions.
5. In **Authentication → Settings → Authorized domains**, add the GitHub Pages domain where this site will live (for example, `yourname.github.io`).
6. The Firebase web app config is already in [`app.js`](./app.js). Firebase web config is public; database access is controlled by the published Firestore rules.

## Publish on GitHub Pages

1. Put `index.html` and `app.js` in the root of a GitHub repository. Keep [`firestore.rules`](./firestore.rules) and this README alongside them for Firebase setup.
2. In GitHub, open **Settings → Pages**, choose **Deploy from a branch**, select `main` and `/ (root)`, then save.
3. Open the published URL. The availability status should say **Live availability · synced across devices**. If it says demo mode, the Firebase config was not loaded. If it shows a Firebase error, check the Authentication providers, authorized domain, and published rules.

Do not collect more student information than needed. Do not switch to public Firestore rules: booking names and classes should remain admin-only.
