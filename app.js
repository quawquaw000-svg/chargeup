// Firebase setup: in Firebase Console, open Project settings > Your apps,
// choose the registered ChargeUp web app, and paste its config values below.
// The web config is public; Firestore Security Rules protect the stored data.
const firebaseConfig = {
  apiKey: "AIzaSyDIpqIaVX31zARIX_b9QE5Y_8as14DZ8rw",
  authDomain: "rg-ladekabel-mieten.firebaseapp.com",
  projectId: "rg-ladekabel-mieten",
  storageBucket: "rg-ladekabel-mieten.firebasestorage.app",
  messagingSenderId: "608870448062",
  appId: "1:608870448062:web:04ac8ef8b140cf119317ef"
};

const LESSON_TIMES = [
  ["07:45", "08:30"],
  ["08:40", "09:25"],
  ["09:35", "10:20"],
  ["10:35", "11:20"],
  ["11:30", "12:15"],
  ["12:25", "13:10"],
  ["13:20", "14:05"],
  ["14:15", "15:00"],
  ["15:10", "15:55"]
];
const LESSONS = LESSON_TIMES.length;
const TOTAL_CABLES = 4;
const CABLES_PER_OWNER = 2;
const OWNERS = ["Vincent", "Max"];
const STORAGE_PREFIX = "chargeup-day-v1:";
const PROMO_STORAGE_KEY = "chargeup-promos-v1";
const DEMO_ADMIN_PASSWORD = "demo-admin";
const firebaseConfigured = Object.values(firebaseConfig).some((value) => typeof value === "string" && value.trim());
const firebaseConfigComplete = Object.values(firebaseConfig).every((value) => typeof value === "string" && value.trim());

const el = (id) => document.getElementById(id);
const dateInput = el("bookingDate");
const timetable = el("timetable");
const bookingForm = el("bookingForm");
const startSelect = el("startLesson");
const endSelect = el("endLesson");
const pickupOwnerSelect = el("pickupOwner");
const adminDialog = el("adminDialog");
let activeDate = "";
let dayState = { bookings: [], blockedLessons: [], slots: [] };
let promoCodes = [];
let activePromo = null;
let database = null;
let firestore = null;
let auth = null;
let authModule = null;
let unsubscribeSlots = [];
let unsubscribeBlocked = null;
let unsubscribeBookings = null;
let unsubscribePromos = null;
let adminLoggedIn = false;
let busy = false;
let statusKind = "loading";
let statusText = "Connecting…";

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function blankDay() {
  return { bookings: [], blockedLessons: [], restrictions: [], slots: [] };
}

function normalizeDay(value) {
  if (!value || typeof value !== "object") return blankDay();
  const bookings = Array.isArray(value.bookings)
    ? value.bookings.filter((booking) => booking && typeof booking.id === "string" && Number.isInteger(booking.start) && Number.isInteger(booking.end) && booking.start >= 1 && booking.end <= LESSONS && booking.start <= booking.end && OWNERS.includes(booking.owner) && ["active", "completed"].includes(booking.status))
    : [];
  const blockedLessons = Array.isArray(value.blockedLessons)
    ? [...new Set(value.blockedLessons.filter((lesson) => Number.isInteger(lesson) && lesson >= 1 && lesson <= LESSONS))]
    : [];
  const restrictions = Array.isArray(value.restrictions)
    ? value.restrictions.filter((item) => item && Number.isInteger(item.lesson) && item.lesson >= 1 && item.lesson <= LESSONS && OWNERS.includes(item.owner) && Array.isArray(item.cables))
    : [];
  return { bookings, blockedLessons, restrictions, slots: [] };
}

function setStatus(message, kind = "ready") {
  statusText = message;
  statusKind = kind;
  renderStatus();
}

function renderStatus() {
  const colors = { ready: "bg-emerald-500", loading: "bg-amber-400", error: "bg-rose-500" };
  el("connectionStatus").innerHTML = `<span class="h-2 w-2 rounded-full ${colors[statusKind]}"></span>${statusText}`;
}

function lessonTime(lesson) {
  return LESSON_TIMES[lesson - 1];
}

function lessonUsed(state, lesson) {
  const restricted = database ? 0 : state.restrictions
    .filter((restriction) => restriction.lesson === lesson)
    .reduce((count, restriction) => count + restriction.cables.length, 0);
  if (database) return state.slots.filter((slot) => slot.lesson === lesson).length + restricted;
  return state.bookings.filter((booking) => booking.status === "active" && booking.start <= lesson && booking.end >= lesson).length + restricted;
}

function ownerUsed(state, owner, lesson) {
  const restricted = database ? 0 : state.restrictions
    .filter((restriction) => restriction.lesson === lesson && restriction.owner === owner)
    .reduce((count, restriction) => count + restriction.cables.length, 0);
  if (database) return state.slots.filter((slot) => slot.lesson === lesson && slot.owner === owner).length + restricted;
  return state.bookings.filter((booking) => booking.status === "active" && booking.owner === owner && booking.start <= lesson && booking.end >= lesson).length + restricted;
}

function ownerAvailability(state, owner, start, end) {
  if (!start || end < start || state.blockedLessons.some((lesson) => lesson >= start && lesson <= end)) {
    return { available: false, minimumFree: 0 };
  }
  const freeByLesson = [];
  for (let lesson = start; lesson <= end; lesson += 1) {
    freeByLesson.push(CABLES_PER_OWNER - ownerUsed(state, owner, lesson));
  }
  return {
    available: freeByLesson.every((free) => free > 0),
    minimumFree: Math.max(0, Math.min(...freeByLesson))
  };
}

