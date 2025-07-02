const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const Video = require("../models/video");
const { promisify } = require("util");
const { exec } = require('child_process');
const execPromise = promisify(exec);
const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);
const { uploadToS3, downloadFromS3, deleteFromS3, getSignedUrl } = require('../utils/s3');

const { extractAudioFromVideo } = require('../utils/extractAudio');
const { transcribeWithWhisper } = require("../utils/transcribeWithWhisper");
const { burnSubtitlesIntoVideo } = require("../utils/burnSubtitles");

const videoRouter = express.Router();

// Configuration
const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB
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

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authorization header missing or invalid" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "Token not provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.type !== "access") {
      return res.status(403).json({ error: "Invalid token type" });
    }

    req.userId = decoded.userId;
    next();
  } catch (err) {
    console.error("Authentication error:", err);
    return res.status(403).json({ 
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

// Upload video with automatic chunking and processing pipeline
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

      // Get video metadata
      const videoTitle = req.body.title || "Untitled Video";
      const videoDescription = req.body.description || "";

      console.log(`\n=== Starting Automatic Video Processing - ${videoTitle} ===`);

      // Create temporary directories for processing
      const tempDir = path.join(__dirname, "..", "temp");
      fs.mkdirSync(tempDir, { recursive: true });

      // Save initial video metadata to database with status 'processing'
      const video = new Video({
        userId: req.userId,
        title: videoTitle,
        baseTitle: videoTitle,
        description: videoDescription,
        videoUrl: null, // Will be updated after processing
        thumbnailUrl: null, // Will be updated after processing
        subtitles: '',
        duration: req.body.duration,
        status: "processing",
        // No chunk metadata needed for automatic processing
        partNumber: 1,
        totalParts: 1,
        isChunked: false,
        chunkId: null
      });
      await video.save();

      // Respond immediately
      res.status(202).json({
        message: "Upload received! Video is being processed in the background.",
        video: {
          id: video._id,
          title: video.title,
          status: video.status
        }
      });

      // Start background processing
      process.nextTick(async () => {
        const bgTempFiles = [videoPath];
        try {
          console.log(`\n=== Starting Optimized Video Processing Pipeline (background) ===`);

          // 1. Get video duration and create optimized chunks
          console.log("\n1. Analyzing video and creating optimized chunks...");
          const chunks = await createOptimizedVideoChunks(videoPath, tempDir);
          console.log(`Created ${chunks.length} optimized chunks`);
          bgTempFiles.push(...chunks.map(chunk => chunk.videoPath));
          bgTempFiles.push(...chunks.map(chunk => chunk.audioPath));

          // 2. Transcribe chunks in parallel (with concurrency limit)
          console.log("\n2. Transcribing audio chunks in parallel...");
          const transcriptions = await transcribeChunksInParallel(chunks, tempDir);
          console.log(`All ${chunks.length} chunks transcribed successfully`);

          // 3. Combine all transcriptions
          console.log("\n3. Combining transcriptions...");
          const combinedSubtitles = combineSubtitles(transcriptions);
          const combinedSrtPath = path.join(tempDir, `combined-${Date.now()}.srt`);
          fs.writeFileSync(combinedSrtPath, combinedSubtitles, 'utf8');
          bgTempFiles.push(combinedSrtPath);
          console.log("Transcriptions combined successfully");

          // 4. Burn combined subtitles into original video
          console.log("\n4. Burning subtitles into video...");
          const finalVideoPath = await burnSubtitlesIntoVideo(videoPath, combinedSrtPath, tempDir);
          console.log("Final video created at:", finalVideoPath);
          bgTempFiles.push(finalVideoPath);

          // 5. Upload final video to S3
          console.log("\n5. Uploading final video to S3...");
          const videoS3Url = await uploadToS3({ 
            path: finalVideoPath, 
            originalname: videoFile.originalname,
            mimetype: videoFile.mimetype 
          }, 'videos');

          let thumbnailS3Url = null;
          if (req.files?.thumbnail) {
            thumbnailS3Url = await uploadToS3(req.files.thumbnail[0], 'thumbnails');
          }

          // 6. Update video metadata in database
          video.videoUrl = videoS3Url;
          video.thumbnailUrl = thumbnailS3Url;
          video.subtitles = combinedSubtitles;
          video.status = "processed";
          await video.save();

          // Clean up temporary files
          await cleanupFiles(bgTempFiles);

          console.log(`✅ Video processing complete for video ID: ${video._id}`);
          console.log(`Final video with subtitles: ${videoS3Url}`);

        } catch (error) {
          console.error("Background processing error:", error);
          video.status = "failed";
          await video.save();
          await cleanupFiles(bgTempFiles);
        }
      });
    } catch (error) {
      console.error("Upload error:", error);
      await cleanupFiles(tempFiles);
      res.status(500).json({ 
        error: "Video upload failed", 
        details: error.message 
      });
    }
  }
);

