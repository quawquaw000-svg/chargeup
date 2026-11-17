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
const DEMO_ADMIN_PASSWORD = "demo-admin";
const firebaseConfigured = Object.values(firebaseConfig).some((value) => typeof value === "string" && value.trim());
const firebaseConfigComplete = Object.values(firebaseConfig).every((value) => typeof value === "string" && value.trim());

const el = (id) => document.getElementById(id);
const dateInput = el("bookingDate");
const timetable = el("timetable");
const bookingForm = el("bookingForm");
const startSelect = el("startLesson");
const endSelect = el("endLesson");
const adminDialog = el("adminDialog");
let activeDate = "";
let dayState = { bookings: [], blockedLessons: [], slots: [] };
let database = null;
let firestore = null;
let auth = null;
let authModule = null;
let unsubscribeSlots = [];
let unsubscribeBlocked = null;
let unsubscribeBookings = null;
let adminLoggedIn = false;
let busy = false;
let statusKind = "loading";
let statusText = "Connecting…";

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function blankDay() {
  return { bookings: [], blockedLessons: [], slots: [] };
}

function normalizeDay(value) {
  if (!value || typeof value !== "object") return blankDay();
  const bookings = Array.isArray(value.bookings)
    ? value.bookings.filter((booking) => booking && typeof booking.id === "string" && Number.isInteger(booking.start) && Number.isInteger(booking.end) && booking.start >= 1 && booking.end <= LESSONS && booking.start <= booking.end && OWNERS.includes(booking.owner) && ["active", "completed"].includes(booking.status))
    : [];
  const blockedLessons = Array.isArray(value.blockedLessons)
    ? [...new Set(value.blockedLessons.filter((lesson) => Number.isInteger(lesson) && lesson >= 1 && lesson <= LESSONS))]
    : [];
  return { bookings, blockedLessons, slots: [] };
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
  if (database) return state.slots.filter((slot) => slot.lesson === lesson).length;
  return state.bookings.filter((booking) => booking.status === "active" && booking.start <= lesson && booking.end >= lesson).length;
}

function updatePrice() {
  const start = Number(startSelect.value);
  const end = Number(endSelect.value);
  const count = start && end >= start ? end - start + 1 : 0;
  el("lessonCount").textContent = count ? `${count} lesson${count === 1 ? "" : "s"} · ${count * 45} minutes` : "Choose your lessons";
  el("totalPrice").textContent = `CHF ${count}`;
  endSelect.setCustomValidity(end && end < start ? "End lesson must be the same as or later than the start lesson." : "");
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
  summary.textContent = `${booking.className} · Lessons ${booking.start}–${booking.end} · CHF ${booking.end - booking.start + 1} · ${booking.owner}`;
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
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.lesson = String(lesson);
    button.className = `focus-ring rounded-xl border px-2 py-2 text-xs font-bold ${blocked ? "border-rose-200 bg-rose-50 text-rose-800" : "border-slate-200 bg-white text-slate-700 hover:border-emerald-300"}`;
    button.textContent = `L${lesson} ${lessonTime(lesson)[0]} · ${blocked ? "Locked" : "Open"}`;
    button.disabled = busy;
    lessons.append(button);
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
}

function setBusy(value) {
  busy = value;
  el("submitBooking").disabled = value;
  for (const button of document.querySelectorAll("#adminLessons button, #adminBookings button")) button.disabled = value;
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
          owner: slotDoc.data().owner
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
    await authSdk.setPersistence(auth, authSdk.browserSessionPersistence);
    await authSdk.signInAnonymously(auth);
    subscribeToDate(activeDate);
  } catch (error) {
    console.error("Firebase setup failed:", error);
    setStatus("Firebase could not connect. Check the config, Authentication, and Firestore.", "error");
    showBookingMessage("Live data is unavailable. Check your Firebase config, enable Anonymous Authentication, and deploy firestore.rules.", "error");
  }
}

function ownerCableIds(owner) {
  return owner === "Vincent" ? ["1", "2"] : ["3", "4"];
}

function ownerForLocalBooking(state, start, end) {
  const candidates = OWNERS.map((owner) => {
    let load = 0;
    let canServe = true;
    for (let lesson = start; lesson <= end; lesson += 1) {
      const ownerLoad = state.bookings.filter((booking) => booking.status === "active" && booking.owner === owner && booking.start <= lesson && booking.end >= lesson).length;
      load += ownerLoad;
      if (ownerLoad >= CABLES_PER_OWNER) canServe = false;
    }
    return { owner, load, canServe };
  }).filter((candidate) => candidate.canServe);
  candidates.sort((a, b) => a.load - b.load || OWNERS.indexOf(a.owner) - OWNERS.indexOf(b.owner));
  return candidates[0]?.owner || null;
}

