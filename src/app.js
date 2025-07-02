const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/database");
const path = require("path");
const fs = require("fs");

const authRouter = require("./routes/auth");
const videoRouter = require("./routes/videoRouter");

// Load environment variables
dotenv.config();

// Create necessary directories
const tempDir = path.join(__dirname, "temp");
fs.mkdirSync(tempDir, { recursive: true });

// Clean up temp directory on startup
fs.readdir(tempDir, (err, files) => {
    if (err) throw err;
    for (const file of files) {
        fs.unlink(path.join(tempDir, file), err => {
            if (err) console.error(`Error deleting ${file}:`, err);
        });
    }
});

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Increase body size limit for large file uploads (1GB)
app.use(express.json({ limit: '1gb' }));
app.use(express.urlencoded({ limit: '1gb', extended: true }));

// Increase timeout for large uploads
app.use((req, res, next) => {
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000); // 5 minutes
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  // Handle specific file size errors
  if (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(413).json({ 
      error: "File too large", 
      details: "Maximum file size is 1GB. Please try a smaller file.",
      maxSize: "1GB"
    });
  }
  
  // Handle multer errors
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ 
        error: "File too large", 
        details: "Maximum file size is 1GB. Please try a smaller file.",
        maxSize: "1GB"
      });
    }
    return res.status(400).json({ error: err.message });
  }
  
  // Handle other errors
  res.status(500).json({ 
    error: "Something broke!", 
    details: process.env.NODE_ENV === 'development' ? err.message : undefined 
  });
});

// Mount routers
app.use("/api/auth", authRouter);
app.use("/api/videos", videoRouter);

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Start server
connectDB()
    .then(() => {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Server running on http://0.0.0.0:${PORT}`);
        });
    })
    .catch((err) => {
        console.error("Database connection failed:", err.message);
        process.exit(1);
    });

