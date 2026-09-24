// // api_routes/lightning-handle.js
import express from "express";
// import bodyParser from "body-parser";
// import fs from "fs";
// import Client from "lightning-client";

const router = express.Router();

// const rpcPath = "/home/pi/.lightning/bitcoin";

//  if (!fs.existsSync(rpcPath)) {
//    throw new Error("lightning-rpc not found. Check CLN is running and path is correct.");
//  }

// const client = new Client(rpcPath);

// router.get("/pay-invoice", async (req, res) => {
//   try {
//     const { invoice } = req.body;
//     if (!invoice) {
//       return res.status(400).json({ error: "Missing invoice" });
//     }

//     // Decode invoice
//     const decoded = await client.decodepay(invoice);

//     // ensure connected to peer
//     if (decoded.payee) {
//       try {
//         await client.connect(decoded.payee);
//       } catch (err) {
//         console.log("Peer connect skipped or already connected.");
//       }
//     }

//     // Pay invoice
//     const payment = await client.pay(invoice);

//     res.json({
//       status: "paid",
//       preimage: payment.payment_preimage,
//       hash: payment.payment_hash,
//       amount_msat: payment.amount_msat,
//       fees_msat: payment.fee_msat,
//     });
//   } catch (err) {
//     console.error("Payment failed:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

export default router;