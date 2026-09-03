// ============================================================
// নেকড়ে-গ্রাম — ক্লায়েন্ট (Nekregram v005)
// ============================================================
const socket = io();
const APP_VERSION = "Nekregram v005";

let myRoomCode = null;
let myRole = null; // {id, name, team, desc}
let fellowWolves = [];
let latestState = null;
let selectedTargetId = null;
let seerResultTimeout = null;

// ------------------------------------------------------------
// সেশন পার্সিস্টেন্স (ঘোস্ট/ডুপ্লিকেট প্লেয়ার বাগ ফিক্স)
// ------------------------------------------------------------
// সার্ভার প্রতিটি খেলোয়াড়কে একটি সেশন টোকেন দেয়, যা localStorage-এ
// রাখা হয়। পেজ রিফ্রেশ বা সাময়িক নেটওয়ার্ক বিচ্ছিন্নতার পর নতুন
// সকেট সংযোগ তৈরি হলে (নতুন socket.id সহ), এই টোকেন দিয়ে সার্ভারকে
// জানানো হয় যে এটি একই খেলোয়াড় — যাতে পুরনো স্লট/রোল ফিরে পাওয়া
// যায় এবং নতুন কোনো "ভূত" প্লেয়ার তৈরি না হয়।
const SESSION_STORAGE_KEY = "nekregram_session";
let rejoinInFlight = false;

function saveSession(code, token) {
  if (!code || !token) return;
  try {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ code, token, name: $("#input-name") ? $("#input-name").value.trim() : "" })
    );
  } catch (e) {
    // localStorage না থাকলে (প্রাইভেট মোড ইত্যাদি) সেশন সংরক্ষণ না
    // হলেও স্বাভাবিক খেলা চালিয়ে যাওয়া যাবে, শুধু রিফ্রেশে রিকানেক্ট
    // করা যাবে না।
  }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch (e) {}
}

// socket.io-এর "connect" ইভেন্ট প্রথমবার সংযোগ স্থাপনের সময়, এবং
// (পেজ রিলোড না হয়ে) নেটওয়ার্ক বিচ্ছিন্নতার পর স্বয়ংক্রিয় পুনরায়
// সংযোগের সময়ও ফায়ার হয় — উভয় ক্ষেত্রেই আমরা সংরক্ষিত সেশন থাকলে
// সেটি দিয়ে rejoinRoom পাঠানোর চেষ্টা করি, যাতে সার্ভার পুরনো
// খেলোয়াড় স্লটেই ফিরিয়ে নেয় (নতুন সকেট আইডি সহ) এবং কোনো ভূত/
// ডুপ্লিকেট এন্ট্রি তৈরি না হয়।
socket.on("connect", () => {
  const session = loadSession();
  if (!session || !session.code || !session.token) return;
  if (rejoinInFlight) return;
  rejoinInFlight = true;

  socket.emit("rejoinRoom", { code: session.code, token: session.token, name: session.name }, (res) => {
    rejoinInFlight = false;
    if (!res || res.error) {
      // সেশনের মেয়াদ শেষ হয়ে গেছে (গ্রেস পিরিয়ড পার হয়ে গেছে, বা
      // রুম আর নেই) — সংরক্ষিত সেশন মুছে হোম স্ক্রিনে ফেরত পাঠানো হয়।
      clearSession();
      if (myRoomCode) {
        myRoomCode = null;
        toast((res && res.error) || "সেশনের মেয়াদ শেষ হয়ে গেছে। আবার যোগ দাও।");
        showScreen("home");
      }
      return;
    }
    myRoomCode = res.code;
    saveSession(res.code, res.token || session.token);
    // বাকি সব — লবি/গেম স্ক্রিন, রোল, বোর্ড ইত্যাদি — সার্ভার থেকে
    // আসা পরবর্তী "state" ইভেন্টের মাধ্যমেই স্বয়ংক্রিয়ভাবে রেন্ডার হবে।
  });
});

socket.on("disconnect", () => {
  if (myRoomCode) toast("সংযোগ বিচ্ছিন্ন হয়েছে — পুনরায় সংযোগের চেষ্টা চলছে...");
});

// গণক ঠাকুরের সাময়িক রোল-রিভিল কার্ড বক্সে দেখানোর জন্য
// (সার্ভার থেকে seerReveal ইভেন্ট এলে সেট হয়, ৩.৫ সেকেন্ড পর নিজে থেকে মুছে যায়)
let seerReveal = null; // { targetId, role, emoji, until }

// ------------------------------------------------------------
// মৃত্যুর সময়কার UI ইফেক্ট — লক্ষ্যযুক্ত (targeted) রেড ব্লিংক /
// ফুল-স্ক্রিন ফ্ল্যাশ, এবং কার্ডে স্থায়ী ক্রস (❌) চিহ্ন
// ------------------------------------------------------------
// playerId -> { until: টাইমস্ট্যাম্প, যতক্ষণ পর্যন্ত কার্ড বক্স লাল ব্লিংক করবে }
const deathBlinks = new Map();
const DEATH_BLINK_MS = 1600; // ১.৬ সেকেন্ড (স্পেক অনুযায়ী ১-২ সেকেন্ডের মধ্যে)
// পূর্ববর্তী state থেকে প্রতিটি খেলোয়াড় জীবিত ছিল কিনা, তা মনে রাখা
// হয় — যাতে ঠিক কে "এইমাত্র" মারা গেছে (নতুন transition) সেটা বোঝা
// যায় এবং শুধু তাদের জন্যই ব্লিংক/ফ্ল্যাশ ট্রিগার হয় (রিলোড করে
// যোগ দেওয়া বা আগে থেকে মৃত খেলোয়াড়দের জন্য নয়)।
let prevAliveMap = new Map();

// ------------------------------------------------------------
// ডেভেলপার / সোলো-টেস্ট মোড — ক্লায়েন্ট স্টেট
// ------------------------------------------------------------
let isDevRoom = false;
let isDevOwner = false;
let devActingAsId = null; // null মানে নিজের (ডেভেলপারের) স্লট হিসেবে অ্যাকশন নেওয়া হচ্ছে
let devPassOK = false; // একই সেশনে বারবার পাসকোড না চাওয়ার জন্য
let effectivePlayerId = null; // বর্তমানে যার হয়ে অ্যাকশন নেওয়া হচ্ছে (ডেভ মোডে বট/নিজে)

// প্রতিটি রোলের ইমোজি — রুলেট হুইল, রোল মডাল, গণকের রিভিল, ডেভ প্যানেল
// সহ পুরো UI জুড়ে একই ম্যাপ ব্যবহার করা হয়
const ROLE_EMOJI = {
  VILLAGER: "🌾",
  WEREWOLF: "🐺",
  SEER: "🔮",
  DOCTOR: "🩺",
  HUNTER: "🏹",
  WITCH: "🧪",
  MAYOR: "📜",
  BODYGUARD: "🛡️",
};