// Optimized helper function to create video chunks
async function createOptimizedVideoChunks(videoPath, outputDir) {
  const chunks = [];
  const chunkDuration = 60; // Increased to 60 seconds for better efficiency
  const maxConcurrentChunks = 4; // Process 4 chunks in parallel
  
  try {
    // Get video duration using ffprobe
    const { stdout } = await execPromise(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`);
    const totalDuration = parseFloat(stdout);
    
    console.log(`Total video duration: ${totalDuration} seconds`);
    
    // Create chunk tasks
    const chunkTasks = [];
    for (let startTime = 0; startTime < totalDuration; startTime += chunkDuration) {
      const chunkIndex = Math.floor(startTime / chunkDuration) + 1;
      const endTime = Math.min(startTime + chunkDuration, totalDuration);
      
      chunkTasks.push({
        index: chunkIndex,
        startTime: startTime,
        endTime: endTime,
        duration: endTime - startTime
      });
    }
    
    console.log(`Creating ${chunkTasks.length} chunks of ${chunkDuration}s each...`);
    
    // Process chunks in parallel with concurrency limit
    const processChunk = async (task) => {
      const chunkVideoPath = path.join(outputDir, `chunk-${task.index}.mp4`);
      const chunkAudioPath = path.join(outputDir, `chunk-${task.index}.wav`);
      
      // Extract video chunk with optimized ffmpeg settings
      await execPromise(`ffmpeg -i "${videoPath}" -ss ${task.startTime} -t ${task.duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${chunkVideoPath}"`);
      
      // Extract optimized audio from chunk
      await execPromise(`ffmpeg -i "${chunkVideoPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${chunkAudioPath}"`);
      
      return {
        index: task.index,
        startTime: task.startTime,
        endTime: task.endTime,
        videoPath: chunkVideoPath,
        audioPath: chunkAudioPath
      };
    };
    
    // Process chunks with concurrency limit
    for (let i = 0; i < chunkTasks.length; i += maxConcurrentChunks) {
      const batch = chunkTasks.slice(i, i + maxConcurrentChunks);
      const batchResults = await Promise.all(batch.map(processChunk));
      chunks.push(...batchResults);
      
      console.log(`Created chunks ${i + 1}-${Math.min(i + maxConcurrentChunks, chunkTasks.length)} of ${chunkTasks.length}`);
    }
    
    return chunks.sort((a, b) => a.index - b.index);
  } catch (error) {
    console.error("Error creating optimized video chunks:", error);
    throw new Error(`Failed to create optimized video chunks: ${error.message}`);
  }
}

// Optimized parallel transcription function
async function transcribeChunksInParallel(chunks, tempDir) {
  const transcriptions = new Array(chunks.length);
  const maxConcurrentTranscriptions = 3; // Limit concurrent Whisper processes
  
  console.log(`Starting parallel transcription of ${chunks.length} chunks with max ${maxConcurrentTranscriptions} concurrent processes...`);
  
  const transcribeChunk = async (chunk, index) => {
    try {
      console.log(`Starting transcription of chunk ${chunk.index}/${chunks.length}...`);
      
      const srtPath = await transcribeWithWhisper(chunk.audioPath, tempDir);
      const subtitleText = await readFile(srtPath, "utf8");
      
      // Adjust timestamps for this chunk
      const adjustedSubtitles = adjustSubtitlesTiming(subtitleText, chunk.startTime);
      
      console.log(`✅ Chunk ${chunk.index} transcribed successfully`);
      return adjustedSubtitles;
    } catch (error) {
      console.error(`❌ Transcription failed for chunk ${chunk.index}:`, error);
      throw new Error(`Transcription failed for chunk ${chunk.index}: ${error.message}`);
    }
  };
  
  // Process chunks in batches with concurrency limit
  for (let i = 0; i < chunks.length; i += maxConcurrentTranscriptions) {
    const batch = chunks.slice(i, i + maxConcurrentTranscriptions);
    const batchPromises = batch.map((chunk, batchIndex) => 
      transcribeChunk(chunk, i + batchIndex)
    );
    
    const batchResults = await Promise.all(batchPromises);
    
    // Store results in correct order
    batch.forEach((chunk, batchIndex) => {
      transcriptions[i + batchIndex] = batchResults[batchIndex];
    });
    
    console.log(`Completed transcription batch ${Math.floor(i / maxConcurrentTranscriptions) + 1}/${Math.ceil(chunks.length / maxConcurrentTranscriptions)}`);
  }
  
  return transcriptions;
}

// Helper function to adjust subtitle timings
function adjustSubtitlesTiming(srtContent, offsetSeconds) {
  const lines = srtContent.split('\n');
  const adjustedLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if this line contains a timestamp
    const timestampMatch = line.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    
    if (timestampMatch) {
      // Parse timestamps
      const startHours = parseInt(timestampMatch[1]);
      const startMinutes = parseInt(timestampMatch[2]);
      const startSeconds = parseInt(timestampMatch[3]);
      const startMs = parseInt(timestampMatch[4]);
      
      const endHours = parseInt(timestampMatch[5]);
      const endMinutes = parseInt(timestampMatch[6]);
      const endSeconds = parseInt(timestampMatch[7]);
      const endMs = parseInt(timestampMatch[8]);
      
      // Convert to total seconds
      const startTotalSeconds = startHours * 3600 + startMinutes * 60 + startSeconds + startMs / 1000;
      const endTotalSeconds = endHours * 3600 + endMinutes * 60 + endSeconds + endMs / 1000;
      
      // Add offset
      const newStartTotalSeconds = startTotalSeconds + offsetSeconds;
      const newEndTotalSeconds = endTotalSeconds + offsetSeconds;
      
      // Convert back to timestamp format
      const newStartHours = Math.floor(newStartTotalSeconds / 3600);
      const newStartMinutes = Math.floor((newStartTotalSeconds % 3600) / 60);
      const newStartSeconds = Math.floor(newStartTotalSeconds % 60);
      const newStartMs = Math.floor((newStartTotalSeconds % 1) * 1000);
      
      const newEndHours = Math.floor(newEndTotalSeconds / 3600);
      const newEndMinutes = Math.floor((newEndTotalSeconds % 3600) / 60);
      const newEndSeconds = Math.floor(newEndTotalSeconds % 60);
      const newEndMs = Math.floor((newEndTotalSeconds % 1) * 1000);
      
      // Format new timestamp line
      const newTimestampLine = `${String(newStartHours).padStart(2, '0')}:${String(newStartMinutes).padStart(2, '0')}:${String(newStartSeconds).padStart(2, '0')},${String(newStartMs).padStart(3, '0')} --> ${String(newEndHours).padStart(2, '0')}:${String(newEndMinutes).padStart(2, '0')}:${String(newEndSeconds).padStart(2, '0')},${String(newEndMs).padStart(3, '0')}`;
      
      adjustedLines.push(newTimestampLine);
    } else {
      adjustedLines.push(line);
    }
  }
  
  return adjustedLines.join('\n');
}