function updatePickupOwners() {
  const start = Number(startSelect.value);
  const end = Number(endSelect.value);
  const options = new Map(Array.from(pickupOwnerSelect.options, (option) => [option.value, option]));
  const availability = new Map();
  for (const owner of OWNERS) {
    const result = ownerAvailability(dayState, owner, start, end);
    availability.set(owner, result);
    const option = options.get(owner);
    option.disabled = !result.available;
    option.textContent = result.available
      ? `${owner} — at least ${result.minimumFree}/2 free per lesson`
      : `${owner} — unavailable for selected lessons`;
  }

  const availableOwners = OWNERS.filter((owner) => availability.get(owner).available);
  if (!availableOwners.includes(pickupOwnerSelect.value) && availableOwners.length) {
    pickupOwnerSelect.value = availableOwners[0];
  }
  const hasAvailableOwner = availableOwners.length > 0;
  pickupOwnerSelect.setCustomValidity(
    hasAvailableOwner ? "" : "Neither Vincent nor Max has a cable available for every selected lesson."
  );
  el("pickupOwnerAvailability").textContent = hasAvailableOwner
    ? `Choose who you’ll collect your cable from. ${availableOwners.join(" and ")} ${availableOwners.length === 1 ? "is" : "are"} available for every selected lesson.`
    : "No pickup person has a cable available for every selected lesson.";
  el("submitBooking").disabled = busy || !hasAvailableOwner;
}

function updatePrice() {
  const start = Number(startSelect.value);
  const end = Number(endSelect.value);
  const count = start && end >= start ? end - start + 1 : 0;
  if (activePromo?.type === "single" && count !== 1) {
    activePromo = null;
    showPromoMessage("This one-use code applies to a one-lesson booking. Reapply it after choosing one lesson.", "error");
  }
  el("lessonCount").textContent = count ? `${count} lesson${count === 1 ? "" : "s"} · ${count * 45} minutes` : "Choose your lessons";
  const freeLessons = !activePromo || !count ? 0 : activePromo.type === "monthly" ? count : 1;
  el("totalPrice").textContent = `CHF ${Math.max(0, count - freeLessons)}`;
  endSelect.setCustomValidity(end && end < start ? "End lesson must be the same as or later than the start lesson." : "");
  updatePickupOwners();
}

function renderTimetable() {
  timetable.replaceChildren();
  for (let lesson = 1; lesson <= LESSONS; lesson += 1) {
    const available = TOTAL_CABLES - lessonUsed(dayState, lesson);
    const blocked = dayState.blockedLessons.includes(lesson);
    const card = document.createElement("div");
    card.className = `slot-card rounded-2xl border p-4 ${blocked ? "border-slate-200 bg-slate-100" : available === 0 ? "border-rose-100 bg-rose-50" : "border-emerald-100 bg-[#f1f8ed]"}`;
    const title = document.createElement("p");
    title.className = "text-xs font-bold uppercase tracking-wider text-slate-500";
    title.textContent = `Lesson ${lesson}`;
    const time = document.createElement("p");
    time.className = "mt-1 text-xs font-semibold text-slate-600";
    time.textContent = lessonTime(lesson).join("–");
    const count = document.createElement("p");
    count.className = `display-font mt-2 text-xl font-extrabold ${blocked ? "text-slate-500" : available === 0 ? "text-rose-700" : "text-emerald-800"}`;
    count.textContent = blocked ? "Locked" : `${available}/${TOTAL_CABLES}`;
    const note = document.createElement("p");
    note.className = "mt-1 text-xs font-semibold text-slate-500";
    note.textContent = blocked ? "Not bookable" : available === 0 ? "Sold out" : `${available} available`;
    card.append(title, time, count, note);
    timetable.append(card);
  }
  updatePrice();
  renderAdmin();
}

function showBookingMessage(message, type) {
  const box = el("bookingMessage");
  box.textContent = message;
  box.className = `mt-4 rounded-xl px-4 py-3 text-sm font-semibold ${type === "error" ? "bg-rose-50 text-rose-800" : "bg-emerald-50 text-emerald-900"}`;
  box.setAttribute("role", type === "error" ? "alert" : "status");
}

function showPromoMessage(message, type = "info") {
  const box = el("promoMessage");
  box.textContent = message;
  box.className = `mt-1.5 min-h-5 text-xs ${type === "error" ? "font-semibold text-rose-700" : type === "success" ? "font-semibold text-emerald-800" : "text-slate-500"}`;
}

function showAdminError(message) {
  const error = el("adminLoginError");
  error.textContent = message;
  error.classList.remove("hidden");
}

