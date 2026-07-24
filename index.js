const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

// ── Calendar Feed ─────────────────────────────────────────────────────────────
exports.calendarFeed = onRequest({
  region: "europe-west2",
  cors: true,
}, async (req, res) => {
  const uid   = req.query.uid;
  const token = req.query.token;

  if (!uid || !token) {
    return res.status(400).send("Missing uid or token");
  }

  const db = getFirestore();

  // Verify token matches what's stored for this user
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists || userDoc.data().calToken !== token) {
    return res.status(403).send("Invalid token");
  }

  // Get tasks and hives
  const [tasksSnap, hivesSnap] = await Promise.all([
    db.collection("users").doc(uid).collection("tasks").get(),
    db.collection("users").doc(uid).collection("hives").get(),
  ]);

  const hives = {};
  hivesSnap.docs.forEach(d => { hives[d.id] = d.data(); });

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Beekind Buzz//Hive Management//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Beekind Buzz Tasks",
    "X-WR-CALDESC:Your hive management tasks",
    "X-WR-TIMEZONE:Europe/London",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];

  tasksSnap.docs.forEach(doc => {
    const t = doc.data();
    if (!t.dueDate) return;
    const dt = t.dueDate.replace(/-/g, "");
    const uid_str = doc.id + "@beekindbuzz.beekind-buzz";
    let summary = t.title || "Beekind task";
    if (t.completed) summary = "\u2713 " + summary;

    let desc = t.description || "";
    if (t.hiveScope === "all") {
      desc += " (All hives)";
    } else if (t.hiveIds && t.hiveIds.length) {
      const hiveNames = t.hiveIds
        .map(hid => hives[hid] ? "Hive #" + (hives[hid].number || hid) : hid)
        .join(", ");
      desc += " (" + hiveNames + ")";
    }

    lines.push("BEGIN:VEVENT");
    lines.push("UID:" + uid_str);
    lines.push("DTSTART;VALUE=DATE:" + dt);
    lines.push("DTEND;VALUE=DATE:" + dt);
    lines.push("SUMMARY:" + summary.replace(/,/g, "\\,").replace(/;/g, "\\;"));
    if (desc) lines.push("DESCRIPTION:" + desc.replace(/\n/g, "\\n").replace(/,/g, "\\,"));
    lines.push("STATUS:" + (t.completed ? "COMPLETED" : "NEEDS-ACTION"));
    if (t.completed) lines.push("PERCENT-COMPLETE:100");
    lines.push("END:VEVENT");
  });

  lines.push("END:VCALENDAR");

  res.setHeader("Content-Type", "text/calendar;charset=utf-8");
  res.setHeader("Content-Disposition", "inline; filename=beekind-buzz.ics");
  res.setHeader("Cache-Control", "public, max-age=21600"); // 6 hour cache
  res.send(lines.join("\r\n"));
});