// রুলেট হুইলে দেখানোর জন্য সব রোলের তালিকা (ভিজ্যুয়াল, সার্ভারের চূড়ান্ত ফলাফল আলাদাভাবে আসে)
const WHEEL_ROLES = [
  { id: "VILLAGER", name: "গ্রামবাসী", emoji: ROLE_EMOJI.VILLAGER, team: "গ্রাম" },
  { id: "WEREWOLF", name: "নেকড়ে মানব", emoji: ROLE_EMOJI.WEREWOLF, team: "নেকড়ে" },
  { id: "SEER", name: "গণক ঠাকুর", emoji: ROLE_EMOJI.SEER, team: "গ্রাম" },
  { id: "DOCTOR", name: "ডাক্তার", emoji: ROLE_EMOJI.DOCTOR, team: "গ্রাম" },
  { id: "HUNTER", name: "শিকারী", emoji: ROLE_EMOJI.HUNTER, team: "গ্রাম" },
  { id: "WITCH", name: "ডাইনি বুড়ি", emoji: ROLE_EMOJI.WITCH, team: "গ্রাম" },
  { id: "MAYOR", name: "গ্রামপ্রধান", emoji: ROLE_EMOJI.MAYOR, team: "গ্রাম" },
  { id: "BODYGUARD", name: "পাহাড়াদার", emoji: ROLE_EMOJI.BODYGUARD, team: "গ্রাম" },
];
const WHEEL_COLORS = ["#1d2740", "#2a3350"];

// রোল গোরস্থান সাইডবারে দেখানোর জন্য বাংলা নাম লুকআপ (WHEEL_ROLES থেকে
// পুনরায় ব্যবহৃত, যাতে নামগুলো পুরো UI জুড়ে সামঞ্জস্যপূর্ণ থাকে) এবং
// সাইডবারে রোলগুলো দেখানোর ক্রম (নেকড়ে আগে, তারপর বিশেষ ভূমিকা, শেষে গ্রামবাসী)
const ROLE_NAME_BN = Object.fromEntries(WHEEL_ROLES.map((r) => [r.id, r.name]));
const ROLE_GRAVEYARD_ORDER = [
  "WEREWOLF",
  "SEER",
  "DOCTOR",
  "BODYGUARD",
  "WITCH",
  "HUNTER",
  "MAYOR",
  "VILLAGER",
];

const $ = (sel) => document.querySelector(sel);
const screens = {
  home: $("#screen-home"),
  lobby: $("#screen-lobby"),
  game: $("#screen-game"),
  end: $("#screen-end"),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

// ------------------------------------------------------------
// হোম স্ক্রিন
// ------------------------------------------------------------
$("#btn-create").addEventListener("click", () => {
  const name = $("#input-name").value.trim();
  if (!name) return showHomeError("প্রথমে তোমার নাম লেখো।");
  socket.emit("createRoom", { name }, (res) => {
    if (res.error) return showHomeError(res.error);
    myRoomCode = res.code;
    saveSession(res.code, res.token);
    showScreen("lobby");
  });
});

$("#btn-join").addEventListener("click", () => {
  const name = $("#input-name").value.trim();
  const code = $("#input-code").value.trim().toUpperCase();
  if (!name) return showHomeError("প্রথমে তোমার নাম লেখো।");
  if (!code) return showHomeError("রুম কোড লেখো।");
  socket.emit("joinRoom", { name, code }, (res) => {
    if (res.error) return showHomeError(res.error);
    myRoomCode = res.code;
    saveSession(res.code, res.token);
    showScreen("lobby");
  });
});

function showHomeError(msg) {
  $("#home-error").textContent = msg;
}

// ------------------------------------------------------------
// ডেভেলপার গেট + ড্যাশবোর্ড
// ------------------------------------------------------------
$("#btn-dev-gate").addEventListener("click", () => {
  if (devPassOK) return openDevDashboard();
  $("#dev-passcode-input").value = "";
  $("#dev-gate-error").textContent = "";
  $("#dev-gate-overlay").classList.remove("hidden");
  $("#dev-passcode-input").focus();
});

$("#btn-dev-cancel").addEventListener("click", () => {
  $("#dev-gate-overlay").classList.add("hidden");
});

$("#btn-dev-enter").addEventListener("click", submitDevPasscode);
$("#dev-passcode-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitDevPasscode();
});

function submitDevPasscode() {
  const code = $("#dev-passcode-input").value;
  if (code !== "admin") {
    $("#dev-gate-error").textContent = "ভুল পাসকোড। আবার চেষ্টা করো।";
    return;
  }
  devPassOK = true;
  $("#dev-gate-overlay").classList.add("hidden");
  openDevDashboard();
}

function openDevDashboard() {
  $("#dev-dashboard-error").textContent = "";
  $("#dev-dashboard-overlay").classList.remove("hidden");
}

$("#btn-dev-dashboard-close").addEventListener("click", () => {
  $("#dev-dashboard-overlay").classList.add("hidden");
});

document.querySelectorAll(".dev-count-btn").forEach((btn) => {
  btn.addEventListener("click", () => startDevSolo(parseInt(btn.dataset.count, 10)));
});

function startDevSolo(count) {
  const name = $("#input-name").value.trim() || "ডেভেলপার";
  socket.emit("devStartSolo", { passcode: "admin", playerCount: count, name }, (res) => {
    if (!res || res.error) {
      $("#dev-dashboard-error").textContent = (res && res.error) || "কিছু একটা ভুল হয়েছে।";
      return;
    }
    myRoomCode = res.code;
    isDevRoom = true;
    isDevOwner = true;
    devActingAsId = null;
    selectedTargetId = null;
    // ডেভেলপার সোলো-টেস্ট রুম ডেভেলপারের সংযোগ বিচ্ছিন্ন হলেই সাথে
    // সাথে বন্ধ হয়ে যায় (সার্ভারে কোনো রিকানেক্ট গ্রেস পিরিয়ড নেই),
    // তাই এর জন্য কোনো পুনরায়-সংযোগ সেশন সংরক্ষণ করার দরকার নেই।
    clearSession();
    $("#dev-dashboard-overlay").classList.add("hidden");
    // "state" ইভেন্ট এসে বাকিটা রেন্ডার করবে (গেম সরাসরি রাত দিয়ে শুরু হবে)
  });
}