function createBookingCard(booking, completed = false) {
  const card = document.createElement("div");
  card.className = "flex flex-col gap-3 rounded-xl border border-slate-100 bg-white p-3.5 sm:flex-row sm:items-center sm:justify-between";
  const details = document.createElement("div");
  const name = document.createElement("p");
  name.className = "font-bold text-slate-900";
  name.textContent = booking.name;
  const summary = document.createElement("p");
  summary.className = "mt-1 text-xs leading-5 text-slate-500";
  const lessonCount = booking.end - booking.start + 1;
  const amountDue = Math.max(0, lessonCount - (booking.freeLessons || 0));
  const promo = booking.promoCode ? ` · Promo ${booking.promoCode}` : "";
  summary.textContent = `${booking.className} · Lessons ${booking.start}–${booking.end} · CHF ${amountDue} · ${booking.owner}${promo}`;
  details.append(name, summary);
  card.append(details);
  if (!completed) {
    const actions = document.createElement("div");
    actions.className = "flex shrink-0 gap-2";
    for (const [label, action, style] of [
      ["Complete", "complete", "border-emerald-200 text-emerald-800 hover:bg-emerald-50"],
      ["Delete", "delete", "border-rose-200 text-rose-700 hover:bg-rose-50"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.dataset.bookingId = booking.id;
      button.className = `focus-ring rounded-full border px-3 py-1.5 text-xs font-bold ${style}`;
      button.textContent = label;
      button.disabled = busy;
      actions.append(button);
    }
    card.append(actions);
  }
  return card;
}

function renderAdmin() {
  if (!adminLoggedIn) return;
  el("adminDateLabel").textContent = new Date(`${activeDate}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const lessons = el("adminLessons");
  lessons.replaceChildren();
  for (let lesson = 1; lesson <= LESSONS; lesson += 1) {
    const blocked = dayState.blockedLessons.includes(lesson);
    const row = document.createElement("div");
    row.className = "col-span-4 grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:col-span-8 lg:col-span-9 lg:grid-cols-[1fr_1fr_1fr_auto]";
    const title = document.createElement("p");
    title.className = "col-span-2 self-center text-sm font-bold text-slate-800 lg:col-span-1";
    title.textContent = `Lesson ${lesson} · ${lessonTime(lesson)[0]} · ${blocked ? "Locked" : "Open"}`;
    row.append(title);
    for (const owner of OWNERS) {
      const label = document.createElement("label");
      label.className = "text-xs font-semibold text-slate-600";
      label.textContent = `${owner} unavailable`;
      const select = document.createElement("select");
      select.dataset.lesson = String(lesson);
      select.dataset.owner = owner;
      select.className = "focus-ring mt-1 block w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm";
      select.setAttribute("aria-label", `Number of ${owner}'s unavailable cables for lesson ${lesson}`);
      const restricted = database
        ? dayState.slots.filter((slot) => slot.lesson === lesson && slot.owner === owner && slot.restricted).length
        : dayState.restrictions.find((item) => item.lesson === lesson && item.owner === owner)?.cables.length ?? 0;
      for (let count = 0; count <= CABLES_PER_OWNER; count += 1) {
        const option = document.createElement("option");
        option.value = String(count);
        option.textContent = `${count} of 2`;
        option.selected = count === restricted;
        select.append(option);
      }
      select.disabled = busy || blocked;
      label.append(select);
      row.append(label);
    }
    const lockButton = document.createElement("button");
    lockButton.type = "button";
    lockButton.dataset.lesson = String(lesson);
    lockButton.className = `focus-ring col-span-2 rounded-lg border px-3 py-2 text-xs font-bold lg:col-span-1 ${blocked ? "border-emerald-200 text-emerald-800" : "border-rose-200 text-rose-700"}`;
    lockButton.textContent = blocked ? "Unlock all" : "Lock all";
    lockButton.disabled = busy;
    row.append(lockButton);
    lessons.append(row);
  }
  const active = dayState.bookings.filter((booking) => booking.status === "active");
  const completed = dayState.bookings.filter((booking) => booking.status === "completed");
  el("activeCount").textContent = String(active.length);
  el("adminBookings").replaceChildren();
  if (!active.length) {
    const empty = document.createElement("p");
    empty.className = "rounded-xl bg-slate-50 px-4 py-5 text-center text-sm text-slate-500";
    empty.textContent = "No active bookings for this date.";
    el("adminBookings").append(empty);
  } else {
    active.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name)).forEach((booking) => el("adminBookings").append(createBookingCard(booking)));
  }
  el("completedBookings").replaceChildren();
  if (!completed.length) {
    const empty = document.createElement("p");
    empty.className = "text-sm text-slate-400";
    empty.textContent = "No completed bookings yet.";
    el("completedBookings").append(empty);
  } else {
    completed.sort((a, b) => a.start - b.start).forEach((booking) => el("completedBookings").append(createBookingCard(booking, true)));
  }
  renderPromoCodes();
}

function renderPromoCodes() {
  const container = el("adminPromos");
  if (!container) return;
  container.replaceChildren();
  const promos = [...promoCodes].sort((a, b) => a.code.localeCompare(b.code));
  if (!promos.length) {
    const empty = document.createElement("p");
    empty.className = "rounded-xl bg-slate-50 px-4 py-3 text-center text-xs text-slate-500";
    empty.textContent = "No promo codes created yet.";
    container.append(empty);
    return;
  }
  for (const promo of promos) {
    const row = document.createElement("div");
    row.className = "flex flex-col gap-2 rounded-xl border border-slate-100 bg-white p-3 sm:flex-row sm:items-center sm:justify-between";
    const details = document.createElement("div");
    const code = document.createElement("p");
    code.className = "font-mono text-sm font-bold tracking-wider text-slate-900";
    code.textContent = promo.code;
    const description = document.createElement("p");
    description.className = "mt-1 text-xs text-slate-500";
    if (promo.type === "monthly") {
      const expiry = promo.expiresAt?.toDate ? promo.expiresAt.toDate() : new Date(promo.expiresAt);
      description.textContent = expiry > new Date()
        ? `Unlimited free bookings until ${expiry.toLocaleDateString()}`
        : "Monthly promo expired";
    } else {
      description.textContent = promo.redeemed ? "Used · one free lesson" : "Unused · one free lesson";
    }
    details.append(code, description);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.dataset.promoCode = promo.code;
    remove.className = "focus-ring self-start rounded-full border border-rose-200 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-50 sm:self-auto";
    remove.textContent = "Delete";
    remove.disabled = busy;
    row.append(details, remove);
    container.append(row);
  }
}

function setBusy(value) {
  busy = value;
  updatePickupOwners();
  for (const control of document.querySelectorAll("#adminLessons button, #adminLessons select, #adminBookings button, #promoCreateForm button, #promoCreateForm select, #adminPromos button, #applyPromo")) control.disabled = value;
}

