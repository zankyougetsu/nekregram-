// ============================================================
// নেকড়ে-গ্রাম (Nekre-Gram) — Server
// একটি বাংলা সোশ্যাল ডিডাকশন মাল্টিপ্লেয়ার গেম (Wolvesville-অনুপ্রাণিত)
// LAN এবং অনলাইন উভয় ক্ষেত্রেই কাজ করে — কারণ এটি শুধু একটি
// সাধারণ Node.js + Socket.io সার্ভার, যা যেকোনো নেটওয়ার্কে চলতে পারে।
//
// Nekregram v005
// ============================================================
const APP_VERSION = "Nekregram v005";

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(express.static(path.join(__dirname, "public")));

// ------------------------------------------------------------
// কনফিগারেশন (Timings in ms)
// ------------------------------------------------------------
const DURATIONS = {
  night: 35_000,
  dayDiscussion: 60_000,
  voting: 30_000,
  reveal: 8_000,
  hunterRevenge: 15_000,
};

// রোলের তালিকা এবং বাংলা বিবরণ
const ROLES = {
  VILLAGER: {
    id: "VILLAGER",
    name: "গ্রামবাসী",
    team: "VILLAGE",
    desc: "তোমার কোনো বিশেষ ক্ষমতা নেই। আলোচনা করে ও ভোট দিয়ে নেকড়েদের খুঁজে বের করো।",
  },
  WEREWOLF: {
    id: "WEREWOLF",
    name: "নেকড়ে মানব",
    team: "WEREWOLF",
    desc: "প্রতি রাতে অন্য নেকড়েদের সাথে মিলে একজন গ্রামবাসীকে হত্যা করো। নিজের পরিচয় গোপন রাখো।",
  },
  SEER: {
    id: "SEER",
    name: "গণক ঠাকুর",
    team: "VILLAGE",
    desc: "প্রতি রাতে একজন খেলোয়াড়ের আসল পরিচয় (নেকড়ে না গ্রামবাসী) জানতে পারবে।",
  },
  DOCTOR: {
    id: "DOCTOR",
    name: "ডাক্তার",
    team: "VILLAGE",
    desc: "প্রতি রাতে একজনকে রক্ষা করতে পারো, এমনকি নিজেকেও (একবারের বেশি নিজেকে না)।",
  },
  HUNTER: {
    id: "HUNTER",
    name: "শিকারী",
    team: "VILLAGE",
    desc: "যদি তুমি মারা যাও (রাতে বা ভোটে), মৃত্যুর আগে আরেকজনকে গুলি করে সাথে নিয়ে যেতে পারবে।",
  },
  WITCH: {
    id: "WITCH",
    name: "ডাইনি বুড়ি",
    team: "VILLAGE",
    desc: "তোমার একটি জীবন-দান পোশন ও একটি বিষ পোশন আছে — পুরো খেলায় একবার করে ব্যবহার করতে পারবে।",
  },
  MAYOR: {
    id: "MAYOR",
    name: "গ্রামপ্রধান",
    team: "VILLAGE",
    desc: "আলোচনার সময় চাইলে নিজের পরিচয় প্রকাশ করতে পারো। প্রকাশ করলে, এরপর থেকে সব ভোটে তোমার ভোট দ্বিগুণ (২ ভোট) হিসেবে গণনা হবে।",
  },
  BODYGUARD: {
    id: "BODYGUARD",
    name: "পাহাড়াদার",
    team: "VILLAGE",
    desc: "প্রতি রাতে একজনকে রক্ষার জন্য বেছে নাও (নিজেকে নয়)। নেকড়েরা তাকে আক্রমণ করলে, তুমি তাকে বাঁচিয়ে নিজে তার বদলে মারা যাবে।",
  },
};

