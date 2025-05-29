const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const User = require("../models/user");
const validateSignUp = require("../middleware/validateSignUp");

const authRouter = express.Router();

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

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    res.status(201).send({ message: "User created successfully", token });
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

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    res.status(200).send({ message: "Login successful", token });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

module.exports = authRouter;