function readLocalDay(date) {
  try {
    return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${date}`) || "null");
  } catch (error) {
    console.error("Could not read local booking data:", error);
    throw new Error("Could not read saved browser data. No changes were made.", { cause: error });
  }
}

function loadLocalDay(date) {
  try {
    dayState = normalizeDay(readLocalDay(date));
    setStatus("Demo mode · saved in this browser only", "ready");
  } catch (error) {
    console.error("Local booking data is unavailable:", error);
    setStatus("Could not read saved browser data.", "error");
    showBookingMessage(error.message, "error");
  }
}

function localUpdateDay(date, updater) {
  const latest = normalizeDay(readLocalDay(date));
  const next = updater(latest);
  localStorage.setItem(`${STORAGE_PREFIX}${date}`, JSON.stringify(next));
  if (date === activeDate) {
    dayState = normalizeDay(next);
    renderTimetable();
  }
}

function readLocalPromos() {
  try {
    const value = JSON.parse(localStorage.getItem(PROMO_STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((promo) => promo && typeof promo.code === "string") : [];
  } catch (error) {
    console.error("Could not read local promo codes:", error);
    throw new Error("Could not read saved promo codes. No changes were made.", { cause: error });
  }
}

function writeLocalPromos(promos) {
  localStorage.setItem(PROMO_STORAGE_KEY, JSON.stringify(promos));
  promoCodes = promos;
  renderPromoCodes();
}

function stopSubscriptions() {
  for (const unsubscribe of [...unsubscribeSlots, unsubscribeBlocked, unsubscribeBookings]) {
    if (unsubscribe) unsubscribe();
  }
  unsubscribeSlots = [];
  unsubscribeBlocked = null;
  unsubscribeBookings = null;
}

function subscribeToDate(date) {
  stopSubscriptions();
  dayState = { ...blankDay(), bookings: [] };
  setStatus("Loading live availability…", "loading");
  const blockedRef = firestore.collection(database, "days", date, "blocked");
  unsubscribeSlots = LESSON_TIMES.map((_, index) => {
    const lesson = index + 1;
    const slotsRef = firestore.collection(database, "days", date, "lessons", String(lesson), "cables");
    return firestore.onSnapshot(slotsRef, (snapshot) => {
      dayState.slots = [
        ...dayState.slots.filter((slot) => slot.lesson !== lesson),
        ...snapshot.docs.map((slotDoc) => ({
          id: slotDoc.id,
          lesson,
          owner: slotDoc.data().owner,
          restricted: slotDoc.data().restricted === true
        }))
      ];
      setStatus("Live availability · synced across devices", "ready");
      renderTimetable();
    }, (error) => {
      console.error(`Firestore availability subscription failed for lesson ${lesson}:`, error);
      setStatus("Could not load live availability. Check Authentication and Firestore Rules.", "error");
    });
  });
  unsubscribeBlocked = firestore.onSnapshot(blockedRef, (snapshot) => {
    dayState.blockedLessons = snapshot.docs.map((item) => Number(item.id)).filter((lesson) => lesson >= 1 && lesson <= LESSONS);
    renderTimetable();
  }, (error) => {
    console.error("Firestore lesson-lock subscription failed:", error);
    setStatus("Could not load lesson locks. Check Firestore access.", "error");
  });
  if (adminLoggedIn) subscribeToBookings(date);
}

function subscribeToBookings(date) {
  if (unsubscribeBookings) unsubscribeBookings();
  const bookingsRef = firestore.collection(database, "days", date, "bookings");
  unsubscribeBookings = firestore.onSnapshot(bookingsRef, (snapshot) => {
    dayState.bookings = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderAdmin();
  }, (error) => {
    console.error("Admin booking subscription failed:", error);
    showBookingMessage("Could not load admin bookings. Check the admin account and Firestore rules.", "error");
  });
}

function subscribeToPromos() {
  if (unsubscribePromos) unsubscribePromos();
  const promosRef = firestore.collection(database, "promos");
  unsubscribePromos = firestore.onSnapshot(promosRef, (snapshot) => {
    promoCodes = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    renderPromoCodes();
  }, (error) => {
    console.error("Promo code subscription failed:", error);
    el("promoAdminMessage").textContent = "Could not load promo codes. Check Firestore Rules.";
  });
}

async function initializeData() {
  if (!firebaseConfigured) {
    loadLocalDay(activeDate);
    renderTimetable();
    window.addEventListener("storage", (event) => {
      if (event.key === `${STORAGE_PREFIX}${activeDate}`) {
        loadLocalDay(activeDate);
        renderTimetable();
      }
    });
    return;
  }
  if (!firebaseConfigComplete) {
    setStatus("Firebase config is incomplete. Fill in all web app values.", "error");
    showBookingMessage("Firebase is configured but incomplete. Fill in all Firebase web app values before making bookings.", "error");
    return;
  }
  setStatus("Connecting to live Firebase data…", "loading");
  try {
    const [appModule, firestoreModule, authSdk] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
      import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js")
    ]);
    const app = appModule.initializeApp(firebaseConfig);
    database = firestoreModule.getFirestore(app);
    firestore = firestoreModule;
    authModule = authSdk;
    auth = authSdk.getAuth(app);
    await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
    if (!auth.currentUser?.isAnonymous) {
      if (auth.currentUser) await authSdk.signOut(auth);
      await authSdk.signInAnonymously(auth);
    }
    subscribeToDate(activeDate);
  } catch (error) {
    console.error("Firebase setup failed:", error);
    setStatus("Firebase could not connect. Check the config, Authentication, and Firestore.", "error");
    showBookingMessage("Live data is unavailable. Check your Firebase config, enable Anonymous Authentication, and publish the Firestore rules.", "error");
  }
}

async function createFirebaseBooking({ name, className, start, end, owner, promoCode }) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Your session is not ready. Refresh the page and try again.");
  const bookingId = crypto.randomUUID();
  const bookingRef = firestore.doc(database, "days", activeDate, "bookings", bookingId);
  const quotaRef = firestore.doc(database, "days", activeDate, "bookingLimits", uid);
  const promoRef = promoCode ? firestore.doc(database, "promos", promoCode) : null;
  const blockedRefs = [];
  const slotRefs = [];
  for (let lesson = start; lesson <= end; lesson += 1) {
    blockedRefs.push(firestore.doc(database, "days", activeDate, "blocked", String(lesson)));
    for (const cable of ["1", "2", "3", "4"]) {
      slotRefs.push({
        lesson,
        cable,
        ref: firestore.doc(database, "days", activeDate, "lessons", String(lesson), "cables", cable)
      });
    }
  }
  await firestore.runTransaction(database, async (transaction) => {
    const [quotaSnapshot, blockedSnapshots, slotSnapshots, promoSnapshot] = await Promise.all([
      transaction.get(quotaRef),
      Promise.all(blockedRefs.map((ref) => transaction.get(ref))),
      Promise.all(slotRefs.map((slot) => transaction.get(slot.ref))),
      promoRef ? transaction.get(promoRef) : Promise.resolve(null)
    ]);
    let promoType = null;
    if (promoSnapshot) {
      if (!promoSnapshot.exists()) throw new Error("That promo code was not found.");
      const promo = promoSnapshot.data();
      if (promo.type === "single" && promo.redeemed !== true) promoType = "single";
      else if (promo.type === "monthly" && promo.expiresAt?.toDate().getTime() > Date.now()) promoType = "monthly";
      else throw new Error("That promo code has already been used or expired.");
    }
    const previousCount = quotaSnapshot.exists() ? quotaSnapshot.data().count : 0;
    if (promoType !== "monthly" && (!Number.isInteger(previousCount) || previousCount < 0 || previousCount >= 2)) {
      throw new Error("This anonymous account has reached its limit of 2 bookings for this date. A new browser session may have a separate limit.");
    }
    for (let index = 0; index < blockedSnapshots.length; index += 1) {
      if (blockedSnapshots[index].exists()) throw new Error(`Lesson ${start + index} is locked and cannot be booked.`);
    }
    const cables = [];
    for (let lesson = start; lesson <= end; lesson += 1) {
      const ownerCableIds = owner === "Vincent" ? ["1", "2"] : ["3", "4"];
      const openCable = ownerCableIds.find((cable) => {
        const index = slotRefs.findIndex((slot) => slot.lesson === lesson && slot.cable === cable);
        return !slotSnapshots[index].exists();
      });
      if (!openCable) {
        const allCablesTaken = slotRefs
          .filter((slot) => slot.lesson === lesson)
          .every((slot) => slotSnapshots[slotRefs.indexOf(slot)].exists());
        if (allCablesTaken) throw new Error(`Lesson ${lesson} just sold out. Please choose another time.`);
        throw new Error(`${owner} is fully booked for at least one selected lesson. Please choose ${owner === "Vincent" ? "Max" : "Vincent"} or adjust the lesson range.`);
      }
      cables.push(openCable);
    }
    const booking = {
      id: bookingId,
      date: activeDate,
      uid,
      name,
      className,
      start,
      end,
      owner,
      status: "active",
      cables,
      createdAt: firestore.serverTimestamp()
    };
    if (promoType) {
      booking.promoCode = promoCode;
      booking.freeLessons = promoType === "monthly" ? end - start + 1 : 1;
    }
    if (promoType !== "monthly") {
      booking.limitSlot = String(previousCount + 1);
      transaction.set(quotaRef, {
        bookingId: quotaSnapshot.exists() ? quotaSnapshot.data().bookingId : bookingId,
        lastBookingId: bookingId,
        uid,
        count: previousCount + 1,
        updatedAt: firestore.serverTimestamp()
      });
    }
    transaction.set(bookingRef, booking);
    if (promoType === "single") {
      transaction.update(promoRef, {
        redeemed: true,
        redeemedBookingId: bookingId,
        redeemedDate: activeDate,
        redeemedAt: firestore.serverTimestamp()
      });
    }
    cables.forEach((cable, index) => {
      const lesson = start + index;
      const slotRef = firestore.doc(database, "days", activeDate, "lessons", String(lesson), "cables", cable);
      transaction.set(slotRef, { bookingId, owner });
    });
  });
}

function isPromoUsable(promo) {
  if (!promo) return false;
  if (promo.type === "single") return promo.redeemed !== true;
  const expiresAt = promo.expiresAt?.toDate ? promo.expiresAt.toDate() : new Date(promo.expiresAt);
  return promo.type === "monthly" && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > Date.now();
}

async function validatePromoCode(code) {
  if (!/^[A-Z0-9-]{4,24}$/.test(code)) return null;
  if (database) {
    const promoRef = firestore.doc(database, "promos", code);
    const snapshot = await firestore.getDoc(promoRef);
    return snapshot.exists() ? { code, ...snapshot.data() } : null;
  }
  return readLocalPromos().find((promo) => promo.code === code) || null;
}

function createPromoExpiry() {
  const expiresAt = new Date();
  const dayOfMonth = expiresAt.getDate();
  expiresAt.setDate(1);
  expiresAt.setMonth(expiresAt.getMonth() + 1);
  const lastDayOfMonth = new Date(expiresAt.getFullYear(), expiresAt.getMonth() + 1, 0).getDate();
  expiresAt.setDate(Math.min(dayOfMonth, lastDayOfMonth));
  return expiresAt;
}

async function createFirebasePromo(code, type) {
  const promoRef = firestore.doc(database, "promos", code);
  await firestore.runTransaction(database, async (transaction) => {
    const existing = await transaction.get(promoRef);
    if (existing.exists()) throw new Error("That promo code already exists. Choose another code.");
    const promo = { code, type, createdAt: firestore.serverTimestamp() };
    if (type === "single") promo.redeemed = false;
    else promo.expiresAt = firestore.Timestamp.fromDate(createPromoExpiry());
    transaction.set(promoRef, promo);
  });
}

function generatePromoCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function toggleFirebaseBlock(lesson) {
  const blockedRef = firestore.doc(database, "days", activeDate, "blocked", String(lesson));
  await firestore.runTransaction(database, async (transaction) => {
    const snapshot = await transaction.get(blockedRef);
    if (snapshot.exists()) transaction.delete(blockedRef);
    else transaction.set(blockedRef, { lesson });
  });
}

async function setFirebaseRestriction(lesson, owner, count) {
  const ownerCableIds = owner === "Vincent" ? ["1", "2"] : ["3", "4"];
  const slotRefs = ownerCableIds.map((cable) => firestore.doc(database, "days", activeDate, "lessons", String(lesson), "cables", cable));
  await firestore.runTransaction(database, async (transaction) => {
    const slotSnapshots = await Promise.all(slotRefs.map((ref) => transaction.get(ref)));
    const existingRestricted = slotSnapshots.flatMap((snapshot, index) =>
      snapshot.exists() && snapshot.data().restricted === true ? [ownerCableIds[index]] : []
    );
    const nextRestricted = existingRestricted.slice(0, count);
    const available = slotSnapshots.flatMap((snapshot, index) =>
      !snapshot.exists() ? [ownerCableIds[index]] : []
    );
    nextRestricted.push(...available.slice(0, Math.max(0, count - nextRestricted.length)));
    if (nextRestricted.length !== count) {
      throw new Error(`Only ${nextRestricted.length} of ${owner}'s cables can be restricted in lesson ${lesson} because the others are booked.`);
    }
    for (let index = 0; index < slotRefs.length; index += 1) {
      const cable = ownerCableIds[index];
      const snapshot = slotSnapshots[index];
      if (snapshot.exists() && snapshot.data().restricted === true && !nextRestricted.includes(cable)) {
        transaction.delete(slotRefs[index]);
      } else if (!snapshot.exists() && nextRestricted.includes(cable)) {
        transaction.set(slotRefs[index], { owner, restricted: true });
      }
    }
  });
}