// ------------------------------------------------------------
// লবি স্ক্রিন
// ------------------------------------------------------------
$("#btn-start").addEventListener("click", () => {
  socket.emit("startGame", { code: myRoomCode }, (res) => {
    if (res && res.error) toast(res.error);
  });
});

$("#btn-leave-lobby").addEventListener("click", leaveRoom);
$("#btn-leave-game").addEventListener("click", leaveRoom);

function leaveRoom() {
  socket.emit("leaveRoom", { code: myRoomCode });
  clearSession();
  myRoomCode = null;
  myRole = null;
  isDevRoom = false;
  isDevOwner = false;
  devActingAsId = null;
  effectivePlayerId = null;
  deathBlinks.clear();
  prevAliveMap.clear();
  document.body.className = "";
  $("#wheel-overlay").classList.add("hidden");
  $("#role-modal-overlay").classList.add("hidden");
  showScreen("home");
}

$("#btn-play-again").addEventListener("click", () => {
  socket.emit("returnToLobby", { code: myRoomCode }, (res) => {
    if (res && res.error) toast(res.error);
  });
});

// ------------------------------------------------------------
// চ্যাট
// ------------------------------------------------------------
$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  socket.emit("sendChat", { code: myRoomCode, message });
  input.value = "";
});

socket.on("chat", ({ name, alive, message }) => {
  const list = $("#chat-list");
  const line = document.createElement("div");
  line.className = "chat-line" + (alive ? "" : " dead");
  line.innerHTML = `<b>${escapeHtml(name)}${alive ? "" : " (মৃত)"}:</b> ${escapeHtml(message)}`;
  list.appendChild(line);
  list.scrollTop = list.scrollHeight;
});

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ------------------------------------------------------------
// রোল অ্যাসাইনমেন্ট — অ্যানিমেটেড রুলেট হুইল + মডাল রিভিল
// ------------------------------------------------------------
socket.on("roleAssigned", ({ role, fellowWolves: fw }) => {
  myRole = role;
  fellowWolves = fw || [];
  spinRoleWheel(role);
});

function buildWheelSegments() {
  const wheel = $("#role-wheel");
  wheel.innerHTML = "";
  wheel.style.transform = "rotate(0deg)";
  wheel.style.transition = "none";
  const n = WHEEL_ROLES.length;
  const segAngle = 360 / n;

  // রঙিন সেক্টর ব্যাকগ্রাউন্ড
  const stops = WHEEL_ROLES.map((_, i) => {
    const color = WHEEL_COLORS[i % WHEEL_COLORS.length];
    return `${color} ${i * segAngle}deg ${(i + 1) * segAngle}deg`;
  }).join(", ");
  wheel.style.background = `conic-gradient(${stops})`;

  // লেবেল বসানো
  const radius = wheel.clientWidth / 2 || 150;
  WHEEL_ROLES.forEach((r, i) => {
    const center = i * segAngle + segAngle / 2;
    const label = document.createElement("div");
    label.className = "wheel-segment-label";
    label.style.transformOrigin = `50% ${radius}px`;
    label.style.transform = `rotate(${center}deg)`;
    label.innerHTML = `<span class="seg-emoji">${r.emoji}</span>${escapeHtml(r.name)}`;
    wheel.appendChild(label);
  });

  // ব্রাউজারকে রিফ্লো করতে বাধ্য করা, যাতে transition আবার কাজ করে
  void wheel.offsetWidth;
  wheel.style.transition = "";
}

function spinRoleWheel(role) {
  const overlay = $("#wheel-overlay");
  overlay.classList.remove("hidden");
  buildWheelSegments();

  const wheel = $("#role-wheel");
  const n = WHEEL_ROLES.length;
  const segAngle = 360 / n;
  let targetIndex = WHEEL_ROLES.findIndex((r) => r.id === role.id);
  if (targetIndex < 0) targetIndex = 0;
  const segCenter = targetIndex * segAngle + segAngle / 2;
  // পয়েন্টার উপরে (0deg) স্থির থাকে; চাকা ঘুরিয়ে সঠিক সেক্টরকে সেখানে আনা হয়
  const jitter = (Math.random() - 0.5) * (segAngle * 0.4);
  const spins = 5; // পূর্ণ ঘূর্ণনের সংখ্যা, নাটকীয়তার জন্য
  const finalRotation = spins * 360 + (360 - segCenter) + jitter;

  requestAnimationFrame(() => {
    wheel.style.transform = `rotate(${finalRotation}deg)`;
  });

  const onDone = () => {
    wheel.removeEventListener("transitionend", onDone);
    overlay.classList.add("hidden");
    showRoleModal(role, { isInitialReveal: true });
  };
  wheel.addEventListener("transitionend", onDone);
  // ফলব্যাক টাইমার, যদি transitionend ইভেন্ট না আসে
  setTimeout(() => {
    if (!overlay.classList.contains("hidden")) onDone();
  }, 5200);
}

// ------------------------------------------------------------
// রোল মডাল (প্রথম রিভিল + "আমার রোল" বাটন উভয়ের জন্য ব্যবহৃত)
// ------------------------------------------------------------
function showRoleModal(role, { isInitialReveal = false } = {}) {
  const overlay = $("#role-modal-overlay");
  const wheelRole = WHEEL_ROLES.find((r) => r.id === role.id);
  $("#role-modal-emoji").textContent = wheelRole ? wheelRole.emoji : "🎭";
  $("#role-modal-team").textContent = role.team === "WEREWOLF" ? "দল: নেকড়ে 🐺" : "দল: গ্রাম 🏡";
  $("#role-modal-name").textContent = role.name;
  $("#role-modal-desc").textContent = role.desc;

  const wolvesEl = $("#role-modal-wolves");
  if (fellowWolves.length) {
    wolvesEl.textContent = `তোমার সহযোগী নেকড়ে: ${fellowWolves.join(", ")}`;
  } else if (role.id === "WEREWOLF") {
    wolvesEl.textContent = "তুমিই একমাত্র নেকড়ে!";
  } else {
    wolvesEl.textContent = "";
  }

  $("#btn-role-modal-close").textContent = isInitialReveal ? "বুঝেছি, খেলা শুরু করি" : "বন্ধ করো";
  overlay.classList.remove("hidden");
}

$("#btn-role-modal-close").addEventListener("click", () => {
  $("#role-modal-overlay").classList.add("hidden");
});

$("#btn-my-role").addEventListener("click", () => {
  if (!myRole) return toast("এখনো তোমার রোল নির্ধারণ হয়নি।");
  showRoleModal(myRole, { isInitialReveal: false });
});