// খেলোয়াড় সংখ্যা অনুযায়ী রোল বণ্টন
function buildRoleDeck(playerCount) {
  const deck = [];
  const wolfCount = Math.max(1, Math.floor(playerCount / 4));
  for (let i = 0; i < wolfCount; i++) deck.push("WEREWOLF");

  if (playerCount >= 4) deck.push("SEER");
  if (playerCount >= 5) deck.push("DOCTOR");
  if (playerCount >= 6) deck.push("BODYGUARD");
  if (playerCount >= 7) deck.push("HUNTER");
  if (playerCount >= 8) deck.push("WITCH");
  if (playerCount >= 9) deck.push("MAYOR");

  while (deck.length < playerCount) deck.push("VILLAGER");
  return deck.slice(0, playerCount);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------------------
// ডেভেলপার / সোলো-টেস্ট মোড
// ------------------------------------------------------------
const DEV_PASSCODE = "admin";

// একটি রুমে ডেভেলপার নিজে বা কোনো বট প্লেয়ারের হয়ে অ্যাকশন
// নিতে চাইলে, এই ফাংশন যাচাই করে আসল অ্যাক্টিং আইডি ঠিক করে দেয়।
// সাধারণ (নন-ডেভ) রুমে এটি সবসময় socketId-ই ফেরত দেয় — তাই
// স্বাভাবিক গেমপ্লে একদম অপরিবর্তিত থাকে।
function resolveActingId(room, socketId, asPlayerId) {
  if (
    room.isDev &&
    room.devOwnerId === socketId &&
    asPlayerId &&
    room.players.has(asPlayerId)
  ) {
    return asPlayerId;
  }
  return socketId;
}

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

// ------------------------------------------------------------
// রুম স্টেট
// ------------------------------------------------------------
const rooms = new Map(); // code -> room

function createRoom(hostSocketId, hostName, opts = {}) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    players: new Map(), // socketId -> player
    phase: "LOBBY", // LOBBY | NIGHT | DAY | VOTING | REVEAL | ENDED
    dayNumber: 0,
    nightActions: {},
    dayVotes: {},
    log: [],
    timer: null,
    winner: null,
    lastNightResult: null,
    phaseEndsAt: null,
    pendingHunterId: null,
    _hunterContinue: null,
    // ডেভেলপার সোলো-টেস্ট রুম কিনা, এবং কে সেটার মালিক (আসল সকেট)
    isDev: !!opts.isDev,
    devOwnerId: opts.isDev ? hostSocketId : null,
    // Wolvesville-স্টাইল "রোল গোরস্থান" উইজেটের জন্য — এই ম্যাচে
    // মোট কোন কোন রোল কতবার বণ্টিত হয়েছে (এটি গোপন কোনো তথ্য না,
    // কে কোন রোল পেয়েছে সেটা জানায় না — শুধু রোলের সংখ্যা জানায়)
    roleDeckCounts: null,
  };
  rooms.set(code, room);
  addPlayer(room, hostSocketId, hostName, { isHost: true });
  return room;
}

function addPlayer(room, socketId, name, { isHost = false, isBot = false } = {}) {
  room.players.set(socketId, {
    id: socketId,
    name: (name || "").slice(0, 20) || "খেলোয়াড়",
    role: null,
    alive: true,
    isHost,
    isBot,
    connected: true,
    usedHunterRevenge: false,
    witchHealUsed: false,
    witchPoisonUsed: false,
    doctorSelfHealUsed: false,
    mayorRevealed: false,
    protectedTonight: false,
  });
}

function alivePlayers(room) {
  return [...room.players.values()].filter((p) => p.alive);
}

function findRole(room, socketId, roleId) {
  const p = room.players.get(socketId);
  return p && p.alive && p.role === roleId ? p : null;
}

function pushLog(room, messageBn) {
  room.log.push({ t: Date.now(), text: messageBn });
  if (room.log.length > 200) room.log.shift();
}

// Wolvesville-স্টাইল রোল গোরস্থান উইজেটের জন্য — এখন পর্যন্ত মারা
// যাওয়া খেলোয়াড়দের রোল অনুযায়ী গণনা। মৃত খেলোয়াড়ের রোল ইতিমধ্যেই
// মৃত্যুর সময় লগে (public) প্রকাশ করা হয়, তাই এটি নতুন কোনো গোপন
// তথ্য ফাঁস করে না।
function countDeadRoles(room) {
  const counts = {};
  for (const p of room.players.values()) {
    if (!p.alive && p.role) counts[p.role] = (counts[p.role] || 0) + 1;
  }
  return counts;
}