async function updateFirebaseBooking(bookingId, action) {
  const bookingRef = firestore.doc(database, "days", activeDate, "bookings", bookingId);
  await firestore.runTransaction(database, async (transaction) => {
    const snapshot = await transaction.get(bookingRef);
    if (!snapshot.exists()) throw new Error("This booking was already changed. Refresh and try again.");
    const booking = snapshot.data();
    for (let index = 0; index < booking.cables.length; index += 1) {
      const lesson = booking.start + index;
      const slotRef = firestore.doc(database, "days", activeDate, "lessons", String(lesson), "cables", booking.cables[index]);
      transaction.delete(slotRef);
    }
    if (action === "complete") transaction.update(bookingRef, { status: "completed" });
    else transaction.delete(bookingRef);
  });
}

startSelect.addEventListener("change", () => {
  const start = Number(startSelect.value);
  if (Number(endSelect.value) < start) endSelect.value = String(start);
  updatePrice();
});
endSelect.addEventListener("change", updatePrice);
pickupOwnerSelect.addEventListener("change", updatePickupOwners);
el("promoCode").addEventListener("input", () => {
  activePromo = null;
  showPromoMessage("");
  updatePrice();
});
el("applyPromo").addEventListener("click", async () => {
  const code = el("promoCode").value.trim().toUpperCase();
  el("promoCode").value = code;
  activePromo = null;
  updatePrice();
  if (!code) {
    showPromoMessage("Enter a promo code first.", "error");
    return;
  }
  try {
    const promo = await validatePromoCode(code);
    if (!isPromoUsable(promo)) {
      showPromoMessage("This promo code is invalid, already used, or expired.", "error");
      return;
    }
    if (promo.type === "single" && Number(endSelect.value) !== Number(startSelect.value)) {
      showPromoMessage("This one-use code is for a one-lesson booking. Choose one lesson, then apply it again.", "error");
      return;
    }
    activePromo = { code, type: promo.type, expiresAt: promo.expiresAt || null };
    updatePrice();
    showPromoMessage(promo.type === "single"
      ? "Applied: one lesson is free. This code can only be used once."
      : "Applied: unlimited bookings are free until the code expires.", "success");
  } catch (error) {
    console.error("Promo code could not be checked:", error);
    showPromoMessage("Could not check the code. Check your connection and try again.", "error");
  }
});

