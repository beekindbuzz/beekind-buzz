const functions = require("firebase-functions");
const admin     = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

// Runs daily at 8am UK time
exports.sendTaskNotifications = functions.pubsub
  .schedule("0 8 * * *")
  .timeZone("Europe/London")
  .onRun(async () => {
    const today = new Date().toISOString().slice(0,10);
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);

    const usersSnap = await db.collection("users").get();

    for (const userDoc of usersSnap.docs) {
      const uid = userDoc.id;
      try {
        // Get user's pending tasks
        const tasksSnap = await db.collection("users").doc(uid)
          .collection("tasks")
          .where("completed","==",false)
          .get();

        const overdue  = tasksSnap.docs.filter(d => d.data().dueDate <  today);
        const dueToday = tasksSnap.docs.filter(d => d.data().dueDate === today);

        if (overdue.length === 0 && dueToday.length === 0) continue;

        // Get user's FCM tokens
        const tokensSnap = await db.collection("users").doc(uid)
          .collection("fcmTokens").get();
        if (tokensSnap.empty) continue;
        const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
        if (!tokens.length) continue;

        // Build notification
        let title, body;
        if (overdue.length > 0) {
          title = "Beekind Buzz \u2013 Overdue tasks";
          body  = overdue.length + " overdue: " +
            overdue.slice(0,2).map(d=>d.data().title).join(", ") +
            (overdue.length > 2 ? " and more" : "");
        } else {
          title = "Beekind Buzz \u2013 Due today";
          body  = dueToday.length + " task" + (dueToday.length>1?"s":"") + " due today: " +
            dueToday.slice(0,2).map(d=>d.data().title).join(", ") +
            (dueToday.length > 2 ? " and more" : "");
        }

        // Send to all tokens, clean up invalid ones
        const results = await admin.messaging().sendEachForMulticast({
          tokens,
          notification: { title, body },
          webpush: {
            notification: {
              title, body,
              icon:  "https://beekindbuzz.github.io/beekind-buzz/icon-192.png",
              badge: "https://beekindbuzz.github.io/beekind-buzz/icon-192.png",
              tag:   "bk-daily",
              requireInteraction: false,
            },
            fcmOptions: {
              link: "https://beekindbuzz.github.io/beekind-buzz/Beekind_Buzz_Management_App.html"
            }
          }
        });

        // Remove invalid tokens
        const batch = db.batch();
        results.responses.forEach((resp, i) => {
          if (!resp.success &&
              (resp.error.code === "messaging/invalid-registration-token" ||
               resp.error.code === "messaging/registration-token-not-registered")) {
            const badToken = tokens[i];
            tokensSnap.docs.filter(d=>d.data().token===badToken)
              .forEach(d => batch.delete(d.ref));
          }
        });
        await batch.commit();

      } catch(e) {
        console.error("Error processing user", uid, e.message);
      }
    }
    return null;
  });
