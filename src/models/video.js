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
    type: String,
    required: true
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
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const Video = mongoose.model("Video", videoSchema);
module.exports = Video;