el("generatePromoCode").addEventListener("click", () => {
  el("newPromoCode").value = generatePromoCode();
});
el("newPromoCode").value = generatePromoCode();

for (let lesson = 1; lesson <= LESSONS; lesson += 1) {
  for (const select of [startSelect, endSelect]) {
    const option = document.createElement("option");
    option.value = String(lesson);
    option.textContent = `Lesson ${lesson} · ${lessonTime(lesson).join("–")}`;
    select.append(option);
  }
}

bookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !bookingForm.reportValidity()) return;
  if (el("promoCode").value.trim() && !activePromo) {
    showPromoMessage("Apply the entered code before booking, or clear the field to continue without it.", "error");
    el("promoCode").focus();
    return;
  }
  const name = el("studentName").value.trim();
  const className = el("studentClass").value.trim();
  const start = Number(startSelect.value);
  const end = Number(endSelect.value);
  const owner = pickupOwnerSelect.value;
  const promo = activePromo;
  const promoCode = promo?.code || "";
  if (!name || !className || start < 1 || end < start || end > LESSONS) {
    showBookingMessage("Please enter your name and class, and choose a valid lesson range.", "error");
    return;
  }
  if (activeDate < localDateString()) {
    showBookingMessage("Bookings for a past date are not available. Please choose today or a future date.", "error");
    return;
  }
  setBusy(true);
  try {
    if (database) {
      await createFirebaseBooking({ name, className, start, end, owner, promoCode });
    } else {
      const promo = promoCode ? await validatePromoCode(promoCode) : null;
      if (promoCode && !isPromoUsable(promo)) throw new Error("That promo code has already been used or expired. Apply a valid code and try again.");
      await localUpdateDay(activeDate, (latest) => {
        for (let lesson = start; lesson <= end; lesson += 1) {
          if (latest.blockedLessons.includes(lesson)) throw new Error(`Lesson ${lesson} is locked and cannot be booked.`);
          const restrictedTotal = latest.restrictions
            .filter((restriction) => restriction.lesson === lesson)
            .reduce((count, restriction) => count + restriction.cables.length, 0);
          if (latest.bookings.filter((booking) => booking.status === "active" && booking.start <= lesson && booking.end >= lesson).length + restrictedTotal >= TOTAL_CABLES) {
            throw new Error(`Lesson ${lesson} just sold out. Please choose another time.`);
          }
          const ownerRestrictions = latest.restrictions
            .filter((restriction) => restriction.lesson === lesson && restriction.owner === owner)
            .reduce((count, restriction) => count + restriction.cables.length, 0);
          const ownerUsedForLesson = latest.bookings.filter((booking) => booking.status === "active" && booking.owner === owner && booking.start <= lesson && booking.end >= lesson).length + ownerRestrictions;
          if (ownerUsedForLesson >= CABLES_PER_OWNER) {
            throw new Error(`${owner} is fully booked for at least one selected lesson. Please choose ${owner === "Vincent" ? "Max" : "Vincent"} or adjust the lesson range.`);
          }
        }
        const freeLessons = !promo ? 0 : promo.type === "monthly" ? end - start + 1 : 1;
        const booking = {
          id: crypto.randomUUID(),
          name,
          className,
          start,
          end,
          owner,
          status: "active",
          ...(promo ? { promoCode, freeLessons } : {}),
          createdAt: new Date().toISOString()
        };
        if (promo?.type === "single") {
          const promos = readLocalPromos();
          const promoIndex = promos.findIndex((item) => item.code === promoCode);
          if (promoIndex < 0 || promos[promoIndex].redeemed) throw new Error("That promo code has already been used. Apply a valid code and try again.");
          promos[promoIndex] = { ...promos[promoIndex], redeemed: true };
          writeLocalPromos(promos);
        }
        return { ...latest, bookings: [...latest.bookings, booking] };
      });
    }
    const freeLessons = !promo ? 0 : promo.type === "monthly" ? end - start + 1 : 1;
    const amountDue = Math.max(0, end - start + 1 - freeLessons);
    bookingForm.reset();
    activePromo = null;
    startSelect.value = "1";
    endSelect.value = "1";
    updatePrice();
    showPromoMessage("");
    showBookingMessage(`Your cable is reserved! Pick it up from ${owner}. ${amountDue ? `Pay CHF ${amountDue} in cash.` : "Your booking is free."}`, "success");
  } catch (error) {
    console.error("Booking could not be saved:", error);
    showBookingMessage(error.message || "Your booking could not be saved. Please try again.", "error");
  } finally {
    setBusy(false);
    renderAdmin();
  }
});