// গণক ঠাকুর কারো পরিচয় যাচাই করলে, সেই খেলোয়াড়ের কার্ড বক্সেই
// ৩.৫ সেকেন্ডের জন্য রোল ইমোজি + বাংলা রোলের নাম দেখানো হয়,
// এরপর নিজে থেকেই আবার নাম-এ ফিরে যায়।
socket.on("seerReveal", ({ targetId, name, role }) => {
  clearTimeout(seerResultTimeout);
  seerReveal = {
    targetId,
    role,
    emoji: ROLE_EMOJI[role.id] || "❓",
    until: Date.now() + 3500,
  };
  toast(`🔮 ${name}-এর পরিচয় জানা গেছে!`);
  renderGame(latestState);
  seerResultTimeout = setTimeout(() => {
    seerReveal = null;
    renderGame(latestState);
  }, 3600);
});

// ------------------------------------------------------------
// প্রধান স্টেট আপডেট
// ------------------------------------------------------------
socket.on("state", (state) => {
  isDevRoom = !!state.isDevRoom;
  isDevOwner = !!state.isDevOwner;
  detectDeathsAndTriggerEffects(state);
  latestState = state;

  // পুনরায় সংযোগের পর (পেজ রিফ্রেশ ইত্যাদি) "roleAssigned" ইভেন্ট
  // আর আসে না, কারণ সেটি শুধু গেম শুরুর সময় একবারই পাঠানো হয়।
  // তাই প্রতিটি state আপডেট থেকেই নিজের রোল ও সহযোগী নেকড়েদের
  // তালিকা সিঙ্ক করে রাখা হয়, যাতে অ্যাকশন ডক ও রোল মডাল
  // রিকানেক্টের পরেও সঠিকভাবে কাজ করে।
  if (state.me && state.me.role) {
    myRole = state.me.role;
    fellowWolves = state.fellowWolves || [];
  }

  if (state.phase === "LOBBY") {
    document.body.className = "";
    prevAliveMap.clear();
    deathBlinks.clear();
    renderLobby(state);
    if (screens.game.classList.contains("active") || screens.end.classList.contains("active")) {
      showScreen("lobby");
    }
  } else if (state.phase === "ENDED") {
    document.body.className = "";
    renderEnd(state);
    showScreen("end");
  } else {
    renderGame(state);
    showScreen("game");
  }
});

// ------------------------------------------------------------
// মৃত্যু সনাক্তকরণ — কোন খেলোয়াড় "এইমাত্র" জীবিত থেকে মৃত হয়েছে তা
// আগের state-এর সাথে তুলনা করে বের করা হয়, তারপর সেই অনুযায়ী
// টার্গেটেড কার্ড ব্লিংক + (প্রয়োজনে) ফুল-স্ক্রিন রেড ফ্ল্যাশ চালু
// করা হয়। সাধারণ মাল্টিপ্লেয়ার ও ডেভেলপার/সোলো-টেস্ট মোড উভয় ক্ষেত্রেই
// একই লজিক কাজ করে, কারণ state.players-এ বট/আসল খেলোয়াড় সবাই একই
// ফরম্যাটে আসে।
function detectDeathsAndTriggerEffects(state) {
  if (!state || !Array.isArray(state.players)) return;
  if (state.phase === "LOBBY") return;

  // এই মুহূর্তে "আমি কার হয়ে খেলছি/দেখছি" — সাধারণ খেলায় এটি
  // নিজের সকেট আইডি; ডেভেলপার মোডে ড্যাশবোর্ড থেকে বেছে নেওয়া বট/
  // প্লেয়ারের আইডি। শুধুমাত্র এই আইডিটির মৃত্যুতেই ফুল-স্ক্রিন
  // ফ্ল্যাশ দেখা যাবে — বাকি সবার মৃত্যুতে শুধু কার্ড ব্লিংক হবে।
  const selfId = state.me ? state.me.id : socket.id;
  const watchedId = isDevOwner && devActingAsId ? devActingAsId : selfId;

  let anyNewDeath = false;
  state.players.forEach((p) => {
    const wasAlive = prevAliveMap.has(p.id) ? prevAliveMap.get(p.id) : p.alive;
    if (wasAlive === true && p.alive === false) {
      anyNewDeath = true;
      deathBlinks.set(p.id, { until: Date.now() + DEATH_BLINK_MS });
      if (p.id === watchedId) {
        triggerFullScreenDeathFlash();
      }
    }
    prevAliveMap.set(p.id, p.alive);
  });

  if (anyNewDeath) {
    // ব্লিংক শেষ হওয়ার পরে কার্ডটিকে "স্থায়ী ক্রস" অবস্থায় নিয়ে
    // যাওয়ার জন্য পুনরায় রেন্ডার করা প্রয়োজন (এর মধ্যে অন্য কোনো
    // state ইভেন্ট না এলেও যেন ক্রস চিহ্ন সঠিক সময়ে ফুটে ওঠে)।
    setTimeout(() => {
      if (latestState) renderGame(latestState);
    }, DEATH_BLINK_MS + 50);
  }
}

// শুধুমাত্র নিহত খেলোয়াড়ের নিজের স্ক্রিনে ১-২ সেকেন্ডের জন্য পুরো
// স্ক্রিনজুড়ে লাল ফ্ল্যাশ/ব্লিংক দেখানো হয়, যাতে সে সাথে সাথে বুঝতে
// পারে যে সে বহিষ্কৃত/নিহত হয়েছে।
function triggerFullScreenDeathFlash() {
  const el = $("#death-flash");
  if (!el) return;
  el.classList.remove("show");
  void el.offsetWidth; // রিফ্লো — যাতে একই ম্যাচে দ্বিতীয়বার ট্রিগার হলেও অ্যানিমেশন আবার চালু হয়
  el.classList.add("show");
  clearTimeout(triggerFullScreenDeathFlash._t);
  triggerFullScreenDeathFlash._t = setTimeout(() => el.classList.remove("show"), 1800);
}

// ------------------------------------------------------------
// Wolvesville-স্টাইল রেসপনসিভ গ্রিড লেআউট বসানো
// (আগের বৃত্তাকার "circle-wrap" লেআউটের পরিবর্তে)
// ------------------------------------------------------------
// খেলোয়াড় সংখ্যা অনুযায়ী কার্ড বক্সের ন্যূনতম প্রস্থ ঠিক করা হয়,
// যাতে কম খেলোয়াড়ে (৪-৮) বক্স বড় দেখায়, আর বেশি খেলোয়াড়ে (১২-১৬)
// বক্স ছোট হয়ে স্ক্রলবার ছাড়াই স্ক্রিনে ধরে যায়। ছোট মোবাইল স্ক্রিনে
// (সরু ভিউপোর্ট) আরও কমপ্যাক্ট মান ব্যবহার করা হয়, যাতে প্রতি সারিতে
// পর্যাপ্ত কলাম ধরে এবং কার্ড অস্বাভাবিক বড়/লম্বা না হয়ে যায়।
function cardMinWidthFor(count) {
  const narrow = window.innerWidth < 420;
  if (count <= 6) return narrow ? 118 : 150;
  if (count <= 8) return narrow ? 100 : 128;
  if (count <= 12) return narrow ? 82 : 104;
  return narrow ? 68 : 86;
}