async function createFirebaseBooking({ name, className, start, end }) {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error("Your session is not ready. Refresh the page and try again.");
  const bookingId = crypto.randomUUID();
  const bookingRef = firestore.doc(database, "days", activeDate, "bookings", bookingId);
  const slotRefs = [];
  const blockedRefs = [];
  for (let lesson = start; lesson <= end; lesson += 1) {
    blockedRefs.push(firestore.doc(database, "days", activeDate, "blocked", String(lesson)));
    for (const cable of ["1", "2", "3", "4"]) {
      slotRefs.push({ lesson, cable, ref: firestore.doc(database, "days", activeDate, "lessons", String(lesson), "cables", cable) });
    }
  }
  await firestore.runTransaction(database, async (transaction) => {
    const [blockedSnapshots, slotSnapshots] = await Promise.all([
      Promise.all(blockedRefs.map((ref) => transaction.get(ref))),
      Promise.all(slotRefs.map((slot) => transaction.get(slot.ref)))
    ]);
    for (let index = 0; index < blockedSnapshots.length; index += 1) {
      if (blockedSnapshots[index].exists()) throw new Error(`Lesson ${start + index} is locked and cannot be booked.`);
    }
    const candidates = OWNERS.map((owner) => {
      let score = 0;
      const cables = [];
      let available = true;
      for (let lesson = start; lesson <= end; lesson += 1) {
        const ownerCables = ownerCableIds(owner);
        const openCable = ownerCables.find((cable) => {
          const index = slotRefs.findIndex((slot) => slot.lesson === lesson && slot.cable === cable);
          if (slotSnapshots[index].exists()) {
            score += 1;
            return false;
          }
          return true;
        });
        if (!openCable) {
          available = false;
          break;
        }
        cables.push(openCable);
      }
      return { owner, score, cables, available };
    }).filter((candidate) => candidate.available);
    candidates.sort((a, b) => a.score - b.score || OWNERS.indexOf(a.owner) - OWNERS.indexOf(b.owner));
    const selected = candidates[0];
    if (!selected) {
      const fullLesson = Array.from({ length: end - start + 1 }, (_, index) => start + index)
        .find((lesson) => slotRefs.filter((slot) => slot.lesson === lesson)
          .every((slot) => slotSnapshots[slotRefs.indexOf(slot)].exists()));
      if (fullLesson) throw new Error(`Lesson ${fullLesson} just sold out. Please choose another time.`);
      throw new Error("No cable owner is available for every lesson in that range. Please choose another time.");
    }
    const booking = {
      id: bookingId,
      uid,
      name,
      className,
      start,
      end,
      owner: selected.owner,
      status: "active",
      cables: selected.cables,
      createdAt: firestore.serverTimestamp()
    };
    transaction.set(bookingRef, booking);
    selected.cables.forEach((cable, index) => {
      const lesson = start + index;
      const slotRef = firestore.doc(database, "days", activeDate, "lessons", String(lesson), "cables", cable);
      transaction.set(slotRef, { bookingId, owner: selected.owner });
    });
  });
}

async function toggleFirebaseBlock(lesson) {
  const blockedRef = firestore.doc(database, "days", activeDate, "blocked", String(lesson));
  await firestore.runTransaction(database, async (transaction) => {
    const snapshot = await transaction.get(blockedRef);
    if (snapshot.exists()) transaction.delete(blockedRef);
    else transaction.set(blockedRef, { lesson });
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
  const name = el("studentName").value.trim();
  const className = el("studentClass").value.trim();
  const start = Number(startSelect.value);
  const end = Number(endSelect.value);
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
      await createFirebaseBooking({ name, className, start, end });
    } else {
      await localUpdateDay(activeDate, (latest) => {
        for (let lesson = start; lesson <= end; lesson += 1) {
          if (latest.blockedLessons.includes(lesson)) throw new Error(`Lesson ${lesson} is locked and cannot be booked.`);
          if (latest.bookings.filter((booking) => booking.status === "active" && booking.start <= lesson && booking.end >= lesson).length >= TOTAL_CABLES) {
            throw new Error(`Lesson ${lesson} just sold out. Please choose another time.`);
          }
        }
        const owner = ownerForLocalBooking(latest, start, end);
        if (!owner) throw new Error("No cable owner is available for every lesson in that range. Please choose another time.");
        const booking = {
          id: crypto.randomUUID(),
          name,
          className,
          start,
          end,
          owner,
          status: "active",
          createdAt: new Date().toISOString()
        };
        return { ...latest, bookings: [...latest.bookings, booking] };
      });
    }
    bookingForm.reset();
    startSelect.value = "1";
    endSelect.value = "1";
    updatePrice();
    showBookingMessage("Your cable is reserved! Pay cash to Vincent or Max when you pick it up.", "success");
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
    if (database) subscribeToBookings(activeDate);
    renderAdmin();
  } catch (loginError) {
    console.error("Admin sign-in failed:", loginError);
    showAdminError(loginError.message || "Sign-in failed. Check your account and try again.");
  }
});

el("adminLogout").addEventListener("click", async () => {
  adminLoggedIn = false;
  if (unsubscribeBookings) unsubscribeBookings();
  unsubscribeBookings = null;
  dayState.bookings = [];
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