// ------------------------------------------------------------
// পাবলিক স্টেট (প্রতিটি খেলোয়াড়ের জন্য কাস্টমাইজড, যাতে
// অন্যের গোপন রোল ফাঁস না হয়)
// ------------------------------------------------------------
function stateFor(room, socketId) {
  const me = room.players.get(socketId);
  const wolfIds = [...room.players.values()]
    .filter((p) => p.role === "WEREWOLF")
    .map((p) => p.id);

  // ডেভেলপার সোলো-টেস্ট রুমে, রুমের মালিক (আসল ডেভেলপার সকেট) সব
  // খেলোয়াড়ের গোপন রোল দেখতে পায় ও কার অ্যাকশন/ভোট বাকি আছে তা
  // জানতে পারে, যাতে সে বট/নিজের হয়ে যেকোনো পদক্ষেপ নিতে পারে।
  const isDevOwner = !!(room.isDev && room.devOwnerId === socketId);
  let devInfo = null;
  if (isDevOwner) {
    const allRoles = {};
    for (const p of room.players.values()) {
      allRoles[p.id] = p.role ? ROLES[p.role] : null;
    }
    const requiredVoters = [...room.players.values()].filter(
      (p) => p.alive && ["WEREWOLF", "SEER", "DOCTOR", "WITCH", "BODYGUARD"].includes(p.role)
    );
    const nightSubmitted = new Set(Object.keys(room.nightActions));
    const pendingNight =
      room.phase === "NIGHT"
        ? requiredVoters
            .filter(
              (p) =>
                !(p.role === "WITCH" && p.witchHealUsed && p.witchPoisonUsed) &&
                !nightSubmitted.has(p.id)
            )
            .map((p) => p.id)
        : [];
    const voteSubmitted = new Set(Object.keys(room.dayVotes));
    const pendingVote =
      room.phase === "VOTING"
        ? alivePlayers(room)
            .filter((p) => !voteSubmitted.has(p.id))
            .map((p) => p.id)
        : [];
    const playerFlags = {};
    for (const p of room.players.values()) {
      playerFlags[p.id] = {
        witchHealUsed: p.witchHealUsed,
        witchPoisonUsed: p.witchPoisonUsed,
        doctorSelfHealUsed: p.doctorSelfHealUsed,
        mayorRevealed: p.mayorRevealed,
      };
    }
    devInfo = { allRoles, pendingNight, pendingVote, playerFlags };
  }

  return {
    code: room.code,
    phase: room.phase,
    dayNumber: room.dayNumber,
    hostId: room.hostId,
    winner: room.winner,
    lastNightResult: room.lastNightResult,
    phaseEndsAt: room.phaseEndsAt,
    pendingHunterId: room.pendingHunterId,
    log: room.log.slice(-30),
    isDevRoom: !!room.isDev,
    isDevOwner,
    devInfo,
    appVersion: APP_VERSION,
    me: me
      ? {
          id: me.id,
          name: me.name,
          role: me.role ? ROLES[me.role] : null,
          alive: me.alive,
          isHost: me.isHost,
          witchHealUsed: me.witchHealUsed,
          witchPoisonUsed: me.witchPoisonUsed,
          doctorSelfHealUsed: me.doctorSelfHealUsed,
          mayorRevealed: me.mayorRevealed,
        }
      : null,
    // এই তালিকা শুধু নেকড়েদের কাছে পাঠানো হয় (নিচে দেখুন)
    fellowWolves: me && me.role === "WEREWOLF"
      ? wolfIds.filter((id) => id !== socketId).map((id) => room.players.get(id).name)
      : [],
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      isHost: p.isHost,
      connected: p.connected,
      isBot: !!p.isBot,
      // গ্রামপ্রধান একবার নিজেকে প্রকাশ করলে সেটি জনসমক্ষে জানা তথ্য
      mayorRevealed: !!p.mayorRevealed,
      // মৃত খেলোয়াড়ের রোল ইতিমধ্যেই মৃত্যুর সময় লগে প্রকাশ্যে জানানো
      // হয়েছে, তাই এখানে পাঠালে নতুন কোনো গোপন তথ্য ফাঁস হয় না —
      // ক্লায়েন্ট এটি কার্ড বক্সের ক্রস মার্ক ও রোল গোরস্থানের জন্য
      // ব্যবহার করে। জীবিত খেলোয়াড়ের রোল কখনোই এখানে পাঠানো হয় না।
      revealedRole: !p.alive && p.role ? ROLES[p.role].name : null,
      revealedRoleId: !p.alive && p.role ? p.role : null,
    })),
    voteCounts: room.phase === "VOTING" ? tally(room.dayVotes, room) : null,
    nightActionsSubmitted: room.phase === "NIGHT" ? Object.keys(room.nightActions).length : null,
    // Wolvesville-স্টাইল "রোল গোরস্থান" সাইডবার উইজেটের জন্য — মোট
    // রোল বণ্টন (পাবলিক, কে কোনটা পেয়েছে তা বলে না) ও এখন পর্যন্ত
    // মারা যাওয়া খেলোয়াড়দের রোল অনুযায়ী গণনা।
    roleDeckCounts: room.roleDeckCounts || null,
    deadRoleCounts: room.phase !== "LOBBY" ? countDeadRoles(room) : null,
    revealRoles:
      room.phase === "ENDED"
        ? [...room.players.values()].map((p) => ({ name: p.name, role: ROLES[p.role]?.name, alive: p.alive }))
        : null,
  };
}

function broadcast(room) {
  for (const socketId of room.players.keys()) {
    io.to(socketId).emit("state", stateFor(room, socketId));
  }
}

// গ্রামপ্রধান নিজেকে প্রকাশ করার পর তার ভোট ২ ভোট হিসেবে গণনা হয়,
// তাই ভোট গণনার সময় রুম পাঠিয়ে ভোটারের ওজন (weight) হিসাব করা হয়
function tally(votesObj, room) {
  const counts = {};
  for (const [voter, target] of Object.entries(votesObj)) {
    if (!target) continue;
    const voterPlayer = room && room.players.get(voter);
    const weight = voterPlayer && voterPlayer.mayorRevealed ? 2 : 1;
    counts[target] = (counts[target] || 0) + weight;
  }
  return counts;
}

