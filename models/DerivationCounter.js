
import mongoose from "mongoose";

const derivationCounterSchema = new mongoose.Schema({
  chain: { type: String, required: true, unique: true },
  nextIndex: { type: Number, default: 0 },
}, { timestamps: true });

export default mongoose.model("DerivationCounter", derivationCounterSchema);