el("adminOpen").addEventListener("click", () => {
  if (!adminDialog.open) adminDialog.showModal();
  el("adminEmail").focus();
});
el("adminClose").addEventListener("click", () => adminDialog.close());
adminDialog.addEventListener("click", (event) => {
  if (event.target === adminDialog) adminDialog.close();
});

el("adminLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = el("adminLoginError");
  error.classList.add("hidden");
  try {
    if (database) {
      const credential = await authModule.signInWithEmailAndPassword(auth, el("adminEmail").value.trim(), el("adminPassword").value);
      const adminRef = firestore.doc(database, "admins", credential.user.uid);
      const adminSnapshot = await firestore.getDoc(adminRef);
      if (!adminSnapshot.exists() || adminSnapshot.data().enabled !== true) {
        await authModule.signInAnonymously(auth);
        throw new Error("This Firebase account is not listed as an admin. Finish the admin setup steps first.");
      }
      adminLoggedIn = true;
    } else if (el("adminPassword").value === DEMO_ADMIN_PASSWORD) {
      adminLoggedIn = true;
    } else {
      throw new Error(`Demo mode password is "${DEMO_ADMIN_PASSWORD}".`);
    }
    el("adminLoginForm").classList.add("hidden");
    el("adminPanel").classList.remove("hidden");
    el("adminPassword").value = "";
    if (database) {
      subscribeToBookings(activeDate);
      subscribeToPromos();
    } else {
      promoCodes = readLocalPromos();
    }
    renderAdmin();
  } catch (loginError) {
    console.error("Admin sign-in failed:", loginError);
    showAdminError(loginError.message || "Sign-in failed. Check your account and try again.");
  }
});

el("adminLogout").addEventListener("click", async () => {
  adminLoggedIn = false;
  if (unsubscribeBookings) unsubscribeBookings();
  if (unsubscribePromos) unsubscribePromos();
  unsubscribeBookings = null;
  unsubscribePromos = null;
  dayState.bookings = [];
  promoCodes = [];
  el("adminPanel").classList.add("hidden");
  el("adminLoginForm").classList.remove("hidden");
  adminDialog.close();
  if (database) {
    try {
      await authModule.signInAnonymously(auth);
    } catch (error) {
      console.error("Could not restore the student session:", error);
      setStatus("Signed out. Refresh to reconnect to live availability.", "error");
    }
  }
});

