const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const ffmpegPath = require("ffmpeg-static");

const burnSubtitlesIntoVideo = (videoPath, srtPath, outputDir) => {
    return new Promise((resolve, reject) => {
        // Validate input files
        if (!fs.existsSync(videoPath)) {
            return reject(new Error(`Video file not found: ${videoPath}`));
        }
        if (!fs.existsSync(srtPath)) {
            return reject(new Error(`Subtitle file not found: ${srtPath}`));
        }

        // Ensure output directory exists
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const baseName = path.basename(videoPath, path.extname(videoPath));
        const videoExt = path.extname(videoPath).toLowerCase();

        const processVideo = async () => {
            if (videoExt === '.webm') {
                console.log('Converting webm to mp4...');
                const mp4Path = path.join(outputDir, `${baseName}-temp.mp4`);

                return new Promise((resolveConvert, rejectConvert) => {
                    const ffmpeg = spawn(ffmpegPath, [
                        '-i', videoPath,
                        '-c:v', 'libx264',
                        '-preset', 'fast',
                        '-c:a', 'aac',
                        '-y',
                        mp4Path
                    ]);

                    let stderr = '';
                    ffmpeg.stderr.on('data', (data) => {
                        stderr += data.toString();
                        console.log(data.toString().trim());
                    });

                    ffmpeg.on('close', (code) => {
                        if (code !== 0) {
                            console.error('FFmpeg stderr:', stderr);
                            return rejectConvert(new Error(`WebM to MP4 conversion failed with code ${code}`));
                        }
                        resolveConvert(mp4Path);
                    });

                    ffmpeg.on('error', (err) => {
                        rejectConvert(new Error(`WebM to MP4 conversion failed: ${err.message}`));
                    });
                });
            }
            return videoPath;
        };

        processVideo()
            .then((processedVideoPath) => {
                const outputVideoPath = path.join(outputDir, `${baseName}-subtitled.mp4`);

                const tempDir = path.join(outputDir, 'temp');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir, { recursive: true });
                }

                const tempSrtPath = path.join(tempDir, 'temp.srt');
                fs.copyFileSync(srtPath, tempSrtPath);

                // Ensure SRT file is UTF-8 without BOM
                const content = fs.readFileSync(tempSrtPath, 'utf8');
                fs.writeFileSync(tempSrtPath, content, { encoding: 'utf8' });

                const normalizedVideoPath = processedVideoPath.replace(/\\/g, '/');
                const normalizedSrtPath = tempSrtPath.replace(/\\/g, '/');
                const normalizedOutputPath = outputVideoPath.replace(/\\/g, '/');

               const subtitleFilter = `subtitles='${normalizedSrtPath.replace(/:/g, '\\:').replace(/'/g, "\\'")}:force_style=FontName=Arial,FontSize=24,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,Outline=2,BorderStyle=3'`;


                const ffmpegArgs = [
                    '-i', normalizedVideoPath,
                    '-vf', subtitleFilter,
                    '-c:v', 'libx264',
                    '-preset', 'fast',
                    '-crf', '23',
                    '-c:a', 'copy',
                    '-movflags', '+faststart',
                    '-y',
                    normalizedOutputPath
                ];

                console.log(`\n🎬 FFmpeg path: ${ffmpegPath}`);
                console.log(`📁 Input: ${normalizedVideoPath}`);
                console.log(`📝 Subtitles: ${normalizedSrtPath}`);
                console.log(`📤 Output: ${normalizedOutputPath}`);
                console.log(`🔧 FFmpeg Args:\n${ffmpegArgs.join(" ")}\n`);

                const ffmpeg = spawn(ffmpegPath, ffmpegArgs, { windowsHide: true });

                let stderr = "";
                ffmpeg.stderr.on("data", (data) => {
                    const msg = data.toString();
                    stderr += msg;
                    console.log(msg.trim()); // ✅ print all stderr for debugging
                });

                ffmpeg.on("error", (err) => {
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    } catch (_) {}
                    reject(new Error(`FFmpeg execution failed: ${err.message}`));
                });

                ffmpeg.on("close", (code) => {
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    } catch (_) {}

                    if (videoExt === '.webm' && processedVideoPath !== videoPath) {
                        try {
                            fs.unlinkSync(processedVideoPath);
                        } catch (err) {
                            console.warn('Temp MP4 cleanup failed:', err.message);
                        }
                    }

                    if (code !== 0) {
                        console.error("❌ FFmpeg exited with code:", code);
                        console.error("📄 FFmpeg stderr:\n", stderr);
                        return reject(new Error(`FFmpeg exited with code ${code}`));
                    }

                    if (!fs.existsSync(outputVideoPath)) {
                        return reject(new Error("Output subtitled video was not created"));
                    }

                    console.log("✅ Subtitled video created at:", outputVideoPath);
                    resolve(outputVideoPath);
                });
            })
            .catch(reject);
    });
};

module.exports = { burnSubtitlesIntoVideo };
