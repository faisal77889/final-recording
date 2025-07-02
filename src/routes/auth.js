const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/user");
const validateSignUp = require("../middleware/validateSignUp");

const authRouter = express.Router();

// In-memory store for refresh tokens (use DB or Redis in production)
const refreshTokens = new Set();

// Helper functions to generate tokens
const generateAccessToken = (userId) => {
  return jwt.sign(
    { userId, type: "access" },
    process.env.JWT_SECRET,
    { expiresIn: "1d" }
  );
};

const generateRefreshToken = (userId) => {
  const token = jwt.sign(
    { userId, type: "refresh" },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "30d" }
  );
  refreshTokens.add(token);
  return token;
};

// Signup Route
authRouter.post("/signup", async (req, res) => {
  try {
    const data = validateSignUp(req.body, true);
    const { name, emailId, password } = data;

    const existingUser = await User.findOne({ emailId });
    if (existingUser) {
      return res.status(400).send({ error: "Email already in use" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({
      name,
      emailId,
      password: passwordHash,
    });

    await user.save();

    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    res.status(201).send({
      message: "User created successfully",
      accessToken,
      refreshToken,
    });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Login Route
authRouter.post("/login", async (req, res) => {
  try {
    const data = validateSignUp(req.body, false);
    const { emailId, password } = data;

    const user = await User.findOne({ emailId });
    if (!user) {
      return res.status(400).send({ error: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).send({ error: "Invalid email or password" });
    }

    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    res.status(200).send({
      message: "Login successful",
      accessToken,
      refreshToken,
    });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Token Refresh Route
authRouter.post("/token", (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken || !refreshTokens.has(refreshToken)) {
    return res.status(403).send({ error: "Refresh token is invalid or expired" });
  }

  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    if (decoded.type !== "refresh") {
      return res.status(403).send({ error: "Invalid token type" });
    }

    const newAccessToken = generateAccessToken(decoded.userId);
    res.status(200).send({ accessToken: newAccessToken });
  } catch (err) {
    return res.status(403).send({ error: "Invalid or expired refresh token" });
  }
});

// Logout Route
authRouter.post("/logout", (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    refreshTokens.delete(refreshToken);
  }
  res.status(200).send({ message: "Logged out successfully" });
});

module.exports = authRouter;