// ── Daily Task Notifications ──────────────────────────────────────────────────
exports.sendTaskNotifications = onSchedule({
  schedule: "0 * * * *",
  timeZone: "Europe/London",
  region: "europe-west2",
}, async () => {
  const db = getFirestore();
  const messaging = getMessaging();
  const now = new Date();
  // Use UK time (accounts for BST/GMT)
  const ukStr = now.toLocaleString("en-GB", {timeZone:"Europe/London",hour:"numeric",hour12:false,year:"numeric",month:"2-digit",day:"2-digit"});
  const currentHour = parseInt(now.toLocaleString("en-GB", {timeZone:"Europe/London",hour:"numeric",hour12:false}));
  // Get today in UK local time (not UTC - avoids BST midnight edge case)
  const ukDate = new Date(now.toLocaleString("en-US", {timeZone:"Europe/London"}));
  const today = ukDate.getFullYear()+"-"+String(ukDate.getMonth()+1).padStart(2,"0")+"-"+String(ukDate.getDate()).padStart(2,"0");

  const usersSnap = await db.collection("users").get();

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    try {
      const userData = userDoc.data();
      const preferredHour = userData.notifHour !== undefined ? parseInt(userData.notifHour) : 8;
      console.log(`User ${uid}: currentHour=${currentHour}, preferredHour=${preferredHour}, today=${today}`);
      if (currentHour !== preferredHour) continue;

      const tasksSnap = await db.collection("users").doc(uid)
        .collection("tasks").where("completed", "==", false).get();

      const overdue    = tasksSnap.docs.filter(d => d.data().dueDate < today);
      const dueToday   = tasksSnap.docs.filter(d => d.data().dueDate === today);

      // Check advance reminders
      const notifAdvance = userData.notifAdvance || [];
      const upcoming = [];
      for (const days of notifAdvance) {
        const targetDate = new Date(now);
        targetDate.setDate(targetDate.getDate() + days);
        const targetStr = targetDate.toISOString().slice(0, 10);
        const dueSoon = tasksSnap.docs.filter(d => d.data().dueDate === targetStr);
        if (dueSoon.length > 0) upcoming.push({days, tasks: dueSoon});
      }

      if (overdue.length === 0 && dueToday.length === 0 && upcoming.length === 0) continue;

      const tokensSnap = await db.collection("users").doc(uid)
        .collection("fcmTokens").get();
      if (tokensSnap.empty) continue;
      // Deduplicate tokens
      const seenT = new Set();
      const dupRefs = [];
      const tokens = [];
      for (const doc of tokensSnap.docs) {
        const t = doc.data().token;
        if (!t || seenT.has(t)) { dupRefs.push(doc.ref); continue; }
        seenT.add(t);
        tokens.push(t);
      }
      // Clean up duplicate token docs now
      for (const ref of dupRefs) await ref.delete();
      if (!tokens.length) continue;

      // Build ONE combined notification covering all urgent tasks
      const parts = [];
      if (overdue.length > 0) {
        parts.push(overdue.length + " overdue: " +
          overdue.slice(0, 2).map(d => d.data().title).join(", ") +
          (overdue.length > 2 ? "..." : ""));
      }
      if (dueToday.length > 0) {
        parts.push(dueToday.length + " due today: " +
          dueToday.slice(0, 2).map(d => d.data().title).join(", ") +
          (dueToday.length > 2 ? "..." : ""));
      }
      for (const u of upcoming) {
        const daysLabel = u.days === 1 ? "tomorrow" : "in " + u.days + " days";
        parts.push(u.tasks.length + " due " + daysLabel + ": " +
          u.tasks.slice(0, 1).map(d => d.data().title).join(", ") +
          (u.tasks.length > 1 ? "..." : ""));
      }
      if (parts.length === 0) continue;
      const title = "Beekind Buzz \u2013 Task reminder";
      const body  = parts.join(" | ");


      const results = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        webpush: {
          notification: {
            title, body,
            icon:  "https://beekindbuzz.github.io/beekind-buzz/icon-192.png",
            badge: "https://beekindbuzz.github.io/beekind-buzz/icon-192.png",
            tag:   "bk-task-reminder", // same tag = replaces previous notification
          },
          fcmOptions: {
            link: "https://beekindbuzz.github.io/beekind-buzz/Beekind_Buzz_Management_App.html"
          }
        }
      });

      const batch = db.batch();
      results.responses.forEach((resp, i) => {
        if (!resp.success) {
          const code = resp.error && resp.error.code;
          if (code === "messaging/invalid-registration-token" ||
              code === "messaging/registration-token-not-registered") {
            tokensSnap.docs
              .filter(d => d.data().token === tokens[i])
              .forEach(d => batch.delete(d.ref));
          }
        }
      });
      await batch.commit();

    } catch (e) {
      console.error("Error for user", uid, e.message);
    }
  }
});


