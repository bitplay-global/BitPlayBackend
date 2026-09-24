import mongoose from "mongoose";

const DeleteRequestSchema = new mongoose.Schema({
  user: {
    type: String,
    ref: 'users',
    required: true
  },
  firebase_uid: {
    type: String,
    ref: 'users',
    index: true
  },
  reason: {
    type: String,
    required: true
  },
}, { timestamps: true });

export default mongoose.model("DeleteRequest", DeleteRequestSchema);