function layoutGrid(container, players, renderCard) {
  container.classList.add("player-grid");
  const count = players.length || 1;
  container.style.setProperty("--card-min", `${cardMinWidthFor(count)}px`);
  container.dataset.count = String(count);
  container.innerHTML = "";
  players.forEach((p) => {
    const el = renderCard(p);
    container.appendChild(el);
  });
}

// উইন্ডো/অরিয়েন্টেশন রিসাইজ হলে (যেমন ফোন ঘুরিয়ে ল্যান্ডস্কেপ করা হলে,
// বা ব্রাউজার উইন্ডো টানাটানি করা হলে) ইতিমধ্যে রেন্ডার করা প্লেয়ার
// গ্রিডগুলোর কার্ড সাইজ পুনরায় হিসাব করে আপডেট করা হয় — পুরো
// renderGame/renderLobby না চালিয়েই, যাতে নির্বাচন/অ্যানিমেশন স্টেট
// অক্ষত থাকে।
function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
window.addEventListener(
  "resize",
  debounce(() => {
    document.querySelectorAll(".player-grid").forEach((grid) => {
      const count = parseInt(grid.dataset.count || "0", 10);
      if (count > 0) {
        grid.style.setProperty("--card-min", `${cardMinWidthFor(count)}px`);
      }
    });
  }, 150)
);
window.addEventListener("orientationchange", () => {
  document.querySelectorAll(".player-grid").forEach((grid) => {
    const count = parseInt(grid.dataset.count || "0", 10);
    if (count > 0) {
      grid.style.setProperty("--card-min", `${cardMinWidthFor(count)}px`);
    }
  });
});

function makeCard(p, { selectable = false, voteCount = 0, canSelectSelf = false } = {}) {
  const el = document.createElement("div");
  el.className = "player-card";
  if (p.isHost) el.classList.add("is-host");
  if (p.id === socket.id) el.classList.add("is-me");
  if (!p.alive) el.classList.add("is-dead");

  // মৃত্যুর ১-২ সেকেন্ডের রেড ব্লিংক এখনো চলছে কিনা তা যাচাই করা হয়।
  // ব্লিংক চলাকালীন ক্রস দেখানো হয় না — ব্লিংক শেষ হওয়ার পরই কার্ডে
  // স্থায়ী ক্রস বসে (স্বাভাবিক খেলা ও ডেভেলপার মোড উভয়েই একইভাবে)।
  const blinkEntry = deathBlinks.get(p.id);
  const isBlinking = !!blinkEntry && Date.now() < blinkEntry.until;
  if (isBlinking) el.classList.add("card-blinking");

  const isSelfTarget = p.id === effectivePlayerIdForSelectability();
  const canSelectThis = selectable && p.alive && (!isSelfTarget || canSelectSelf);
  if (canSelectThis) el.classList.add("selectable");
  if (selectedTargetId === p.id) el.classList.add("is-selected");

  const badge = p.isHost ? "👑" : p.isBot ? "🤖" : "";
  const offline = !p.connected ? `<span class="card-offline">অফলাইন</span>` : "";
  const mayorTag = p.mayorRevealed ? `<span class="card-mayor-tag">📜 গ্রামপ্রধান</span>` : "";
  const cross = !p.alive && !isBlinking ? `<div class="card-cross">❌</div>` : "";

  const showSeerReveal =
    seerReveal && seerReveal.targetId === p.id && Date.now() < seerReveal.until;

  if (showSeerReveal) {
    el.classList.add("is-revealing");
    el.innerHTML = `
      <div class="card-reveal-emoji">${seerReveal.emoji}</div>
      <div class="card-reveal-role">${escapeHtml(seerReveal.role.name)}</div>
    `;
  } else {
    el.innerHTML = `
      ${badge ? `<div class="card-badge">${badge}</div>` : ""}
      <div class="pname">${escapeHtml(p.name)}</div>
      ${offline}
      ${mayorTag}
      ${voteCount > 0 ? `<div class="vote-badge">${voteCount}</div>` : ""}
      ${cross}
    `;
  }

  if (canSelectThis) {
    el.addEventListener("click", () => onTargetSelected(p.id));
  }
  return el;
}

// সাধারণ খেলায় নিজের সকেট আইডি; ডেভেলপার মোডে বর্তমানে যার হয়ে
// অ্যাকশন নেওয়া হচ্ছে তার আইডি — যাতে "নিজেকে বেছে নেওয়া" সঠিকভাবে
// ধরা যায় (ডাক্তার নিজেকে সীমিতভাবে বাঁচাতে পারে, বডিগার্ড পারে না)
function effectivePlayerIdForSelectability() {
  return effectivePlayerId || socket.id;
}

// ------------------------------------------------------------
// লবি রেন্ডার
// ------------------------------------------------------------
function renderLobby(state) {
  myRole = null;
  fellowWolves = [];
  devActingAsId = null;
  $("#wheel-overlay").classList.add("hidden");
  $("#role-modal-overlay").classList.add("hidden");
  $("#lobby-code").textContent = state.code;
  layoutGrid($("#lobby-circle"), state.players, (p) => makeCard(p));
  $("#lobby-count").textContent = state.isDevRoom
    ? `🛠️ ডেভেলপার সোলো-টেস্ট রুম — ${state.players.length} জন খেলোয়াড় (${state.players.length - 1} জন বট)`
    : `${state.players.length} জন যোগ দিয়েছে (শুরু করতে অন্তত ৪ জন দরকার)`;

  const isHost = state.me && state.me.isHost;
  $("#btn-start").style.display = isHost ? "block" : "none";
  $("#btn-start").disabled = state.players.length < 4;
  $("#lobby-wait").style.display = isHost ? "none" : "block";
}

// ------------------------------------------------------------
// গেম স্ক্রিন রেন্ডার
// ------------------------------------------------------------
const PHASE_META = {
  NIGHT: { icon: "🌙", label: "রাত", cls: "phase-night" },
  DAY: { icon: "☀️", label: "আলোচনা", cls: "phase-day" },
  VOTING: { icon: "🗳️", label: "ভোট", cls: "phase-voting" },
  HUNTER_REVENGE: { icon: "🏹", label: "শিকারীর প্রতিশোধ", cls: "phase-voting" },
};

let timerInterval = null;

