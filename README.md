# ChargeUp

A GitHub Pages charger booking page with a Firebase backend. When Firebase is
configured, bookings, lesson locks, and cable availability are stored in
Firestore and synchronized live. Without Firebase configuration, it runs in
browser-only demo mode.

Students choose Vincent or Max as the pickup person. Each has two cables; the
selected person must have a cable free for every lesson in the requested range.
Availability is checked again inside the reservation transaction to handle
simultaneous bookings safely.

Firestore Security Rules enforce at most two bookings per anonymous Firebase
account for each selected booking date. This is free on Firebase's Spark plan
and does not use or store IP addresses. Because anonymous accounts are stored in
the browser, starting a new anonymous session can bypass the limit. The limit
slot remains used if an admin later deletes the booking.

Admins can set 0–2 unavailable cables for Vincent and Max independently for
each lesson. Restrictions only apply to unbooked cables; remove an existing
booking before restricting its cable. The full-lesson lock remains available.

## One-time Firebase setup

The Firebase project and web app are already created. Firestore is in the Zurich
(`europe-west6`) region and starts in production/deny-by-default mode. The
account-based limit uses Firestore and Firebase Authentication only; it does not
require Cloud Functions or the Blaze plan.

1. In Firebase Console, open **Authentication → Get started → Sign-in method**.
   Enable **Anonymous** and **Email/Password**.
2. In **Authentication → Settings → Authorized domains**, add the GitHub Pages
   domain where this site will live (for example, `yourname.github.io`).
3. The Firebase web app config is already in [`app.js`](./app.js). Firebase web
   config is public; database access is controlled by the published Firestore
   rules.
4. Publish [`firestore.rules`](./firestore.rules) in Firestore Database →
   **Rules**, then publish `index.html` and `app.js` to GitHub Pages. The rules
   require each booking transaction to consume one of two immutable per-account
   quota slots for its selected date, and enforce owner-specific lesson
   restrictions.

## Publish on GitHub Pages

1. Put `index.html` and `app.js` in the root of a GitHub repository. Keep
   [`firestore.rules`](./firestore.rules) and this README alongside them for
   Firebase setup.
2. In GitHub, open **Settings → Pages**, choose **Deploy from a branch**, select
   `main` and `/ (root)`, then save.
3. Open the published URL. The availability status should say **Live
   availability · synced across devices**. If it says demo mode, the Firebase
   config was not loaded. If it shows a Firebase error, check Authentication,
   the authorized domain, and published rules.

The browser-only demo mode cannot enforce the cross-device account limit. Do not
use it as the published production backend.

Do not collect more student information than needed. Do not switch to public
Firestore rules: booking names and classes should remain admin-only.