el("promoCreateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (busy || !form.reportValidity()) return;
  const code = el("newPromoCode").value.trim().toUpperCase();
  const type = el("newPromoType").value;
  setBusy(true);
  el("promoAdminMessage").textContent = "";
  try {
    if (database) {
      await createFirebasePromo(code, type);
    } else {
      const promos = readLocalPromos();
      if (promos.some((promo) => promo.code === code)) throw new Error("That promo code already exists. Choose another code.");
      const promo = { code, type, createdAt: new Date().toISOString() };
      if (type === "single") promo.redeemed = false;
      else promo.expiresAt = createPromoExpiry().toISOString();
      writeLocalPromos([...promos, promo]);
    }
    el("promoAdminMessage").textContent = `${code} created: ${type === "single" ? "one free lesson, usable once." : "unlimited free bookings for one month."}`;
    el("newPromoCode").value = generatePromoCode();
  } catch (error) {
    console.error("Promo code could not be created:", error);
    el("promoAdminMessage").textContent = error.message || "Could not create that promo code.";
  } finally {
    setBusy(false);
    renderAdmin();
  }
});

el("adminPromos").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-promo-code]");
  if (!button || busy) return;
  const { promoCode } = button.dataset;
  if (!globalThis.confirm(`Delete promo code ${promoCode}? It will no longer be accepted.`)) return;
  setBusy(true);
  try {
    if (database) {
      await firestore.deleteDoc(firestore.doc(database, "promos", promoCode));
    } else {
      writeLocalPromos(readLocalPromos().filter((promo) => promo.code !== promoCode));
    }
    el("promoAdminMessage").textContent = `${promoCode} deleted.`;
  } catch (error) {
    console.error("Promo code could not be deleted:", error);
    el("promoAdminMessage").textContent = error.message || "Could not delete that promo code.";
  } finally {
    setBusy(false);
    renderAdmin();
  }
});

el("adminLessons").addEventListener("change", async (event) => {
  const select = event.target.closest("select[data-lesson][data-owner]");
  if (!select || busy) return;
  const lesson = Number(select.dataset.lesson);
  const owner = select.dataset.owner;
  const count = Number(select.value);
  setBusy(true);
  try {
    if (database) {
      await setFirebaseRestriction(lesson, owner, count);
    } else {
      localUpdateDay(activeDate, (latest) => {
        const ownerCableIds = owner === "Vincent" ? ["1", "2"] : ["3", "4"];
        const booked = latest.bookings
          .filter((booking) => booking.status === "active" && booking.owner === owner && booking.start <= lesson && booking.end >= lesson);
        if (count + booked.length > CABLES_PER_OWNER) {
          throw new Error(`Only ${CABLES_PER_OWNER - booked.length} of ${owner}'s cables are currently free in lesson ${lesson}. Cancel a booking first or choose a lower restriction.`);
        }
        const cables = ownerCableIds.slice(0, count);
        const restrictions = latest.restrictions.filter((item) => item.lesson !== lesson || item.owner !== owner);
        if (count) restrictions.push({ lesson, owner, cables });
        return { ...latest, restrictions };
      });
    }
  } catch (error) {
    console.error("Lesson restriction could not be changed:", error);
    showBookingMessage(error.message || "Could not change the lesson restriction.", "error");
  } finally {
    setBusy(false);
    renderAdmin();
  }
});

el("adminLessons").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-lesson]");
  if (!button || busy) return;
  const lesson = Number(button.dataset.lesson);
  setBusy(true);
  try {
    if (database) {
      await toggleFirebaseBlock(lesson);
    } else {
      localUpdateDay(activeDate, (latest) => ({
        ...latest,
        blockedLessons: latest.blockedLessons.includes(lesson)
          ? latest.blockedLessons.filter((item) => item !== lesson)
          : [...latest.blockedLessons, lesson].sort((a, b) => a - b)
      }));
    }
  } catch (error) {
    console.error("Lesson availability could not be changed:", error);
    showBookingMessage(error.message || "Could not change lesson availability.", "error");
  } finally {
    setBusy(false);
    renderAdmin();
  }
});

el("adminBookings").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-booking-id]");
  if (!button || busy) return;
  const { action, bookingId } = button.dataset;
  if (action === "delete" && !window.confirm("Delete this booking? This cannot be undone.")) return;
  setBusy(true);
  try {
    if (database) {
      await updateFirebaseBooking(bookingId, action);
    } else {
      localUpdateDay(activeDate, (latest) => ({
        ...latest,
        bookings: action === "complete"
          ? latest.bookings.map((booking) => booking.id === bookingId ? { ...booking, status: "completed" } : booking)
          : latest.bookings.filter((booking) => booking.id !== bookingId)
      }));
    }
  } catch (error) {
    console.error("Booking could not be updated:", error);
    showBookingMessage(error.message || "Could not update that booking. Check the connection and try again.", "error");
  } finally {
    setBusy(false);
    renderAdmin();
  }
});

dateInput.min = localDateString();
dateInput.value = localDateString();
activeDate = dateInput.value;
dateInput.addEventListener("change", () => {
  if (!dateInput.value) return;
  activeDate = dateInput.value;
  el("bookingMessage").classList.add("hidden");
  if (database) subscribeToDate(activeDate);
  else {
    loadLocalDay(activeDate);
    renderTimetable();
  }
});

renderStatus();
if (!firebaseConfigured) {
  el("adminEmail").required = false;
  el("adminEmail").closest("label").classList.add("hidden");
  document.querySelector("#adminLoginForm > p").textContent = `Demo mode password: ${DEMO_ADMIN_PASSWORD}`;
}
initializeData();