// ------------------------------------------------------------
// ডেভেলপার নিয়ন্ত্রণ প্যানেল — যেকোনো প্লেয়ারের হয়ে অ্যাকশন নেওয়া
// ------------------------------------------------------------
function getEffectivePlayer(state) {
  const selfId = state.me ? state.me.id : socket.id;
  if (!isDevOwner || !devActingAsId || devActingAsId === selfId) {
    return {
      id: selfId,
      name: state.me ? state.me.name : "",
      alive: state.me ? state.me.alive : false,
      role: myRole,
      witchHealUsed: state.me ? state.me.witchHealUsed : false,
      witchPoisonUsed: state.me ? state.me.witchPoisonUsed : false,
      doctorSelfHealUsed: state.me ? state.me.doctorSelfHealUsed : false,
      mayorRevealed: state.me ? state.me.mayorRevealed : false,
      isSelf: true,
    };
  }
  const pubInfo = state.players.find((p) => p.id === devActingAsId);
  const roleInfo = state.devInfo && state.devInfo.allRoles ? state.devInfo.allRoles[devActingAsId] : null;
  const flags = state.devInfo && state.devInfo.playerFlags ? state.devInfo.playerFlags[devActingAsId] : null;
  return {
    id: devActingAsId,
    name: pubInfo ? pubInfo.name : "",
    alive: pubInfo ? pubInfo.alive : false,
    role: roleInfo || null,
    witchHealUsed: flags ? flags.witchHealUsed : false,
    witchPoisonUsed: flags ? flags.witchPoisonUsed : false,
    doctorSelfHealUsed: flags ? flags.doctorSelfHealUsed : false,
    mayorRevealed: flags ? flags.mayorRevealed : false,
    isSelf: false,
  };
}

function renderDevPanel(state) {
  const panel = $("#dev-panel");
  if (!panel) return;
  if (!isDevOwner || !state.devInfo) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  const switcher = $("#dev-switcher");
  switcher.innerHTML = "";
  const pendingNight = new Set(state.devInfo.pendingNight || []);
  const pendingVote = new Set(state.devInfo.pendingVote || []);
  const selfId = state.me ? state.me.id : socket.id;
  const activeId = devActingAsId || selfId;

  state.players.forEach((p) => {
    const roleInfo = state.devInfo.allRoles[p.id];
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dev-chip";
    if (!p.alive) chip.classList.add("is-dead");
    if (activeId === p.id) chip.classList.add("is-active");
    if (pendingNight.has(p.id) || pendingVote.has(p.id)) chip.classList.add("needs-action");
    const isMe = p.id === selfId;
    const roleEmoji = roleInfo ? ROLE_EMOJI[roleInfo.id] || "" : "";
    chip.innerHTML = `
      <span>${p.isBot ? "🤖" : "🧑"} ${escapeHtml(p.name)}${isMe ? " (তুমি)" : ""}</span>
      <span class="dev-chip-role">${roleInfo ? `${roleEmoji} ${escapeHtml(roleInfo.name)}` : ""}</span>
    `;
    chip.addEventListener("click", () => {
      devActingAsId = isMe ? null : p.id;
      selectedTargetId = null;
      renderGame(latestState);
    });
    switcher.appendChild(chip);
  });
}

function renderGame(state) {
  const meta = PHASE_META[state.phase] || PHASE_META.NIGHT;
  document.body.className = meta.cls;
  $("#phase-icon").textContent = meta.icon;
  $("#phase-label").textContent =
    state.phase === "NIGHT"
      ? `রাত ${state.dayNumber}`
      : state.phase === "HUNTER_REVENGE"
      ? meta.label
      : `${meta.label} — দিন ${state.dayNumber}`;

  // টাইমার
  clearInterval(timerInterval);
  const updateTimer = () => {
    if (!state.phaseEndsAt) { $("#timer").textContent = "--"; return; }
    const remain = Math.max(0, Math.round((state.phaseEndsAt - Date.now()) / 1000));
    $("#timer").textContent = `${remain}s`;
  };
  updateTimer();
  timerInterval = setInterval(updateTimer, 500);

  // ব্যানার (সর্বশেষ লগ লাইন)
  $("#game-banner").textContent = state.log.length ? state.log[state.log.length - 1].text : "";

  // লগ তালিকা
  const logList = $("#log-list");
  logList.innerHTML = state.log.map((l) => `<div>${escapeHtml(l.text)}</div>`).join("");
  logList.scrollTop = logList.scrollHeight;

  // ডেভেলপার মোডে বর্তমানে কার হয়ে অ্যাকশন নেওয়া হচ্ছে তা নির্ধারণ
  const effective = getEffectivePlayer(state);
  effectivePlayerId = effective.id;
  renderDevPanel(state);

  // ভোটের সময় গ্রিডে ভোট সংখ্যা দেখানো
  const voteCounts = state.voteCounts || {};
  const isPendingHunter = state.phase === "HUNTER_REVENGE" && state.pendingHunterId === effective.id;
  const selectable =
    (state.phase === "VOTING" && effective.alive) ||
    (state.phase === "NIGHT" && canActTonight(effective)) ||
    isPendingHunter;

  if (!selectable) selectedTargetId = null;

  // ডাক্তার নিজেকে সর্বোচ্চ একবার বাঁচাতে পারে; বাকি সব ভূমিকায়
  // (বডিগার্ডসহ) নিজেকে বেছে নেওয়া যায় না
  const canSelectSelf =
    state.phase === "NIGHT" &&
    effective.role &&
    effective.role.id === "DOCTOR" &&
    !effective.doctorSelfHealUsed;

  layoutGrid($("#game-circle"), state.players, (p) =>
    makeCard(p, { selectable, voteCount: voteCounts[p.id] || 0, canSelectSelf })
  );

  renderActionDock(state, effective);
  renderStatusPanel(state);
  renderRoleGraveyard(state);
}

