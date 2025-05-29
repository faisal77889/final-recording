const fs = require("fs");
const path = require("path");
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function transcribeWithWhisper(audioPath, outputDir) {
  console.log("Starting transcription process...");
  console.log("Audio path:", audioPath);
  console.log("Output directory:", outputDir);

  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const baseName = path.basename(audioPath, path.extname(audioPath));
  const outputFile = path.join(outputDir, `${baseName}.srt`);
  
  try {
    // Convert audio to 16kHz WAV format if needed (better for Whisper)
    const tempAudioPath = path.join(outputDir, `${baseName}_temp.wav`);
    console.log("Converting audio to 16kHz WAV...");
    console.log("Temp audio path:", tempAudioPath);
    
    await execPromise(`ffmpeg -i "${audioPath}" -ar 16000 -ac 1 "${tempAudioPath}"`);
    
    // Run Whisper transcription with explicit language and format settings
    console.log("Running Whisper transcription...");
    const whisperCommand = `whisper "${tempAudioPath}" --model base --language en --output_dir "${outputDir}" --output_format srt`;
    console.log("Whisper command:", whisperCommand);
    
    const { stdout, stderr } = await execPromise(whisperCommand);
    console.log("Whisper stdout:", stdout);
    if (stderr) console.error("Whisper stderr:", stderr);
    
    // Clean up temporary file
    if (fs.existsSync(tempAudioPath)) {
      fs.unlinkSync(tempAudioPath);
      console.log("Cleaned up temp audio file");
    }

    // Check for possible output file names
    const possibleOutputFiles = [
      path.join(outputDir, `${baseName}_temp.en.srt`),
      path.join(outputDir, `${baseName}_temp.srt`),
      path.join(outputDir, `${path.basename(tempAudioPath, '.wav')}.srt`),
      path.join(outputDir, `${path.basename(tempAudioPath, '.wav')}.en.srt`)
    ];

    console.log("Checking possible output files:", possibleOutputFiles);

    let whisperOutput = null;
    for (const file of possibleOutputFiles) {
      if (fs.existsSync(file)) {
        whisperOutput = file;
        console.log("Found Whisper output at:", whisperOutput);
        break;
      }
    }

    // If no output file is found but we have transcription in stdout, create the SRT file
    if (!whisperOutput && stdout) {
      console.log("No output file found, but transcription exists in stdout. Creating SRT file...");
      // Convert the plain text to SRT format
      const srtContent = formatTranscriptionToSRT(stdout);
      fs.writeFileSync(outputFile, srtContent, 'utf8');
      console.log("Created SRT file from stdout");
      return outputFile;
    }

    if (!whisperOutput) {
      throw new Error("No transcription output file found and no transcription in stdout");
    }

    // Rename to final output file
    fs.renameSync(whisperOutput, outputFile);
    console.log("Renamed output file to:", outputFile);
    
    // Verify the final output exists
    if (!fs.existsSync(outputFile)) {
      throw new Error(`Final output file not created: ${outputFile}`);
    }
    
    console.log("Transcription completed successfully");
    return outputFile;
  } catch (error) {
    console.error('Error in Whisper transcription:', error);
    console.error('Command output:', error.stdout);
    console.error('Command stderr:', error.stderr);
    throw new Error(`Transcription failed: ${error.message}`);
  }
}

// Helper function to format plain text transcription to SRT format
function formatTranscriptionToSRT(text) {
  // Remove timestamps if they exist in square brackets
  const cleanText = text.replace(/\[\d+:\d+\.\d+ --> \d+:\d+\.\d+\]/g, '').trim();
  
  // Create a simple SRT entry with the entire text
  return `1
00:00:00,000 --> 00:30:000
${cleanText}
`;
}

module.exports = { transcribeWithWhisper };