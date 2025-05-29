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
app.use(express.json());

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
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