// Helper function to combine multiple subtitle files
function combineSubtitles(transcriptions) {
  let combinedSrt = '';
  let subtitleIndex = 1;
  
  for (const transcription of transcriptions) {
    const lines = transcription.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.match(/^\d+$/)) {
        // Subtitle index line - replace with new index
        combinedSrt += subtitleIndex + '\n';
        subtitleIndex++;
      } else if (line.match(/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/)) {
        // Timestamp line - keep as is
        combinedSrt += line + '\n';
      } else if (line.length > 0) {
        // Subtitle text line - keep as is
        combinedSrt += line + '\n';
      } else {
        // Empty line - keep as is
        combinedSrt += '\n';
      }
    }
  }
  
  return combinedSrt.trim();
}

// Get video stream
videoRouter.get("/:videoId/stream", authenticateUser, async (req, res) => {
  try {
    const video = await Video.findById(req.params.videoId);
    if (!video) {
      return res.status(404).json({ error: "Video not found" });
    }

    // Return the direct S3 URL instead of a signed URL
    res.json({ streamUrl: video.videoUrl });
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
      videoUrl: video.videoUrl, // Direct S3 URL
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
      videoUrl: video.videoUrl, // Direct S3 URL
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

// Get chunked video status and all parts
videoRouter.get("/chunked/:baseTitle", authenticateUser, async (req, res) => {
  try {
    const baseTitle = req.params.baseTitle;
    
    // Find all chunks for this video
    const chunks = await Video.find({
      userId: req.userId,
      title: { $regex: new RegExp(`^${baseTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') },
      isChunked: true
    }).sort({ partNumber: 1 });

    if (chunks.length === 0) {
      return res.status(404).json({ error: "No chunked video found with this title" });
    }

    const totalParts = chunks[0].totalParts;
    const processedChunks = chunks.filter(chunk => chunk.status === "processed");
    const failedChunks = chunks.filter(chunk => chunk.status === "failed");
    const processingChunks = chunks.filter(chunk => chunk.status === "processing");

    const response = {
      baseTitle: baseTitle,
      totalParts: totalParts,
      processedParts: processedChunks.length,
      failedParts: failedChunks.length,
      processingParts: processingChunks.length,
      allChunksProcessed: chunks.every(chunk => chunk.allChunksProcessed),
      chunks: chunks.map(chunk => ({
        id: chunk._id,
        partNumber: chunk.partNumber,
        title: chunk.title,
        status: chunk.status,
        videoUrl: chunk.videoUrl, // Direct S3 URL
        duration: chunk.duration,
        createdAt: chunk.createdAt
      })),
      overallStatus: chunks.every(chunk => chunk.status === "processed") ? "complete" :
                   chunks.every(chunk => chunk.status === "failed") ? "failed" : "processing"
    };

    res.json({ success: true, video: response });
  } catch (err) {
    console.error("Error fetching chunked video:", err);
    res.status(500).json({ 
      error: "Failed to fetch chunked video",
      details: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
});

// Get all chunked videos for a user
videoRouter.get("/chunked", authenticateUser, async (req, res) => {
  try {
    const chunkedVideos = await Video.find({
      userId: req.userId,
      isChunked: true
    }).sort({ createdAt: -1 });

    // Group by base title
    const groupedVideos = {};
    chunkedVideos.forEach(video => {
      const baseTitle = video.title.replace(/\s*-\s*Part\s*\d+$/, '');
      if (!groupedVideos[baseTitle]) {
        groupedVideos[baseTitle] = {
          baseTitle: baseTitle,
          totalParts: video.totalParts,
          chunks: [],
          processedParts: 0,
          failedParts: 0,
          processingParts: 0
        };
      }
      
      groupedVideos[baseTitle].chunks.push({
        id: video._id,
        partNumber: video.partNumber,
        title: video.title,
        status: video.status,
        videoUrl: video.videoUrl, // Direct S3 URL
        duration: video.duration,
        createdAt: video.createdAt
      });

      if (video.status === "processed") groupedVideos[baseTitle].processedParts++;
      else if (video.status === "failed") groupedVideos[baseTitle].failedParts++;
      else groupedVideos[baseTitle].processingParts++;
    });

    const response = Object.values(groupedVideos).map(group => ({
      ...group,
      overallStatus: group.processedParts === group.totalParts ? "complete" :
                   group.failedParts === group.totalParts ? "failed" : "processing"
    }));

    res.json({ success: true, chunkedVideos: response });
  } catch (err) {
    console.error("Error fetching chunked videos:", err);
    res.status(500).json({ 
      error: "Failed to fetch chunked videos",
      details: process.env.NODE_ENV === "development" ? err.message : undefined
    });
  }
});

module.exports = videoRouter;