// ------------------------------------------------------------
// Wolvesville-স্টাইল রোল গোরস্থান / অবশিষ্ট রোল সাইডবার উইজেট
// ------------------------------------------------------------
// এই ম্যাচে মোট কোন রোল কতবার আছে (state.roleDeckCounts, পাবলিক
// তথ্য) ও এখন পর্যন্ত মারা যাওয়া খেলোয়াড়দের রোল অনুযায়ী গণনা
// (state.deadRoleCounts) ব্যবহার করে প্রতিটি রোলের প্রতিটি "কপি"
// আলাদা সারি হিসেবে দেখানো হয়। কোনো নির্দিষ্ট রোলের একজন খেলোয়াড়
// মারা গেলে, সেই রোলের একটি সারিতে line-through বসে যায় (কে কোনটা
// পেয়েছে তা প্রকাশ না করেই) — জীবিত খেলোয়াড়দের রোল অপরিবর্তিত/পরিষ্কার থাকে।
function renderRoleGraveyard(state) {
  const list = $("#role-graveyard-list");
  if (!list) return;

  const totalCounts = state.roleDeckCounts || {};
  const deadCounts = state.deadRoleCounts || {};

  const rows = [];
  ROLE_GRAVEYARD_ORDER.forEach((roleId) => {
    const total = totalCounts[roleId] || 0;
    if (!total) return;
    const dead = Math.min(deadCounts[roleId] || 0, total);
    const emoji = ROLE_EMOJI[roleId] || "❓";
    const name = ROLE_NAME_BN[roleId] || roleId;
    for (let i = 0; i < total; i++) {
      const isEliminated = i < dead;
      rows.push(`
        <div class="graveyard-row${isEliminated ? " is-eliminated" : ""}">
          <span class="graveyard-emoji">${emoji}</span>
          <span class="graveyard-name">${escapeHtml(name)}</span>
        </div>
      `);
    }
  });

  list.innerHTML = rows.join("") || `<p class="muted">এখনো তথ্য পাওয়া যায়নি।</p>`;
}

// ------------------------------------------------------------
// জীবিত/বহিষ্কৃত স্ট্যাটাস প্যানেল
// ------------------------------------------------------------
function renderStatusPanel(state) {
  const list = $("#status-list");
  if (!list) return;
  list.innerHTML = state.players
    .map((p) => {
      const isMe = p.id === socket.id;
      const initials = escapeHtml(p.name.slice(0, 2));
      const offline = !p.connected ? `<span class="status-offline">(অফলাইন)</span>` : "";
      const mark = p.alive
        ? `<span class="status-mark">✅</span>`
        : `<span class="status-mark">❌</span>`;
      const avatar = p.isHost ? "👑" : p.isBot ? "🤖" : initials;
      return `
        <div class="status-row${p.alive ? "" : " is-dead"}${isMe ? " is-me" : ""}">
          <div class="status-avatar">${avatar}</div>
          <div class="status-name">${escapeHtml(p.name)}${isMe ? " (তুমি)" : ""} ${offline}</div>
          ${mark}
        </div>`;
    })
    .join("");
}

function canActTonight(effective) {
  if (!effective || !effective.alive || !effective.role) return false;
  return ["WEREWOLF", "SEER", "DOCTOR", "WITCH", "BODYGUARD"].includes(effective.role.id);
}

// বাংলা সংখ্যা (কাউন্টার UI-তে ব্যবহারের জন্য, যেমন ১/১ -> ০/১)
function toBanglaDigits(n) {
  const digits = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
  return String(n)
    .split("")
    .map((ch) => (digits[Number(ch)] !== undefined && ch >= "0" && ch <= "9" ? digits[Number(ch)] : ch))
    .join("");
}

function onTargetSelected(playerId) {
  selectedTargetId = playerId;
  renderGame(latestState); // পুনরায় হাইলাইট দেখানোর জন্য
}

// effective: বর্তমানে যার হয়ে অ্যাকশন নেওয়া হচ্ছে — সাধারণ খেলায় এটি সবসময়
// নিজের (state.me) সমতুল্য; ডেভেলপার মোডে ড্যাশবোর্ড থেকে বেছে নেওয়া
// যেকোনো বট/প্লেয়ার হতে পারে
function renderActionDock(state, effective) {
  const dock = $("#action-dock");
  const roleTag = $("#role-tag");
  const body = $("#action-body");
  body.innerHTML = "";

  const actingLabel = effective && !effective.isSelf ? ` (${escapeHtml(effective.name)}-এর হয়ে)` : "";

  if (state.phase === "HUNTER_REVENGE") {
    const isPending = state.pendingHunterId === effective.id;
    roleTag.textContent = (effective.role ? effective.role.name : "") + actingLabel;
    if (isPending) {
      body.innerHTML = `<p class="action-hint">এই খেলোয়াড় মারা গেছে, কিন্তু শেষবারের মতো একজনকে গুলি করে সাথে নিয়ে যেতে পারে।</p>`;
      const fireBtn = document.createElement("button");
      fireBtn.className = "btn btn-primary";
      fireBtn.textContent = selectedTargetId ? "গুলি করো" : "প্রথমে একজনকে বেছে নাও";
      fireBtn.disabled = !selectedTargetId;
      fireBtn.addEventListener("click", () => sendHunterRevenge(selectedTargetId));
      const skipBtn = document.createElement("button");
      skipBtn.className = "btn btn-ghost";
      skipBtn.textContent = "গুলি না করে বিদায় নাও";
      skipBtn.addEventListener("click", () => sendHunterRevenge(null));
      body.appendChild(fireBtn);
      body.appendChild(skipBtn);
    } else {
      body.innerHTML = `<p class="action-hint">একজন শিকারী মারা গেছে ও শেষবারের মতো গুলি চালানোর কথা ভাবছে... অপেক্ষা করো।</p>`;
    }
    return;
  }

  if (!effective || !effective.alive) {
    roleTag.textContent = effective ? `${effective.role ? effective.role.name : ""}${actingLabel} — মারা গেছে 👻` : "";
    body.innerHTML = `<p class="action-hint">এই খেলোয়াড় এখন শুধু দর্শক হিসেবে বাকি খেলা দেখতে পারবে।</p>`;
    return;
  }

  roleTag.textContent = (effective.role ? effective.role.name : "") + actingLabel;

  if (state.phase === "VOTING") {
    body.innerHTML = `<p class="action-hint">বৃত্ত থেকে একজনকে বেছে নাও, তারপর ভোট নিশ্চিত করো।</p>`;
    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.textContent = selectedTargetId ? "ভোট নিশ্চিত করো" : "বেছে নাও অথবা এড়িয়ে যাও";
    btn.addEventListener("click", () => castVote(selectedTargetId));
    const skipBtn = document.createElement("button");
    skipBtn.className = "btn btn-ghost";
    skipBtn.textContent = "ভোট এড়িয়ে যাও";
    skipBtn.addEventListener("click", () => castVote(null));
    body.appendChild(btn);
    body.appendChild(skipBtn);
    return;
  }

  if (state.phase === "DAY") {
    body.innerHTML = `<p class="action-hint">এখন আলোচনার সময়। কে সন্দেহজনক আচরণ করছে বলে মনে হচ্ছে?</p>`;
    if (effective.role && effective.role.id === "MAYOR") {
      if (!effective.mayorRevealed) {
        const revealBtn = document.createElement("button");
        revealBtn.className = "btn btn-secondary";
        revealBtn.textContent = "📜 নিজেকে গ্রামপ্রধান হিসেবে প্রকাশ করো";
        revealBtn.addEventListener("click", () => sendMayorReveal());
        body.appendChild(revealBtn);
      } else {
        const info = document.createElement("p");
        info.className = "action-hint";
        info.textContent = "📜 তুমি প্রকাশিত গ্রামপ্রধান — এখন থেকে তোমার ভোট ২ ভোট হিসেবে গণনা হবে।";
        body.appendChild(info);
      }
    }
    return;
  }

  if (state.phase === "NIGHT") {
    const role = effective.role;
    if (role && role.id === "WEREWOLF") {
      body.innerHTML = `<p class="action-hint">বৃত্ত থেকে আজ রাতের শিকার বেছে নাও।</p>`;
      addConfirmButton(body, "হত্যা নিশ্চিত করো", () => sendNightAction("WOLF_KILL"));
    } else if (role && role.id === "SEER") {
      body.innerHTML = `<p class="action-hint">কার পরিচয় জানতে চাও?</p>`;
      addConfirmButton(body, "পরিচয় যাচাই করো", () => sendNightAction("SEER_CHECK"));
    } else if (role && role.id === "DOCTOR") {
      const remaining = effective.doctorSelfHealUsed ? 0 : 1;
      body.innerHTML = `
        <p class="action-hint">আজ রাতে কাকে রক্ষা করবে? (নিজেকেও বাঁচাতে পারো, তবে সর্বোচ্চ একবার)</p>
        <p class="self-heal-counter">নিজের চিকিৎসা অবশিষ্ট: ${toBanglaDigits(remaining)}/১</p>
      `;
      addConfirmButton(body, "রক্ষা করো", () => sendNightAction("DOCTOR_PROTECT"));
    } else if (role && role.id === "BODYGUARD") {
      body.innerHTML = `<p class="action-hint">আজ রাতে কাকে রক্ষা করবে? (নিজেকে রক্ষা করতে পারবে না)</p>`;
      addConfirmButton(body, "রক্ষা করো", () => sendNightAction("BODYGUARD_PROTECT"));
    } else if (role && role.id === "WITCH") {
      body.innerHTML = `<p class="action-hint">দুটি পোশন — চাইলে একটিও ব্যবহার না করতে পারো।</p>`;
      const healBtn = document.createElement("button");
      healBtn.className = "btn btn-secondary";
      healBtn.textContent = effective.witchHealUsed ? "জীবন-দান (ব্যবহৃত)" : "জীবন-দান পোশন";
      healBtn.disabled = effective.witchHealUsed;
      healBtn.addEventListener("click", () => sendNightAction("WITCH_HEAL"));

      const poisonBtn = document.createElement("button");
      poisonBtn.className = "btn btn-secondary";
      poisonBtn.textContent = effective.witchPoisonUsed ? "বিষ পোশন (ব্যবহৃত)" : "বিষ পোশন";
      poisonBtn.disabled = effective.witchPoisonUsed;
      poisonBtn.addEventListener("click", () => sendNightAction("WITCH_POISON"));

      body.appendChild(healBtn);
      body.appendChild(poisonBtn);
    } else {
      body.innerHTML = `<p class="action-hint">রাত নেমেছে — এই খেলোয়াড় ঘুমিয়ে আছে। বিশেষ ভূমিকার খেলোয়াড়রা কাজ করছে...</p>`;
    }
  }
}