function majorityTarget(votesObj, room) {
  const counts = tally(votesObj, room);
  let best = null;
  let bestCount = 0;
  let tie = false;
  for (const [target, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = target;
      bestCount = count;
      tie = false;
    } else if (count === bestCount) {
      tie = true;
    }
  }
  if (!best || tie) return null;
  return best;
}

// ------------------------------------------------------------
// খেলা শুরু
// ------------------------------------------------------------
function startGame(room) {
  const players = [...room.players.values()];
  if (players.length < 4) return { error: "খেলা শুরু করতে অন্তত ৪ জন খেলোয়াড় দরকার।" };

  const deck = shuffle(buildRoleDeck(players.length));

  // Wolvesville-স্টাইল রোল গোরস্থান উইজেটে দেখানোর জন্য এই ম্যাচে
  // মোট কোন রোল কতবার আছে তা গণনা করে রাখা হচ্ছে (পাবলিক তথ্য)
  room.roleDeckCounts = {};
  deck.forEach((r) => {
    room.roleDeckCounts[r] = (room.roleDeckCounts[r] || 0) + 1;
  });

  players.forEach((p, i) => {
    p.role = deck[i];
    p.alive = true;
    p.usedHunterRevenge = false;
    p.witchHealUsed = false;
    p.witchPoisonUsed = false;
    p.doctorSelfHealUsed = false;
    p.mayorRevealed = false;
  });

  room.dayNumber = 0;
  room.log = [];
  room.winner = null;
  pushLog(room, `খেলা শুরু হলো! মোট ${players.length} জন খেলোয়াড়।`);

  // প্রতিটি খেলোয়াড়কে তার রোল ব্যক্তিগতভাবে জানানো
  for (const p of players) {
    io.to(p.id).emit("roleAssigned", {
      role: ROLES[p.role],
      fellowWolves:
        p.role === "WEREWOLF"
          ? players.filter((x) => x.role === "WEREWOLF" && x.id !== p.id).map((x) => x.name)
          : [],
    });
  }

  startNight(room);
  return { ok: true };
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function startNight(room) {
  clearTimer(room);
  room.phase = "NIGHT";
  room.dayNumber += 1;
  room.nightActions = {};
  for (const p of room.players.values()) p.protectedTonight = false;
  pushLog(room, `🌙 রাত ${room.dayNumber} নেমে এলো গ্রামে। সবাই ঘুমিয়ে পড়ো... বিশেষ ভূমিকার খেলোয়াড়রা জেগে ওঠো।`);
  room.phaseEndsAt = Date.now() + DURATIONS.night;
  broadcast(room);
  room.timer = setTimeout(() => resolveNight(room), DURATIONS.night);
}

function resolveNight(room) {
  clearTimer(room);
  if (room.phase !== "NIGHT") return;

  const actions = room.nightActions;
  const deaths = [];

  // নেকড়েদের ভোট গণনা (একাধিক নেকড়ে থাকলে সংখ্যাগরিষ্ঠ শিকার)
  const wolfVotes = {};
  for (const [voter, act] of Object.entries(actions)) {
    if (act.type === "WOLF_KILL") wolfVotes[voter] = act.targetId;
  }
  const wolfTarget = majorityTarget(wolfVotes, room) || Object.values(wolfVotes)[0] || null;

  // ডাক্তারের সুরক্ষা
  let protectedId = null;
  for (const act of Object.values(actions)) {
    if (act.type === "DOCTOR_PROTECT") protectedId = act.targetId;
  }
  if (protectedId) {
    const p = room.players.get(protectedId);
    if (p) p.protectedTonight = true;
  }

  // বডিগার্ডের সুরক্ষা (নিজেকে ছাড়া যে কাউকে রক্ষা করতে পারে;
  // নেকড়ের আক্রমণ তার সুরক্ষিত ব্যক্তির উপর হলে, বডিগার্ড নিজে
  // তার বদলে মারা যায়)
  let bodyguardId = null;
  let bodyguardTarget = null;
  for (const [voter, act] of Object.entries(actions)) {
    if (act.type === "BODYGUARD_PROTECT") {
      bodyguardId = voter;
      bodyguardTarget = act.targetId;
    }
  }

  // ডাইনির পোশন
  let witchHealTarget = null;
  let witchPoisonTarget = null;
  for (const act of Object.values(actions)) {
    if (act.type === "WITCH_HEAL") witchHealTarget = act.targetId;
    if (act.type === "WITCH_POISON") witchPoisonTarget = act.targetId;
  }

  // চূড়ান্ত সিদ্ধান্ত: নেকড়ের শিকার
  if (wolfTarget) {
    const victim = room.players.get(wolfTarget);
    if (victim && victim.alive) {
      const guardIntercept =
        !!bodyguardId && bodyguardTarget === wolfTarget && bodyguardId !== wolfTarget;
      const saved = victim.protectedTonight || witchHealTarget === wolfTarget || guardIntercept;
      if (guardIntercept) {
        const guard = room.players.get(bodyguardId);
        if (guard && guard.alive) {
          deaths.push({ id: bodyguardId, cause: "প্রভুকে বাঁচাতে আত্মবিসর্জন" });
          pushLog(room, `🛡️ ${guard.name} ${victim.name}-কে নেকড়ের আক্রমণ থেকে বাঁচাতে নিজের জীবন উৎসর্গ করেছে!`);
        }
      } else if (!saved) {
        deaths.push({ id: wolfTarget, cause: "নেকড়ের আক্রমণ" });
      } else {
        pushLog(room, `${victim.name}-কে রাতে আক্রমণ করা হয়েছিল, কিন্তু সে বেঁচে গেছে!`);
      }
    }
  }

  // ডাইনির বিষ
  if (witchPoisonTarget) {
    const victim = room.players.get(witchPoisonTarget);
    if (victim && victim.alive && !deaths.find((d) => d.id === witchPoisonTarget)) {
      deaths.push({ id: witchPoisonTarget, cause: "ডাইনির বিষ" });
    }
  }

  // মৃত্যু প্রয়োগ + শিকারীর প্রতিশোধ চেক
  const finalDeaths = [];
  for (const d of deaths) {
    const victim = room.players.get(d.id);
    if (!victim || !victim.alive) continue;
    victim.alive = false;
    finalDeaths.push({ name: victim.name, cause: d.cause, role: ROLES[victim.role].name, id: victim.id });
  }

  room.lastNightResult = finalDeaths;
  if (finalDeaths.length === 0) {
    pushLog(room, `☀️ সকাল হলো। আশ্চর্যজনকভাবে, গত রাতে কেউ মারা যায়নি।`);
  } else {
    for (const d of finalDeaths) {
      pushLog(room, `☠️ ${d.name} (${d.role}) মারা গেছে — কারণ: ${d.cause}।`);
    }
  }

  broadcast(room);

  // শিকারী প্রতিশোধের সুযোগ (যদি রাতে মারা যায়) — নাহলে সরাসরি দিনে চলে যাও
  const hunter = finalDeaths
    .map((d) => room.players.get(d.id))
    .find((p) => p && p.role === "HUNTER" && !p.usedHunterRevenge);

  if (triggerHunterRevengeIfNeeded(room, hunter, continueAfterNight)) return;
  continueAfterNight(room);
}

function continueAfterNight(room) {
  const winner = checkWinCondition(room);
  if (winner) return endGame(room, winner);
  startDay(room);
}

function continueAfterVoting(room) {
  const winner = checkWinCondition(room);
  if (winner) return endGame(room, winner);
  startNight(room);
}

function triggerHunterRevengeIfNeeded(room, deadPlayer, continueFn) {
  if (!deadPlayer) return false;
  room.phase = "HUNTER_REVENGE";
  room.pendingHunterId = deadPlayer.id;
  room.phaseEndsAt = Date.now() + DURATIONS.hunterRevenge;
  room._hunterContinue = continueFn;
  pushLog(room, `🏹 ${deadPlayer.name} মৃত্যুর আগে শেষবারের মতো বন্দুক তুলেছে — সে একজনকে সাথে নিয়ে যেতে পারবে!`);
  broadcast(room);
  clearTimer(room);
  room.timer = setTimeout(() => resolveHunterRevenge(room, null), DURATIONS.hunterRevenge);
  return true;
}

function resolveHunterRevenge(room, targetId) {
  clearTimer(room);
  const hunter = room.players.get(room.pendingHunterId);
  if (hunter) hunter.usedHunterRevenge = true;

  if (targetId) {
    const victim = room.players.get(targetId);
    if (victim && victim.alive) {
      victim.alive = false;
      pushLog(
        room,
        `🏹 ${hunter ? hunter.name : "শিকারী"} শেষ মুহূর্তে ${victim.name}-কে গুলি করে সাথে নিয়ে গেলো। তার পরিচয় ছিল: ${ROLES[victim.role].name}।`
      );
    }
  } else {
    pushLog(room, `শিকারী কাউকে গুলি না করেই বিদায় নিলো।`);
  }

  const continueFn = room._hunterContinue || continueAfterNight;
  room.pendingHunterId = null;
  room._hunterContinue = null;
  broadcast(room);
  continueFn(room);
}

function checkWinCondition(room) {
  const alive = alivePlayers(room);
  const wolves = alive.filter((p) => p.role === "WEREWOLF").length;
  const villagers = alive.length - wolves;
  if (wolves === 0) return "VILLAGE";
  if (wolves >= villagers) return "WEREWOLF";
  return null;
}

function startDay(room) {
  clearTimer(room);
  room.phase = "DAY";
  room.dayVotes = {};
  pushLog(room, `🗣️ দিনের আলোচনা শুরু হলো। কে সন্দেহজনক আচরণ করছে?`);
  room.phaseEndsAt = Date.now() + DURATIONS.dayDiscussion;
  broadcast(room);
  room.timer = setTimeout(() => startVoting(room), DURATIONS.dayDiscussion);
}

function startVoting(room) {
  clearTimer(room);
  room.phase = "VOTING";
  room.dayVotes = {};
  pushLog(room, `🗳️ ভোট দেওয়ার সময় হয়েছে! কাকে গ্রাম থেকে বহিষ্কার করবে?`);
  room.phaseEndsAt = Date.now() + DURATIONS.voting;
  broadcast(room);
  room.timer = setTimeout(() => resolveVoting(room), DURATIONS.voting);
}

function resolveVoting(room) {
  clearTimer(room);
  if (room.phase !== "VOTING") return;

  const target = majorityTarget(room.dayVotes, room);
  let eliminated = null;
  if (!target) {
    pushLog(room, `⚖️ ভোট সমান সমান হয়েছে অথবা যথেষ্ট ভোট পড়েনি — কেউ বহিষ্কার হয়নি।`);
  } else {
    const victim = room.players.get(target);
    if (victim && victim.alive) {
      victim.alive = false;
      eliminated = victim;
      pushLog(room, `🪓 গ্রামবাসীরা ভোট দিয়ে ${victim.name}-কে বহিষ্কার করেছে। তার পরিচয় ছিল: ${ROLES[victim.role].name}।`);
    }
  }

  broadcast(room);

  const hunter = eliminated && eliminated.role === "HUNTER" && !eliminated.usedHunterRevenge ? eliminated : null;
  if (triggerHunterRevengeIfNeeded(room, hunter, continueAfterVoting)) return;
  continueAfterVoting(room);
}

function endGame(room, winnerTeam) {
  clearTimer(room);
  room.phase = "ENDED";
  room.winner = winnerTeam;
  room.phaseEndsAt = null;
  const teamName = winnerTeam === "WEREWOLF" ? "নেকড়েরা 🐺" : "গ্রামবাসীরা 🏡";
  pushLog(room, `🏁 খেলা শেষ! বিজয়ী: ${teamName}`);
  broadcast(room);
}

// ------------------------------------------------------------
// অ্যাকশন হ্যান্ডলিং হেল্পার
// ------------------------------------------------------------
function maybeEarlyResolveNight(room) {
  const requiredVoters = [...room.players.values()].filter(
    (p) => p.alive && ["WEREWOLF", "SEER", "DOCTOR", "WITCH", "BODYGUARD"].includes(p.role)
  );
  const submitted = new Set(Object.keys(room.nightActions));
  const allDone = requiredVoters.every((p) => {
    if (p.role === "WITCH" && p.witchHealUsed && p.witchPoisonUsed) return true; // আর কিছু করার নেই
    return submitted.has(p.id);
  });
  if (allDone && requiredVoters.length > 0) {
    resolveNight(room);
  }
}

function maybeEarlyResolveVoting(room) {
  const voters = alivePlayers(room);
  const submitted = Object.keys(room.dayVotes).length;
  if (voters.length > 0 && submitted >= voters.length) {
    resolveVoting(room);
  }
}

function resetToLobby(room) {
  clearTimer(room);
  room.phase = "LOBBY";
  room.dayNumber = 0;
  room.nightActions = {};
  room.dayVotes = {};
  room.log = [];
  room.winner = null;
  room.lastNightResult = null;
  room.phaseEndsAt = null;
  room.roleDeckCounts = null;
  for (const p of room.players.values()) {
    p.role = null;
    p.alive = true;
    p.usedHunterRevenge = false;
    p.witchHealUsed = false;
    p.witchPoisonUsed = false;
    p.doctorSelfHealUsed = false;
    p.mayorRevealed = false;
    p.protectedTonight = false;
  }
  pushLog(room, "লবিতে ফিরে আসা হয়েছে। হোস্ট নতুন খেলা শুরু করতে পারে।");
}

// ------------------------------------------------------------
// SOCKET.IO ইভেন্ট
// ------------------------------------------------------------
io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, cb) => {
    const room = createRoom(socket.id, name);
    socket.join(room.code);
    cb && cb({ ok: true, code: room.code });
    broadcast(room);
  });

  socket.on("joinRoom", ({ name, code }, cb) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return cb && cb({ error: "এই কোডে কোনো রুম পাওয়া যায়নি।" });
    if (room.phase !== "LOBBY") return cb && cb({ error: "খেলা ইতিমধ্যে শুরু হয়ে গেছে।" });
    if (room.players.size >= 16) return cb && cb({ error: "রুম পূর্ণ (সর্বোচ্চ ১৬ জন)।" });

    addPlayer(room, socket.id, name, {});
    socket.join(room.code);
    pushLog(room, `${room.players.get(socket.id).name} রুমে যোগ দিয়েছে।`);
    cb && cb({ ok: true, code: room.code });
    broadcast(room);
  });

  // ডেভেলপার মোড: পাসকোড যাচাই করে একজন খেলোয়াড় + বাকিদের বট
  // দিয়ে একটি সোলো টেস্ট গেম তাৎক্ষণিকভাবে শুরু করা হয়
  socket.on("devStartSolo", ({ passcode, playerCount, name }, cb) => {
    if (passcode !== DEV_PASSCODE) {
      return cb && cb({ error: "ভুল পাসকোড। আবার চেষ্টা করো।" });
    }
    const count = [4, 8, 12, 16].includes(playerCount) ? playerCount : 8;

    const room = createRoom(socket.id, name || "ডেভেলপার", { isDev: true });
    socket.join(room.code);

    for (let i = 1; i < count; i++) {
      const botId = `${room.code}-bot-${i}`;
      addPlayer(room, botId, `বট ${i}`, { isBot: true });
    }

    pushLog(room, `🛠️ ডেভেলপার মোড চালু: ${count} জন খেলোয়াড় নিয়ে সোলো টেস্ট গেম শুরু হচ্ছে।`);
    const result = startGame(room);
    if (result.error) {
      clearTimer(room);
      rooms.delete(room.code);
      return cb && cb({ error: result.error });
    }
    cb && cb({ ok: true, code: room.code });
  });

  socket.on("startGame", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb && cb({ error: "রুম পাওয়া যায়নি।" });
    if (room.hostId !== socket.id) return cb && cb({ error: "শুধু হোস্ট খেলা শুরু করতে পারে।" });
    const result = startGame(room);
    cb && cb(result);
  });

  socket.on("nightAction", ({ code, type, targetId, asPlayerId }, cb) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "NIGHT") return cb && cb({ error: "এখন রাতের পালা নয়।" });
    const actingId = resolveActingId(room, socket.id, asPlayerId);
    const player = room.players.get(actingId);
    if (!player || !player.alive) return cb && cb({ error: "তুমি এই মুহূর্তে অ্যাকশন নিতে পারবে না।" });

    if (type === "WOLF_KILL" && player.role !== "WEREWOLF") return cb && cb({ error: "তুমি নেকড়ে নও।" });
    if (type === "SEER_CHECK" && player.role !== "SEER") return cb && cb({ error: "তুমি গণক নও।" });
    if (type === "DOCTOR_PROTECT" && player.role !== "DOCTOR") return cb && cb({ error: "তুমি ডাক্তার নও।" });
    if (type === "DOCTOR_PROTECT" && targetId === actingId && player.doctorSelfHealUsed)
      return cb && cb({ error: "তুমি ইতিমধ্যে একবার নিজেকে চিকিৎসা করেছ। আর পারবে না।" });
    if (type === "BODYGUARD_PROTECT" && player.role !== "BODYGUARD")
      return cb && cb({ error: "তুমি পাহাড়াদার নও।" });
    if (type === "BODYGUARD_PROTECT" && targetId === actingId)
      return cb && cb({ error: "তুমি নিজেকে রক্ষা করতে পারবে না।" });
    if (type === "WITCH_HEAL" && (player.role !== "WITCH" || player.witchHealUsed))
      return cb && cb({ error: "এই পোশন আর অবশিষ্ট নেই।" });
    if (type === "WITCH_POISON" && (player.role !== "WITCH" || player.witchPoisonUsed))
      return cb && cb({ error: "এই পোশন আর অবশিষ্ট নেই।" });

    room.nightActions[actingId] = { type, targetId };

    if (type === "SEER_CHECK") {
      const target = room.players.get(targetId);
      if (target) {
        // আসল অনুরোধকারী সকেটকে (ডেভেলপার হলে সেটাই) ফলাফল পাঠানো হয়,
        // কারণ বট প্লেয়ারদের কোনো আসল সংযোগ নেই যা এটি গ্রহণ করতে পারে।
        // ক্লায়েন্ট টার্গেটের কার্ড বক্সে ৩-৪ সেকেন্ডের জন্য রোল দেখাবে।
        io.to(socket.id).emit("seerReveal", {
          targetId: target.id,
          name: target.name,
          role: ROLES[target.role],
        });
      }
    }
    if (type === "DOCTOR_PROTECT" && targetId === actingId) player.doctorSelfHealUsed = true;
    if (type === "WITCH_HEAL") player.witchHealUsed = true;
    if (type === "WITCH_POISON") player.witchPoisonUsed = true;

    cb && cb({ ok: true });
    broadcast(room);
    maybeEarlyResolveNight(room);
  });

  socket.on("castVote", ({ code, targetId, asPlayerId }, cb) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "VOTING") return cb && cb({ error: "এখন ভোটের সময় নয়।" });
    const actingId = resolveActingId(room, socket.id, asPlayerId);
    const player = room.players.get(actingId);
    if (!player || !player.alive) return cb && cb({ error: "মৃত খেলোয়াড়রা ভোট দিতে পারবে না।" });

    room.dayVotes[actingId] = targetId; // targetId === null মানে "স্কিপ"
    cb && cb({ ok: true });
    broadcast(room);
    maybeEarlyResolveVoting(room);
  });

  // গ্রামপ্রধান আলোচনার সময় নিজের পরিচয় প্রকাশ করে — এরপর থেকে
  // তার ভোট সবসময় ২ ভোট হিসেবে গণনা হবে
  socket.on("mayorReveal", ({ code, asPlayerId }, cb) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "DAY") return cb && cb({ error: "এখন পরিচয় প্রকাশ করার সময় নয়।" });
    const actingId = resolveActingId(room, socket.id, asPlayerId);
    const player = room.players.get(actingId);
    if (!player || !player.alive) return cb && cb({ error: "তুমি এই মুহূর্তে এটি করতে পারবে না।" });
    if (player.role !== "MAYOR") return cb && cb({ error: "তুমি গ্রামপ্রধান নও।" });
    if (player.mayorRevealed) return cb && cb({ error: "তুমি ইতিমধ্যে নিজেকে প্রকাশ করেছ।" });

    player.mayorRevealed = true;
    pushLog(room, `📜 ${player.name} নিজেকে গ্রামপ্রধান হিসেবে প্রকাশ করেছে! এখন থেকে তার ভোট ২ ভোট হিসেবে গণনা হবে।`);
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on("sendChat", ({ code, message }) => {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player || !message) return;
    const clean = String(message).slice(0, 300);
    io.to(room.code).emit("chat", {
      name: player.name,
      alive: player.alive,
      message: clean,
      t: Date.now(),
    });
  });

  socket.on("hunterRevenge", ({ code, targetId, asPlayerId }, cb) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "HUNTER_REVENGE") return cb && cb({ error: "এখন প্রতিশোধের সময় নয়।" });
    const actingId = resolveActingId(room, socket.id, asPlayerId);
    if (room.pendingHunterId !== actingId) return cb && cb({ error: "এটি তোমার পালা নয়।" });
    resolveHunterRevenge(room, targetId || null);
    cb && cb({ ok: true });
  });

  socket.on("returnToLobby", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb && cb({ error: "রুম পাওয়া যায়নি।" });
    if (room.hostId !== socket.id) return cb && cb({ error: "শুধু হোস্ট এটি করতে পারে।" });
    resetToLobby(room);
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on("leaveRoom", ({ code }) => {
    handleLeave(socket, code);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (room.players.has(socket.id)) handleLeave(socket, room.code);
    }
  });

  function handleLeave(socket, code) {
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    // ডেভেলপার সোলো-টেস্ট রুমে বট প্লেয়ারদের কোনো আসল সংযোগ নেই যার
    // কাছে হোস্ট হস্তান্তর করা যায় — তাই ডেভেলপার বেরিয়ে গেলে/সংযোগ
    // বিচ্ছিন্ন হলে পুরো টেস্ট রুমটিই বন্ধ করে দেওয়া হয়
    if (room.isDev && room.devOwnerId === socket.id) {
      clearTimer(room);
      rooms.delete(room.code);
      return;
    }

    if (room.phase === "LOBBY") {
      room.players.delete(socket.id);
      pushLog(room, `${player.name} রুম ছেড়ে চলে গেছে।`);
    } else {
      player.connected = false;
      pushLog(room, `${player.name} সংযোগ বিচ্ছিন্ন হয়ে গেছে।`);
    }

    if (room.players.size === 0) {
      clearTimer(room);
      rooms.delete(room.code);
      return;
    }

    if (room.hostId === socket.id) {
      player.isHost = false;
      const next = [...room.players.values()].find((p) => p.connected !== false);
      if (next) {
        room.hostId = next.id;
        next.isHost = true;
        pushLog(room, `${next.name} এখন নতুন হোস্ট।`);
      }
    }

    broadcast(room);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`নেকড়ে-গ্রাম সার্ভার চলছে! (${APP_VERSION})`);
  console.log(`লোকাল: http://localhost:${PORT}`);
  console.log(`LAN-এর অন্য ডিভাইস থেকে যুক্ত হতে, এই কম্পিউটারের IP ঠিকানা ব্যবহার করো, যেমন: http://192.168.x.x:${PORT}`);
});
