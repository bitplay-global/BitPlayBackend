import crypto from "crypto";
import express from "express";
export const router = express.Router();

// simple HMAC check (set the same secret in your webhook)
function verify(req) {
  const sig = req.header("X-Alchemy-Signature");
  const hmac = crypto.createHmac("sha256", process.env.WEBHOOK_SECRET)
                     .update(JSON.stringify(req.body)).digest("hex");
  return sig && sig === hmac;
}

router.post("/webhooks/alchemy", async (req, res) => {
  if (!verify(req)) return res.status(401).send("bad sig");
  const events = Array.isArray(req.body) ? req.body : [req.body];

  for (const ev of events) {
    console.log(ev);
  }
  res.send("ok");
});