function addConfirmButton(body, label, onClick) {
  const btn = document.createElement("button");
  btn.className = "btn btn-primary";
  btn.textContent = selectedTargetId ? label : "প্রথমে বৃত্ত থেকে একজনকে বেছে নাও";
  btn.disabled = !selectedTargetId;
  btn.addEventListener("click", onClick);
  body.appendChild(btn);
}

// ডেভেলপার মোডে বর্তমানে বেছে নেওয়া প্লেয়ারের হয়ে অ্যাকশন পাঠানোর জন্য
function devAsPlayerPayload() {
  return isDevOwner && effectivePlayerId ? { asPlayerId: effectivePlayerId } : {};
}

function sendNightAction(type) {
  if (!selectedTargetId) return toast("প্রথমে একজনকে বেছে নাও।");
  socket.emit(
    "nightAction",
    { code: myRoomCode, type, targetId: selectedTargetId, ...devAsPlayerPayload() },
    (res) => {
      if (res && res.error) return toast(res.error);
      toast("সিদ্ধান্ত জমা দেওয়া হয়েছে। এখন অন্যদের অপেক্ষায় থাকো।");
      selectedTargetId = null;
    }
  );
}

function sendHunterRevenge(targetId) {
  socket.emit("hunterRevenge", { code: myRoomCode, targetId, ...devAsPlayerPayload() }, (res) => {
    if (res && res.error) return toast(res.error);
    selectedTargetId = null;
  });
}

function sendMayorReveal() {
  socket.emit("mayorReveal", { code: myRoomCode, ...devAsPlayerPayload() }, (res) => {
    if (res && res.error) return toast(res.error);
    toast("তুমি নিজেকে গ্রামপ্রধান হিসেবে প্রকাশ করেছ! এখন তোমার ভোট ২ ভোট।");
  });
}

function castVote(targetId) {
  socket.emit("castVote", { code: myRoomCode, targetId, ...devAsPlayerPayload() }, (res) => {
    if (res && res.error) return toast(res.error);
    toast(targetId ? "ভোট জমা দেওয়া হয়েছে।" : "ভোট এড়িয়ে যাওয়া হয়েছে।");
    selectedTargetId = null;
  });
}

// ------------------------------------------------------------
// সমাপ্তি স্ক্রিন
// ------------------------------------------------------------
function renderEnd(state) {
  clearInterval(timerInterval);
  const isVillage = state.winner === "VILLAGE";
  $("#end-emoji").textContent = isVillage ? "🏡" : "🐺";
  $("#end-title").textContent = isVillage ? "গ্রামবাসীদের জয়!" : "নেকড়েদের জয়!";
  $("#end-sub").textContent = isVillage
    ? "গ্রামবাসীরা সব নেকড়েকে খুঁজে বের করে বহিষ্কার করেছে।"
    : "নেকড়েরা গ্রামের বেশিরভাগ মানুষকে শেষ করে দিয়েছে।";

  const rolesEl = $("#end-roles");
  rolesEl.innerHTML = (state.revealRoles || [])
    .map(
      (p) =>
        `<div>${p.alive ? "🟢" : "⚫"} <b>${escapeHtml(p.name)}</b> — <span>${escapeHtml(p.role || "")}</span></div>`
    )
    .join("");

  const isHost = state.me && state.me.isHost;
  $("#btn-play-again").style.display = isHost ? "block" : "none";
}
