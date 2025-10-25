require("dotenv").config();
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const pino = require("pino");
let emails = 0;
// --- Logger setup: write both to stdout and to a file (logs/mailer.log) ---
const LOG_LEVEL = process.env.LOG_LEVEL || "debug";
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "logs");
const LOG_FILE = process.env.LOG_FILE || "mailer.log";

try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch (e) {
  // If we can't create the dir, continue — pino will still log to stdout.
  // We'll log an error below after logger is created.
}

let logger;
try {
  const logFilePath = path.join(LOG_DIR, LOG_FILE);
  const fileStream = fs.createWriteStream(logFilePath, { flags: "a" });
  const streams = [
    { level: LOG_LEVEL, stream: process.stdout },
    { level: LOG_LEVEL, stream: fileStream },
  ];
  logger = pino({ level: LOG_LEVEL }, pino.multistream(streams));
} catch (e) {
  // fallback to console-only logger
  logger = pino({ level: LOG_LEVEL });
  logger.error(
    { err: e && e.message },
    "Failed to create file logger, falling back to console only"
  );
}

// Ensure uncaught exceptions and rejections are logged
process.on("uncaughtException", (err) => {
  try {
    logger.fatal(
      { err: err && err.stack ? err.stack : String(err) },
      "uncaughtException"
    );
  } finally {
    // Give logger a moment to flush then exit
    setTimeout(() => process.exit(1), 200);
  }
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection");
});

const {
  POLL_INTERVAL_MS = 5000,
  FETCH_LIMIT = 10,
  MAX_ATTEMPTS = 5,
  BACKOFF_BASE_SECONDS = 30,
} = process.env;

// Initialize Firebase Admin
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  logger.error("GOOGLE_APPLICATION_CREDENTIALS env var required");
  process.exit(1);
}
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

// Create nodemailer transport
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// helper: compute next attempt timestamp
function nextAttemptDate(attempts) {
  const base = Number(BACKOFF_BASE_SECONDS || 30);
  const delay = Math.min(60 * 60 * 2, Math.pow(2, attempts) * base); // cap 24h
  return new Date(Date.now() + delay * 1000);
}

async function claimEmail(docRef) {
  // Claim via transaction: only claim if status == 'pending' or nextAttemptAt <= now
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return null;
    const data = snap.data();
    const now = new Date();
    const nextAttemptAt = data.nextAttemptAt
      ? data.nextAttemptAt.toDate
        ? data.nextAttemptAt.toDate()
        : new Date(data.nextAttemptAt)
      : null;
    const canClaim =
      data.status === "pending" || (nextAttemptAt && nextAttemptAt <= now);
    if (!canClaim) return null;
    tx.update(docRef, {
      status: "processing",
      attempts: (data.attempts || 0) + 1,
      updatedAt: admin.firestore.Timestamp.fromDate(now),
    });
    return {
      id: docRef.id,
      data: { ...data, attempts: (data.attempts || 0) + 1 },
    };
  });
}

async function processEmailDoc(docRef) {
  const claimed = await claimEmail(docRef);
  if (!claimed) return;
  const docId = claimed.id;
  const data = claimed.data;
  logger.info({ docId }, "Processing email");

  try {
    // Build mail options
    const mailOptions = {
      from: `"Saturnalia 2025" <no-reply@saturnalia.in>`,
      to: data.email,
      subject: data.subject || "(No subject)",
      html: data.html || "",
      bcc: "aksrv09@gmail.com",
      // you can add text: fallback plain text
    };

    // send
    await transporter.sendMail(mailOptions);

    // update doc to sent
    await docRef.update({
      status: "sent",
      sentAt: admin.firestore.Timestamp.fromDate(new Date()),
      updatedAt: admin.firestore.Timestamp.fromDate(new Date()),
      error: null,
    });
    emails += 1;
    logger.info({ docId }, "Email sent");
  } catch (err) {
    logger.error({ err: err.message, docId }, "Failed to send email");
    const attempts = data.attempts || 1;
    const now = new Date();

    if (attempts >= Number(MAX_ATTEMPTS)) {
      await docRef.update({
        status: "failed",
        error: (err && err.message) || String(err),
        updatedAt: admin.firestore.Timestamp.fromDate(now),
      });
      logger.warn({ docId }, "Email marked failed after max attempts");
    } else {
      await docRef.update({
        status: "pending",
        error: (err && err.message) || String(err),
        nextAttemptAt: admin.firestore.Timestamp.fromDate(
          nextAttemptDate(attempts)
        ),
        updatedAt: admin.firestore.Timestamp.fromDate(now),
      });
      logger.info(
        { docId, nextAttemptAt: nextAttemptDate(attempts) },
        "Scheduled next retry"
      );
    }
  }
}
let c = 0;
async function fetchAndProcess() {
  try {
    // Simpler query: fetch a batch of pending docs and filter nextAttemptAt in code.
    // This avoids composite index requirements from Firestore.
    const nowDate = new Date();
    c += 1;
    // Prepare app-level document (id'd by recipient email) to track status and metrics
    if (c == 1500) {
      const appDocRef = db.collection("app").doc("emailer");
      try {
        await appDocRef.set(
          {
            emailsSent: emails,
            status: "running",
            scriptLastRuntime: admin.firestore.Timestamp.fromDate(new Date()),
          },
          { merge: true }
        );
      } catch (e) {
        logger.error(
          { err: e && e.message, docId, email: data.email },
          "Failed to upsert app doc (processing)"
        );
      }
      c = 0;
    }

    const snapshots = await db
      .collection("emails")
      .where("status", "==", "pending")
      .orderBy("createdAt")
      .limit(Number(FETCH_LIMIT))
      .get();

    if (snapshots.empty) {
      return;
    }

    const promises = [];
    snapshots.forEach((doc) => {
      const data = doc.data();
      const nextAttemptAt = data.nextAttemptAt
        ? data.nextAttemptAt.toDate
          ? data.nextAttemptAt.toDate()
          : new Date(data.nextAttemptAt)
        : null;
      // Only process if no nextAttemptAt set or it's due now
      if (!nextAttemptAt || nextAttemptAt <= nowDate) {
        const ref = db.collection("emails").doc(doc.id);
        promises.push(processEmailDoc(ref));
      }
    });

    if (promises.length === 0) {
      return;
    }

    await Promise.all(promises);
  } catch (err) {
    logger.error({ err: err.message }, "Error in fetchAndProcess");
  }
}

async function mainLoop() {
  logger.info("Mailer service started");
  while (true) {
    try {
      await fetchAndProcess();
    } catch (err) {
      logger.error({ err: err.message }, "Unhandled error in loop");
    }
    await new Promise((r) => setTimeout(r, Number(POLL_INTERVAL_MS)));
  }
}

mainLoop().catch((err) => {
  logger.error({ err: err.message }, "Fatal error");
  db.collection("app").doc("emailer").update({
    status: "failed",
    error: (err && err.message) || String(err),
  });
  process.exit(1);
});
