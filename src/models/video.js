const mongoose = require("mongoose");

const videoSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true,
    default: ""
  },
  videoUrl: {
    type: String
  },
  thumbnailUrl: {
    type: String
  },
  subtitles: {
    type: String
  },
  duration: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ["processing", "processed", "failed"],
    default: "processing"
  },
  // Chunk-related fields
  partNumber: {
    type: Number,
    default: 1
  },
  totalParts: {
    type: Number,
    default: 1
  },
  isChunked: {
    type: Boolean,
    default: false
  },
  chunkId: {
    type: String,
    default: null
  },
  allChunksProcessed: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  baseTitle: {
    type: String,
    default: ''
  }
});

const Video = mongoose.model("Video", videoSchema);
module.exports = Video;
