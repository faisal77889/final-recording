const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const path = require("path");
const fs = require("fs");

// Point fluent-ffmpeg to the static binary
ffmpeg.setFfmpegPath(ffmpegPath);

function extractAudioFromVideo(videoPath, outputDir) {
  return new Promise((resolve, reject) => {
    // Validate input video exists
    if (!fs.existsSync(videoPath)) {
      return reject(new Error(`Video file not found: ${videoPath}`));
    }

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = Date.now();
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const audioPath = path.join(outputDir, `${baseName}-${timestamp}.wav`);

    ffmpeg(videoPath)
      .audioChannels(1)              // Mono audio (Whisper optimal)
      .audioFrequency(16000)         // 16kHz sampling rate
      .audioCodec("pcm_s16le")       // PCM 16-bit
      .format("wav")
      .output(audioPath)
      .on("start", (cmd) => {
        console.log(`Extracting audio with command: ${cmd}`);
      })
      .on("end", () => {
        console.log(`Audio extraction finished: ${audioPath}`);
        resolve(audioPath);
      })
      .on("error", (err) => {
        console.error("Error extracting audio:", err);
        reject(new Error(`Audio extraction failed: ${err.message}`));
      })
      .run();
  });
}

module.exports = { extractAudioFromVideo };