// ── Daily weather fetch for all apiaries ─────────────────────────────────────
exports.fetchDailyWeather = onSchedule({
  schedule: "0 7 * * *",
  timeZone: "Europe/London",
  region: "europe-west2",
}, async () => {
  const db = getFirestore();
  const usersSnap = await db.collection("users").get();
  const today = new Date().toISOString().slice(0,10);

  const WMO = {0:"Clear",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",
    45:"Foggy",48:"Icy fog",51:"Light drizzle",53:"Drizzle",55:"Heavy drizzle",
    61:"Light rain",63:"Rain",65:"Heavy rain",71:"Light snow",73:"Snow",75:"Heavy snow",
    80:"Light showers",81:"Showers",82:"Heavy showers",
    95:"Thunderstorm",96:"Thunderstorm + hail",99:"Thunderstorm + heavy hail"};
  function wmoCond(code){ return WMO[code] || ("Code "+code); }
  function degToCompass(d){
    var dirs=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    return dirs[Math.round(d/22.5)%16];
  }

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    try {
      const apiariesSnap = await db.collection("users").doc(uid).collection("apiaries").get();
      for (const aDoc of apiariesSnap.docs) {
        const a = aDoc.data();
        if (!a.lat || !a.lng) continue;
        try {
          const url = "https://api.open-meteo.com/v1/forecast?latitude="+a.lat+"&longitude="+a.lng
            +"&hourly=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation"
            +"&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_max,relative_humidity_2m_min"
            +"&wind_speed_unit=mph&timezone=Europe%2FLondon&forecast_days=1";
          const { default: fetch } = await import("node-fetch").catch(()=>({default:global.fetch}));
          const resp = await (fetch || global.fetch)(url);
          if (!resp.ok) continue;
          const data = await resp.json();
          const h = data.hourly || {};
          const d2 = data.daily || {};
          const hi = 7; // 7am index
          const ws = Math.round((h.wind_speed_10m||[])[hi]||0);
          const wg = Math.round((h.wind_gusts_10m||[])[hi]||0);
          const wd = degToCompass((h.wind_direction_10m||[])[hi]||0);
          const wStr = ws+"mph "+wd+(wg>ws+3?" (gusts "+wg+"mph)":"");
          const w = {
            condition:   wmoCond((h.weather_code||[])[hi]||0),
            tempC:       Math.round(((h.temperature_2m||[])[hi]||0)*10)/10,
            humidity:    Math.round((h.relative_humidity_2m||[])[hi]||0),
            windStr:     wStr, windMph: ws, windGustMph: wg, windDir: wd,
            rainMm:      Math.round(((h.precipitation||[])[hi]||0)*10)/10,
            tempMaxC:    Math.round(((d2.temperature_2m_max||[])[0]||0)*10)/10,
            tempMinC:    Math.round(((d2.temperature_2m_min||[])[0]||0)*10)/10,
            humidMax:    Math.round((d2.relative_humidity_2m_max||[])[0]||0),
            humidMin:    Math.round((d2.relative_humidity_2m_min||[])[0]||0),
            rainDayMm:   Math.round(((d2.precipitation_sum||[])[0]||0)*10)/10,
            fetchedAt:   new Date().toISOString(),
            hourIndex:   hi, apiaryId: aDoc.id
          };
          await db.collection("users").doc(uid).collection("weather").doc(aDoc.id).set(w);
        } catch(e) { console.error("Weather fetch for apiary",aDoc.id,e.message); }
      }
    } catch(e) { console.error("Weather fetch for user",uid,e.message); }
  }
});


// ── Clean up old pending updates ──────────────────────────────────────────────
// Runs daily at 3am UK time
// Deletes applied/rejected updates older than 7 days
// Deletes pending updates older than 30 days (very old unreviewed items)
exports.cleanPendingUpdates = onSchedule({
  schedule: "0 3 * * *",
  timeZone: "Europe/London",
  region: "europe-west2",
}, async () => {
  const db = getFirestore();
  const now = Date.now();
  const sevenDaysAgo  = new Date(now - 7  * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  const usersSnap = await db.collection("users").get();
  let totalDeleted = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const ref = db.collection("users").doc(uid).collection("pendingUpdates");

    // Delete applied/rejected older than 7 days
    const oldProcessed = await ref
      .where("status", "in", ["applied", "rejected"])
      .where("createdAt", "<", sevenDaysAgo)
      .get();

    // Delete pending older than 30 days
    const oldPending = await ref
      .where("status", "==", "pending")
      .where("createdAt", "<", thirtyDaysAgo)
      .get();

    const toDelete = [...oldProcessed.docs, ...oldPending.docs];
    for (const doc of toDelete) {
      await doc.ref.delete();
      totalDeleted++;
    }
  }

  console.log(`cleanPendingUpdates: deleted ${totalDeleted} old pending update docs`);
});
