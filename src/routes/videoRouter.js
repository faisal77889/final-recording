const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const Video = require("../models/video");
const { promisify } = require("util");
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);
const { uploadToS3, downloadFromS3, deleteFromS3, getSignedUrl } = require('../utils/s3');

const { extractAudioFromVideo } = require('../utils/extractAudio');
const { transcribeWithWhisper } = require("../utils/transcribeWithWhisper");
const { burnSubtitlesIntoVideo } = require("../utils/burnSubtitles");

const videoRouter = express.Router();

// Configuration
const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm'
];

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Enhanced JWT Authentication Middleware
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Authorization header missing" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "Token not provided" });
    }

    const decoded = await jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    console.error("Authentication error:", err);
    res.status(403).json({ 
      error: "Authentication failed",
      details: err.message 
    });
  }
};

// Temporary storage for processing
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, "..", "temp");
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (file.fieldname === "video" && !ALLOWED_VIDEO_TYPES.includes(file.mimetype)) {
    return cb(new Error("Invalid video file type"), false);
  }
  if (file.fieldname === "thumbnail" && !ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    return cb(new Error("Invalid thumbnail image type"), false);
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 2
  }
}).fields([
  { name: "video", maxCount: 1 },
  { name: "thumbnail", maxCount: 1 }
]);

// Helper function to clean up temporary files
async function cleanupFiles(files = []) {
  try {
    await Promise.all(files.map(file => unlink(file).catch(() => {})));
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}

// Upload video with processing pipeline
videoRouter.post(
  "/upload",
  authenticateUser,
  (req, res, next) => {
    upload(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.message });
      } else if (err) {
        return res.status(500).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    const tempFiles = [];
    try {
      if (!req.files?.video) {
        return res.status(400).json({ error: "Video file is required" });
      }

      const videoFile = req.files.video[0];
      const videoPath = videoFile.path;
      tempFiles.push(videoPath);

      // Create temporary directories for processing
      const tempDir = path.join(__dirname, "..", "temp");
      fs.mkdirSync(tempDir, { recursive: true });

      console.log("\n=== Starting Video Processing Pipeline ===");

      // 1. Extract audio
      console.log("\n1. Extracting audio...");
      const audioPath = await extractAudioFromVideo(videoPath, tempDir);
      console.log("Audio extracted to:", audioPath);
      tempFiles.push(audioPath);

      // 2. Transcribe audio
      console.log("\n2. Transcribing audio...");
      let srtPath;
      try {
        srtPath = await transcribeWithWhisper(audioPath, tempDir);
        console.log("Transcription completed. SRT file at:", srtPath);
        tempFiles.push(srtPath);
      } catch (transcriptionError) {
        console.error("Transcription error:", transcriptionError);
        throw new Error(`Transcription failed: ${transcriptionError.message}`);
      }

      // 3. Burn subtitles
      console.log("\n3. Burning subtitles...");
      const finalVideoPath = await burnSubtitlesIntoVideo(videoPath, srtPath, tempDir);
      console.log("Final video created at:", finalVideoPath);
      tempFiles.push(finalVideoPath);

      // 4. Upload files to S3
      console.log("\n4. Uploading files to S3...");
      const videoS3Url = await uploadToS3({ 
        path: finalVideoPath, 
        originalname: videoFile.originalname,
        mimetype: videoFile.mimetype 
      }, 'videos');

      let thumbnailS3Url = null;
      if (req.files?.thumbnail) {
        thumbnailS3Url = await uploadToS3(req.files.thumbnail[0], 'thumbnails');
      }

      // 5. Save video metadata to database
      const subtitleText = await readFile(srtPath, "utf8");
      const video = new Video({
        userId: req.userId,
        title: req.body.title || "Untitled Video",
        description: req.body.description || "",
        videoUrl: videoS3Url,
        thumbnailUrl: thumbnailS3Url,
        subtitles: subtitleText,
        duration: req.body.duration,
        status: "processed"
      });

      await video.save();

      // Clean up temporary files
      await cleanupFiles(tempFiles);

      res.status(201).json({
        message: "Video processed and uploaded successfully",
        video: {
          id: video._id,
          title: video.title,
          videoUrl: video.videoUrl,
          thumbnailUrl: video.thumbnailUrl
        }
      });

    } catch (error) {
      console.error("Processing error:", error);
      await cleanupFiles(tempFiles);
      res.status(500).json({ 
        error: "Video processing failed", 
        details: error.message 
      });
    }
  }
);

// Get video stream
videoRouter.get("/:videoId/stream", authenticateUser, async (req, res) => {
  try {
    const video = await Video.findById(req.params.videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Generate a signed URL for temporary access
    const signedUrl = await getSignedUrl(video.videoUrl);
    res.json({ streamUrl: signedUrl });

  } catch (error) {
    console.error("Streaming error:", error);
    res.status(500).json({ error: "Failed to get video stream" });
  }
});

// Delete video
videoRouter.delete("/:videoId", authenticateUser, async (req, res) => {
  try {
    const video = await Video.findById(req.params.videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Delete files from S3
    await deleteFromS3(video.videoUrl);
    if (video.thumbnailUrl) {
      await deleteFromS3(video.thumbnailUrl);
    }

    // Delete from database
    await video.deleteOne();

    res.json({ message: "Video deleted successfully" });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).json({ error: "Failed to delete video" });
  }
});

// Get user videos with pagination
videoRouter.get("/my-videos", authenticateUser, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const [videos, total] = await Promise.all([
      Video.find({ userId: req.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Video.countDocuments({ userId: req.userId })
    ]);

    const formattedVideos = videos.map(video => ({
      id: video._id,
      title: video.title,
      description: video.description,
      thumbnailUrl: video.thumbnailUrl,
      videoUrl: video.videoUrl,
      createdAt: video.createdAt,
      duration: video.duration,
      status: video.status
    }));

    res.json({
      success: true,
      videos: formattedVideos,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error("Error fetching videos:", err);
    res.status(500).json({ 
      error: "Failed to fetch videos",
      details: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
});

// Get single video with detailed information
videoRouter.get("/:videoId", authenticateUser, async (req, res) => {
  try {
    const video = await Video.findById(req.params.videoId).lean();

    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Verify ownership
    if (video.userId.toString() !== req.userId) {
      return res.status(403).json({ error: "Access denied" });
    }

    const response = {
      id: video._id,
      title: video.title,
      description: video.description,
      createdAt: video.createdAt,
      duration: video.duration,
      videoUrl: video.videoUrl,
      thumbnailUrl: video.thumbnailUrl,
      subtitles: video.subtitles,
      status: video.status
    };

    res.json({ success: true, video: response });
  } catch (err) {
    console.error("Error fetching video:", err);
    res.status(500).json({ 
      error: "Failed to fetch video",
      details: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
});

module.exports = videoRouter;